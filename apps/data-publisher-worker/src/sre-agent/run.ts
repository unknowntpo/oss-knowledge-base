/**
 * Spec 027 Amendment (2), A2-9 slice 2: the `sre-agent` job's wiring. The core (`packages/sre-agent`)
 * does the tick; this module binds it to the Worker: the flag, the R2 store, `/health` as served, the
 * Analytics SQL templates, the model from the `AI` binding, the WAE point and the log line. One job,
 * one responsibility (B23): its own cron, its own prefix, its own `/health.sreAgent`; it never throws
 * into the scheduled handler.
 */
import * as ai from "ai";
import * as workers from "cloudflare:workers";
import { createAI } from "agents/models/ai-sdk";
import { wrapAISDK } from "agents/observability/ai";
import {
  activeDrillSummary, DAILY_NEURON_CAP, gradeActiveDrill, loadState, parseFlag, recordFailedTick, runTick, sreKey, sreRunId, utcDate,
  type Env as SreEnv, type Health, type LastRun, type Mode, type TickDeps, type QuerySignals, type RawStore, type RunRecord, type SqlArgs,
} from "@oss-knowledge-base/sre-agent";
import { errorText, sanitizeErrorMessage } from "../search-embedding/sanitize";
import { signalsDataset } from "../signals/profile";
import type { AnalyticsSql, SignalsSink } from "../signals/recorder";

export const SRE_AGENT_JOB = "sre-agent";

export interface SreAgentEnv {
  readonly PUBLICATION_ENVIRONMENT: "development" | "production";
  /** B25: `off` (also unset or any other value), `dry` or `live`. */
  readonly SRE_AGENT?: string;
  /** A2-3: the job's cron expressions, separated by `;` (Dev `30 0 * * *;0 11 * * *`). */
  readonly SRE_AGENT_CRON?: string;
  /** B30: the Workers AI model id for `live` (A2-1, owner decision 2026-10-25: Qwen3 30B on Dev). */
  readonly SRE_AGENT_MODEL?: string;
  /** G100: the AI Gateway id the agent's model calls go through (Dev `osskb-sre-dev`); unset uses the account default. */
  readonly SRE_AGENT_GATEWAY?: string;
  /** Spec 027 drill (B38): `on` only on Dev; see `drill.ts`. */
  readonly SRE_DRILL?: string;
  readonly AI?: unknown;
  readonly OSS_KB_BUCKET: R2Bucket;
  readonly OBSERVABILITY_SIGNALS?: string;
  readonly SIGNALS?: SignalsSink;
  readonly ANALYTICS_SQL?: AnalyticsSql;
  readonly GITHUB_SOURCE_TOKEN?: string;
  readonly MANUAL_TRIGGER_TOKEN?: string;
  readonly CF_ANALYTICS_TOKEN?: string;
}

/** Spec 027 drill (B38, B39): `SRE_DRILL=on` and `PUBLICATION_ENVIRONMENT=development` (an allowlist). */
export const drillEnabled = (env: { readonly SRE_DRILL?: string; readonly PUBLICATION_ENVIRONMENT?: string }) =>
  (env.SRE_DRILL?.trim() ?? "") === "on" && env.PUBLICATION_ENVIRONMENT === "development";

export const sreEnv = (environment: "development" | "production"): SreEnv => (environment === "production" ? "prod" : "dev");

/** A2-3: a tick belongs to the job when its cron is one of `SRE_AGENT_CRON`'s expressions, whatever the flag. */
export function sreAgentCron(cron: string, configured: string | undefined): boolean {
  return (configured ?? "").split(";").map((value) => value.trim()).filter((value) => value !== "").includes(cron);
}

