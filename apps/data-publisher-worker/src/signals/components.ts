/**
 * Spec 033 Behavior 7: `/health` `components`, one status per job and per publication source that the
 * environment runs, for the docs site's system map. Pure: it judges the body `/health` already built
 * (no read of its own, SM20) and does not depend on `OBSERVABILITY_SIGNALS`. Ages come from Spec 028's
 * state rules (`job.missed`) and thresholds; a record that is missing or of the wrong type is `unknown`.
 */
import { PUBLICATION_SOURCES, SIGNAL_THRESHOLDS as T, type ComponentId, type SignalJob } from "./profile";
import { stateRules, type RuleEntry } from "./rules";

export type ComponentStatus = "ok" | "warn" | "failed" | "stale" | "unknown";

export interface HealthComponent {
  readonly id: ComponentId;
  readonly status: ComponentStatus;
  /** When the state it was judged from was recorded (the last run, check or success); null when none is. */
  readonly at: string | null;
  readonly reason?: string;
}

type Record_ = Readonly<Record<string, unknown>>;
const object = (value: unknown): Record_ | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record_ : undefined);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);
const validTime = (value: unknown): string | null => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null);
const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;

const entry = (id: ComponentId, status: ComponentStatus, at: string | null, reason?: string): HealthComponent =>
  ({ id, status, at, ...(reason === undefined ? {} : { reason }) });

/**
 * One component from its facts, worst first: unknown (no state), failed, stale (`job.missed` firing),
 * warn (a degraded state, or `job.missed` warn), unknown (`job.missed` cannot judge), ok.
 */
type Age = Pick<RuleEntry, "status" | "value" | "reason">;

function judge(id: ComponentId, at: string | null, facts: { readonly missing?: string | undefined; readonly failed?: string | undefined; readonly degraded?: string | undefined; readonly missed?: Age | undefined }): HealthComponent {
  const { missing, failed, degraded, missed } = facts;
  if (missing !== undefined) return entry(id, "unknown", at, missing);
  if (failed !== undefined) return entry(id, "failed", at, failed);
  if (missed?.status === "firing") return entry(id, "stale", at, `no run for ${hours(missed.value ?? 0)}`);
  if (degraded !== undefined) return entry(id, "warn", at, degraded);
  if (missed?.status === "warn") return entry(id, "warn", at, `late: no run for ${hours(missed.value ?? 0)}`);
  if (missed?.status === "unknown") return entry(id, "unknown", at, missed.reason ?? "no run yet");
  return entry(id, "ok", at);
}

/** An age against the daily limits of `job.missed` (Spec 028 D4), for the states it has no rule for. */
function dailyAge(at: string | null, now: number): Age {
  if (at === null) return { status: "unknown", value: null, reason: "no run yet" };
  const age = now - Date.parse(at);
  return { status: age > T.dailyFiringMs ? "firing" : age > T.dailyWarnMs ? "warn" : "ok", value: age };
}

/** The flags `/health` cannot see in a body whose object did not answer (`digest: null`, `searchEmbedding: null`). */
export interface ComponentFlags {
  readonly digest: boolean;
  readonly embedding: boolean;
}

