/**
 * Spec 027 "Dev fault-injection drill" (B37–B46) in the Worker: the `SRE_DRILL` switch, the arm and
 * cancel route, and the fault in the `kip-pages` job. The drill's record, pointer and grader live in
 * the core (`@oss-knowledge-base/sre-agent`, under `internal/sre/v1/dev/drills/`).
 *
 * Two guards (B39, SRE68): `SRE_DRILL=on` and `PUBLICATION_ENVIRONMENT=development` (an allowlist).
 * Anywhere else the routes answer 404 and the job never reads the pointer. Every log line this code
 * writes starts with `drill:` (B43); nothing here reaches the agent's bundle (B44).
 */
import { armDrill, cancelDrill, isDrillKind, recordFaultedRun, takeDrillFault, DRILL_JOB, type DrillOutcome, type DrillRecord } from "@oss-knowledge-base/sre-agent";
import type { KipPagesHealthV1 } from "@oss-knowledge-base/reference-pipeline/kip-pages";
import { kipPagesRun, type KipPagesEnv, type KipPagesTransport } from "../kip-pages/run";
import { errorText, sanitizeErrorMessage } from "../search-embedding/sanitize";
import { runIdFor } from "../signals/point";
import { drillEnabled, r2Store } from "./run";

export { drillEnabled };

export interface DrillEnv {
  readonly PUBLICATION_ENVIRONMENT?: string;
  /** B38: `on` only in `wrangler.development.jsonc`; unset everywhere else. */
  readonly SRE_DRILL?: string;
  readonly OSS_KB_BUCKET: R2Bucket;
}

/** B40 `throw`: the upstream answers 503 to the run's first request without sending it. */
const unavailable: KipPagesTransport = async () => new Response("Service Unavailable", { status: 503 });

const drillLog = (level: "log" | "warn" | "error", message: string, runId?: string) =>
  console[level]({ message: sanitizeErrorMessage(message), ...(runId === undefined ? {} : { runId }), job: DRILL_JOB });

/**
 * B38: `POST /sre-agent/drill` arms (201), `DELETE` cancels (200). 404 while the drill is off, 401
 * without the token, 400 for another job or kind, 409 for a second drill or a kind whose playbook
 * does not list its expected cause (B41), 503 when the record cannot be written.
 */
export async function drillRoute(request: Request, env: DrillEnv, authorized: boolean): Promise<Response> {
  if (!drillEnabled(env)) return new Response("Not found", { status: 404 });
  if (!authorized) return new Response("Unauthorized", { status: 401 });
  const store = r2Store(env.OSS_KB_BUCKET);
  const now = new Date();
  if (request.method === "DELETE") {
    const outcome = await cancelDrill(store, now).catch((error: unknown): DrillOutcome => {
      drillLog("error", `drill: cancelling failed: ${errorText(error)}`);
      return { status: 503, body: { ok: false, reason: "drill-unreadable" } };
    });
    if (outcome.status === 200) drillLog("log", `drill:${String(outcome.body.drillId)} cancelled`);
    return Response.json(outcome.body, { status: outcome.status });
  }
  const body = await request.json().catch(() => null) as { job?: unknown; kind?: unknown } | null;
  if (body?.job !== DRILL_JOB) return Response.json({ ok: false, reason: "job must be kip-pages" }, { status: 400 });
  if (!isDrillKind(body.kind)) return Response.json({ ok: false, reason: "kind must be throw or skip" }, { status: 400 });
  const outcome = await armDrill(store, { kind: body.kind, now });
  if (outcome.status === 201) drillLog("log", `drill:${String(outcome.body.drillId)} armed: ${body.kind} for ${DRILL_JOB}`);
  return Response.json(outcome.body, { status: outcome.status });
}

/** B39: the drill whose fault applies to this run; none while the drill is off (no read) or on a read error. */
async function faultFor(env: DrillEnv, now: Date): Promise<DrillRecord | null> {
  if (!drillEnabled(env)) return null;
  try {
    return await takeDrillFault(r2Store(env.OSS_KB_BUCKET), now);
  } catch (error) {
    // SRE74: the job runs normally, with no fault.
    drillLog("error", `drill: reading the active drill failed, the run is not faulted: ${errorText(error)}`);
    return null;
  }
}

async function countRun(env: DrillEnv, record: DrillRecord, runId: string | null, now: Date): Promise<void> {
  await recordFaultedRun(r2Store(env.OSS_KB_BUCKET), record, runId, now).catch((error: unknown) => {
    drillLog("error", `drill:${record.drillId} the drill record was not written: ${errorText(error)}`, runId ?? undefined);
  });
}

export type KipPagesJobResult =
  | { readonly skipped: "drill"; readonly health?: undefined }
  | { readonly skipped?: undefined; readonly health: KipPagesHealthV1 };

/**
 * One `kip-pages` run (cron or route) with the drill's fault, if one applies (B39, B40). A dry run
 * never takes a fault. `skip` returns before any request, run record or data point; `throw` runs the
 * job against a transport that answers 503, so its record and point are those of a real outage.
 */
export async function kipPagesJob(env: DrillEnv & KipPagesEnv, dryRun: boolean, deadline?: number): Promise<KipPagesJobResult> {
  const now = new Date();
  const fault = dryRun ? null : await faultFor(env, now);
  if (fault === null) return { health: await kipPagesRun(env, dryRun, deadline) };
  const run = `${fault.applied + 1} of ${fault.runs}`;
  if (fault.kind === "skip") {
    drillLog("warn", `drill:${fault.drillId} run ${run}: skipped, as if the cron had not fired (no request, no run record, no data point)`);
    await countRun(env, fault, null, now);
    return { skipped: "drill" };
  }
  const health = await kipPagesRun(env, false, deadline, unavailable);
  const lastRun = health.lastRun as (KipPagesHealthV1["lastRun"] & { runId?: string }) | null;
  const runId = lastRun === null ? null : lastRun.runId ?? runIdFor(DRILL_JOB, lastRun.at);
  drillLog("error", `drill:${fault.drillId} run ${run}: the upstream answered 503 (injected, not sent)`, runId ?? undefined);
  await countRun(env, fault, runId, now);
  return { health };
}