/** SRE57: the core takes a `LanguageModel`; the Worker builds it in one line from the `AI` binding. */
export function sreAgentModel(env: Pick<SreAgentEnv, "AI" | "SRE_AGENT_MODEL" | "SRE_AGENT_GATEWAY">) {
  const modelId = env.SRE_AGENT_MODEL?.trim() ?? "";
  if (env.AI === undefined || modelId === "") return undefined;
  // G100 (owner decision 2026-10-25): Dev routes the agent's calls through its own AI Gateway; unset keeps the account default.
  const gateway = env.SRE_AGENT_GATEWAY?.trim() ?? "";
  return createAI(gateway === "" ? { binding: env.AI as Ai } : { binding: env.AI as Ai, gateway: { id: gateway } }).languageModel(modelId);
}

/** The core's only path to R2; `scopedStore` inside the core refuses any key outside the prefix (B33). */
export function r2Store(bucket: R2Bucket): RawStore {
  return {
    async get(key) {
      const object = await bucket.get(key);
      return object === null ? null : object.text();
    },
    async put(key, body) {
      await bucket.put(key, body, { httpMetadata: { contentType: "application/json" } });
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const COLUMNS = "timestamp, index1 AS runId, blob1 AS job, blob3 AS status, double1 AS ok, double2 AS durationMs, double3 AS classA, double4 AS classB";

/**
 * A2's three templates on this environment's dataset, in Spec 028's column layout (blob1 job,
 * blob3 status, index1 runId, double1–4 ok, durationMs, Class A, Class B). Arguments are bound
 * parameters; nobody writes SQL.
 */
export function signalsQuery(args: SqlArgs, environment: "development" | "production", now: number): { readonly query: string; readonly params: Record<string, string> } {
  const from = `FROM events.analyticsEngine."${signalsDataset(environment)}"`;
  const since = new Date(now - 8 * DAY).toISOString();
  switch (args.template) {
    case "Q-history":
      return { query: `SELECT ${COLUMNS} ${from} WHERE blob1 = $job AND timestamp >= $since ORDER BY timestamp DESC LIMIT 20`, params: { job: args.job, since } };
    case "Q-run":
      return { query: `SELECT * ${from} WHERE index1 = $runId AND timestamp >= $since LIMIT 5`, params: { runId: args.runId, since } };
    case "Q-window": {
      const at = Date.parse(args.at);
      if (Number.isNaN(at)) throw new Error(`Q-window needs a time, got ${args.at}`);
      return {
        query: `SELECT ${COLUMNS} ${from} WHERE timestamp >= $start AND timestamp <= $end ORDER BY timestamp DESC LIMIT 50`,
        params: { start: new Date(at - 12 * HOUR).toISOString(), end: new Date(at + 12 * HOUR).toISOString() },
      };
    }
  }
}

function querySignals(env: SreAgentEnv, now: () => number): QuerySignals {
  return async (args) => {
    if (env.ANALYTICS_SQL === undefined) throw new Error("the ANALYTICS_SQL binding is missing");
    const answer = await env.ANALYTICS_SQL.query(signalsQuery(args, env.PUBLICATION_ENVIRONMENT, now()));
    return answer.data;
  };
}

/** B29: every secret of the Worker's environment, redacted by exact value from each bundle item. */
const secretsOf = (env: SreAgentEnv) =>
  [env.GITHUB_SOURCE_TOKEN, env.MANUAL_TRIGGER_TOKEN, env.CF_ANALYTICS_TOKEN].filter((value): value is string => typeof value === "string" && value !== "");

/**
 * SRE81 (owner decision 2026-10-26): the agent's model calls go through Cloudflare Agent tracing.
 * Without the two store flags the Agents tab's session replay has no payloads; tool results are
 * bundle items, already redacted (B29). Where traces are off (Prod) the wrapper only calls through.
 */
export const tracedGenerateText = wrapAISDK(ai, { storeMessages: true, storeTools: true }).generateText;

/** SRE82: the custom span each tick (not `off`) runs inside. */
export const SRE_TICK_SPAN = "sre-agent tick";
const MAX_FAILURE_IDS = 1024;

type SpanValue = string | number | boolean;

/**
 * SRE82: the tick span's attributes, a pure function of the tick's result. Counts, ids and verdicts
 * only: no secret, no bundle text (the session replay carries content).
 */
export function tickSpanAttributes(input: { readonly env: SreEnv; readonly mode: Exclude<Mode, "off">; readonly result: SreAgentTickResult }): Record<string, SpanValue> {
  const { result } = input;
  const base = { runId: result.runId, env: input.env, mode: input.mode, status: result.status };
  const record = result.runRecord;
  if (record === undefined) return { ...base, ...(result.reason === undefined ? {} : { reason: result.reason }) };
  const diagnoses = record.diagnoses;
  const failures = diagnoses.flatMap((value) => (value.evidenceCheck?.failures ?? []).map((failure) => `${value.job}:${failure}`));
  const sum = (pick: (value: (typeof diagnoses)[number]) => number) => diagnoses.reduce((total, value) => total + pick(value), 0);
  return {
    ...base,
    firings: record.firings,
    diagnosed: record.diagnosed,
    verdicts: diagnoses.map((value) => value.verdict).join(","),
    evidenceCheckFailures: failures.length,
    evidenceCheckFailureIds: failures.join(",").slice(0, MAX_FAILURE_IDS),
    inputTokens: sum((value) => value.inputTokens),
    outputTokens: sum((value) => value.outputTokens),
    neurons: record.neurons,
    ...(result.neuronsToday === undefined ? {} : { neuronsToday: result.neuronsToday }),
    neuronsDailyCap: DAILY_NEURON_CAP,
  };
}

interface TickSpan { setAttribute(key: string, value: SpanValue): unknown }

/**
 * SRE82: `tracing.enterSpan` from `cloudflare:workers`, read off the namespace so a runtime without
 * it links (and runs the tick without a span) instead of failing to load.
 */
function enterTickSpan<T>(run: (span: TickSpan) => Promise<T>): Promise<T> {
  const tracing = (workers as { readonly tracing?: { enterSpan?: unknown } }).tracing;
  if (typeof tracing?.enterSpan !== "function") return run({ setAttribute: () => undefined });
  return (workers.tracing.enterSpan as (name: string, callback: (span: TickSpan) => Promise<T>) => Promise<T>)(SRE_TICK_SPAN, run);
}

export interface SreAgentTickDeps {
  readonly now: Date;
  /** `/health` as served, from the functions the route uses (B24, SRE34). */
  readonly readHealth: () => Promise<Health>;
  readonly fetch?: typeof fetch;
  readonly onStep?: (step: number) => void;
  /** Test seam: a model instead of the one built from the `AI` binding (SRE75 counts calls through a mock). */
  readonly model?: ReturnType<typeof sreAgentModel>;
  /** SRE81: the `generateText` of the tick's diagnoses; `tracedGenerateText` by default. */
  readonly generateText?: typeof ai.generateText;
}

export interface SreAgentTickResult {
  readonly runId: string;
  readonly status: "ok" | "failed";
  readonly reason?: string;
  readonly runRecord?: RunRecord;
  /** SRE82: the day's neurons after an ok tick. */
  readonly neuronsToday?: number;
}

/**
 * One tick of the job (B23). `off` returns before any read, write, query or model call (B25). Any
 * error is caught: `lastRun.status` becomes `failed` with a sanitized reason and the handler goes on.
 */
export async function sreAgentTick(env: SreAgentEnv, deps: SreAgentTickDeps): Promise<SreAgentTickResult | undefined> {
  const flag = parseFlag(env.SRE_AGENT);
  if (flag.mode === "off") return undefined;
  const mode = flag.mode;
  // SRE82: the whole tick, model calls included, inside one span; its attributes once the result is known.
  return enterTickSpan(async (span) => {
    const result = await tick(env, deps, mode);
    for (const [key, value] of Object.entries(tickSpanAttributes({ env: sreEnv(env.PUBLICATION_ENVIRONMENT), mode, result }))) span.setAttribute(key, value);
    return result;
  });
}

async function tick(env: SreAgentEnv, deps: SreAgentTickDeps, mode: Exclude<Mode, "off">): Promise<SreAgentTickResult> {
  const runId = sreRunId(deps.now);
  const started = Date.now();
  const store = r2Store(env.OSS_KB_BUCKET);
  const sre = sreEnv(env.PUBLICATION_ENVIRONMENT);
  let result: SreAgentTickResult;
  try {
    // Inside the try: a binding that fails as the model is built is a failed tick too (SRE47).
    const model = mode === "live" ? deps.model ?? sreAgentModel(env) : undefined;
    const tick = await runTick({
      generateText: deps.generateText ?? tracedGenerateText,
      env: sre,
      flag: env.SRE_AGENT,
      now: deps.now,
      store,
      readHealth: deps.readHealth,
      fetch: deps.fetch ?? fetch,
      querySignals: querySignals(env, () => deps.now.getTime()),
      ...(model === undefined ? {} : { model }),
      modelId: env.SRE_AGENT_MODEL?.trim() ?? "",
      secrets: secretsOf(env),
      ...(deps.onStep === undefined ? {} : { onStep: deps.onStep }),
      // B42: the drill grader, only while the drill is on; its failure never fails the tick.
      ...(drillEnabled(env) ? { afterRun: (input) => gradeDrill(store, input, deps.now, runId) } : {}),
    });
    result = {
      runId, status: "ok",
      ...(tick.runRecord === undefined ? {} : { runRecord: tick.runRecord }),
      ...(tick.neuronsToday === undefined ? {} : { neuronsToday: tick.neuronsToday }),
    };
  } catch (error) {
    const reason = sanitizeErrorMessage(errorText(error));
    result = { runId, status: "failed", reason };
    await recordFailedTick({ env: sre, store, now: deps.now, reason }).catch((recordError: unknown) => {
      console.error({ message: sanitizeErrorMessage(`sre-agent: recording the failed run failed: ${errorText(recordError)}`), runId, job: SRE_AGENT_JOB });
    });
  }
  writePoint(env, result, started, deps.now.getTime());
  const record = result.runRecord;
  const summary = record === undefined
    ? `sre-agent ${mode} run failed: ${result.reason}`
    : `sre-agent ${mode} run: ${record.firings} firings, ${record.diagnosed} diagnosed, ${record.modelCalls} model calls, ${record.recordKey}`;
  (result.status === "ok" ? console.log : console.error)({ message: summary, runId, job: SRE_AGENT_JOB });
  return result;
}

/** B42: grades an active drill after the tick's run record; logs `drill:<drillId>` (B43). */
async function gradeDrill(store: RawStore, input: Parameters<NonNullable<TickDeps["afterRun"]>>[0], now: Date, runId: string) {
  try {
    const summary = await gradeActiveDrill(store, { ...input, now });
    if (summary !== undefined) {
      const message = `drill:${summary.drillId} graded ${summary.result}${summary.reasons.length === 0 ? "" : `: ${summary.reasons.join(", ")}`}`;
      console.log({ message, runId, job: SRE_AGENT_JOB });
    }
    return summary;
  } catch (error) {
    console.error({ message: sanitizeErrorMessage(`drill: grading failed: ${errorText(error)}`), runId, job: SRE_AGENT_JOB });
    return undefined;
  }
}

/**
 * B33: one WAE point per tick while Spec 028's signals are on and `SIGNALS` is bound, in Spec 028's
 * layout (`indexes [runId]`, `blobs [job, env, status, ""]`, doubles ok, durationMs, 0, 0, r2Counted 0,
 * completedAtMs, then c1–c6 = firings, diagnosed, steps, toolCalls, neurons, evidenceCheckFailures).
 */
function writePoint(env: SreAgentEnv, result: SreAgentTickResult, startedMs: number, scheduledMs: number): void {
  if ((env.OBSERVABILITY_SIGNALS?.trim() ?? "") !== "on" || env.SIGNALS === undefined) return;
  const record = result.runRecord;
  const diagnoses = record?.diagnoses ?? [];
  const sum = (pick: (value: (typeof diagnoses)[number]) => number) => diagnoses.reduce((total, value) => total + pick(value), 0);
  const counters = record === undefined ? [0, 0, 0, 0, 0, 0] : [
    record.firings, record.diagnosed, sum((value) => value.steps), sum((value) => value.toolCalls), record.neurons,
    diagnoses.filter((value) => value.evidenceCheck !== null && !value.evidenceCheck.ok).length,
  ];
  const durationMs = Math.max(0, Date.now() - startedMs);
  try {
    env.SIGNALS.writeDataPoint({
      indexes: [result.runId],
      blobs: [SRE_AGENT_JOB, env.PUBLICATION_ENVIRONMENT, result.status, ""],
      doubles: [result.status === "ok" ? 1 : 0, durationMs, 0, 0, 0, scheduledMs + durationMs, ...counters],
    });
  } catch (error) {
    console.error({ message: sanitizeErrorMessage(`sre-agent: writing the data point failed: ${errorText(error)}`), runId: result.runId, job: SRE_AGENT_JOB });
  }
}

/**
 * B25, B33: `/health.sreAgent`. `off` (unset, `off`, or an invalid value with `reason:
 * "invalid-flag"`) reads nothing. Otherwise one R2 read of `state.json`: `{mode, status, reason,
 * lastRun, today}`, with `status` and `reason` from the last run (null before the first one). While
 * the drill is on, `lastDrill` too (the pointer and record of an active drill, else `state.lastDrill`).
 */
export async function sreAgentHealth(env: Pick<SreAgentEnv, "SRE_AGENT" | "SRE_DRILL" | "OSS_KB_BUCKET" | "PUBLICATION_ENVIRONMENT">, now: Date): Promise<Record<string, unknown>> {
  const flag = parseFlag(env.SRE_AGENT);
  if (flag.mode === "off") return flag.reason === undefined ? { mode: "off" } : { mode: "off", reason: flag.reason };
  try {
    const store = r2Store(env.OSS_KB_BUCKET);
    const body = await store.get(sreKey(sreEnv(env.PUBLICATION_ENVIRONMENT), "state.json"));
    const state = loadState(body, utcDate(now));
    const lastRun: LastRun | null = state.lastRun ?? null;
    return {
      mode: flag.mode,
      status: lastRun?.status ?? null,
      reason: lastRun?.status === "failed" ? lastRun.reason : null,
      lastRun,
      today: state.today,
      // B42: the active drill (armed or fired), else the last graded one; only while the drill is on.
      ...(drillEnabled(env) ? { lastDrill: (await activeDrillSummary(store).catch(() => null)) ?? state.lastDrill ?? null } : {}),
    };
  } catch (error) {
    return { mode: flag.mode, status: "unknown", reason: sanitizeErrorMessage(`reading state.json failed: ${errorText(error)}`), lastRun: null, today: null };
  }
}

/**
 * SRE62 (Spec 026 Behavior 4): the agent's neurons today for the cost guard's estimate; 0 without a
 * read while the flag is off, and 0 for a ledger of another UTC day.
 */
export async function sreAgentNeuronsToday(env: Pick<SreAgentEnv, "SRE_AGENT" | "OSS_KB_BUCKET" | "PUBLICATION_ENVIRONMENT">, now: Date): Promise<number> {
  if (parseFlag(env.SRE_AGENT).mode === "off") return 0;
  const body = await r2Store(env.OSS_KB_BUCKET).get(sreKey(sreEnv(env.PUBLICATION_ENVIRONMENT), "state.json"));
  if (body === null) return 0;
  const today = (JSON.parse(body) as { today?: { date?: unknown; neurons?: unknown } }).today;
  return today?.date === utcDate(now) && typeof today.neurons === "number" ? today.neurons : 0;
}