/** Behavior 7: `/health` `components`, from the served body (with `sreAgent`) at `now`. */
export function healthComponents(health: Record_, now: number, flags: ComponentFlags): HealthComponent[] {
  const missedOf = new Map<SignalJob, RuleEntry>();
  for (const rule of stateRules(health, now).rules) if (rule.id === "job.missed") missedOf.set(rule.job, rule);
  const components: HealthComponent[] = [];
  const failure = (run: Record_) => (run.ok === false || run.status === "failed" ? text(run.error) ?? text(run.reason) ?? `the last run failed (${text(run.status) ?? "ok: false"})` : undefined);

  const lastRun = object(health.lastRun);
  const completedAt = validTime(lastRun?.completedAt);
  components.push(judge("publication", completedAt, { ...(lastRun === undefined ? { missing: "no run yet" } : { failed: failure(lastRun) }), missed: missedOf.get("publication") }));
  for (const name of PUBLICATION_SOURCES) {
    const id = `source:${name}` as const;
    const source = object(object(lastRun?.sources)?.[name]);
    if (lastRun === undefined || source === undefined) {
      components.push(entry(id, "unknown", completedAt, lastRun === undefined ? "no run yet" : "the last run has no record of this source"));
      continue;
    }
    if (source.ok === false) {
      components.push(entry(id, "failed", completedAt, text(source.error) ?? "the source failed in the last run"));
      continue;
    }
    const success = validTime(source.lastSuccessAt);
    const age = dailyAge(success, now);
    components.push(age.status === "firing" ? entry(id, "stale", success, `no success for ${hours(age.value!)}`)
      : age.status === "warn" ? entry(id, "warn", success, `late: no success for ${hours(age.value!)}`)
        : age.status === "unknown" ? entry(id, "unknown", success, "no successful run recorded")
          : entry(id, "ok", success));
  }

  // The digest and the embedding job: listed while enabled, or while their object does not answer and the flag is on.
  for (const [key, id, on] of [["digest", "digest", flags.digest], ["searchEmbedding", "embedding", flags.embedding]] as const) {
    const state = object(health[key]);
    if (state === undefined ? !on || health[key] !== null : state.enabled !== true) continue;
    const run = object(state?.lastRun);
    components.push(judge(id, validTime(run?.completedAt), {
      ...(state === undefined ? { missing: `the ${id} object did not answer` } : run === undefined ? { missing: "no run yet" } : { failed: failure(run) }),
      missed: missedOf.get(id),
    }));
  }

  if ("costGuard" in health) {
    const guard = object(health.costGuard);
    const status = text(guard?.status);
    const tripped = Object.entries(object(guard?.metrics) ?? {})
      .filter(([, metric]) => object(metric)?.status === status)
      .map(([name, metric]) => `${name} ${object(metric)?.percent ?? "?"}%`);
    const degraded = status === "tripped" || status === "warn" ? `${status}: ${tripped.join(", ") || "see costGuard"}`
      : status === "unconfigured" ? `unconfigured: ${text(guard?.reason) ?? "see costGuard"}` : undefined;
    components.push(judge("cost-guard", validTime(guard?.checkedAt), {
      missing: guard === undefined ? "the cost guard did not answer" : undefined, degraded, missed: missedOf.get("cost-guard"),
    }));
  }

  // Jobs whose record is `last-run.json` (retention: its object's status): present only while their flag is set.
  for (const [key, id] of [["identityLinks", "identity-links"], ["kipPages", "kip-pages"], ["identityBackfill", "identity-backfill"], ["retention", "retention"]] as const) {
    if (!(key in health)) continue;
    const state = object(health[key]);
    const run = object(state?.lastRun);
    const degraded = id !== "retention" ? undefined
      : state?.status === "unconfigured" ? `unconfigured: ${text(state.reason) ?? "see retention"}`
        : run?.status === "overrun" ? "overrun: the dry run ran out of time" : text(run?.reason);
    components.push(judge(id, validTime(run?.at), {
      missing: state === undefined ? "no record: no run yet, or it could not be read" : run === undefined && degraded === undefined ? "no run yet" : undefined,
      failed: run === undefined ? undefined : failure(run), degraded, missed: missedOf.get(id),
    }));
  }

  // Spec 027: the SRE agent is not a Spec 028 job; its age is judged against the same daily limits.
  const agent = object(health.sreAgent);
  if (agent !== undefined && agent.mode !== "off") {
    const run = object(agent.lastRun);
    const at = validTime(run?.at);
    const verdicts = Array.isArray(run?.verdicts) ? run.verdicts : [];
    components.push(judge("sre-agent", at, {
      ...(agent.status === "unknown" ? { missing: text(agent.reason) ?? "its state could not be read" } : run === undefined ? { missing: "no run yet" } : { failed: failure(run) }),
      degraded: verdicts.includes("inconclusive") ? "a diagnosis was inconclusive" : undefined,
      missed: dailyAge(at, now),
    }));
  }
  return components;
}
