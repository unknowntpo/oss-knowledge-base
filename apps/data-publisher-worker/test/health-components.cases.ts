/**
 * Spec 033 SM10 and SM18: the single source for the `/health` `components` status rules (Behavior 7)
 * in `health-components.test.ts` and for the test-plan table in docs/specs/033-system-map/spec.md
 * (`bun run docs:test-plan`).
 *
 * Every row starts from `BASE_HEALTH` (every job on, its last run at 02:00 UTC, read at 12:00 UTC):
 *
 * - `state`: JSON; each top-level key replaces that key of the base body.
 * - `off`: a top-level key removed from the base body (its job's flag unset), or "—".
 * - `status`: the component's expected status, or `absent` when it is not listed.
 * - `reason`: text the entry's reason contains, or "—" for no reason.
 */
export const NOW = "2026-10-26T12:00:00.000Z";
const AT = "2026-10-26T02:00:00.000Z";

const sources = { github: { ok: true, lastSuccessAt: AT }, mail: { ok: true, lastSuccessAt: AT }, jira: { ok: true, lastSuccessAt: AT } };
const lastRunJob = (status = "ok") => ({ lastRun: { ok: true, status, at: AT, durationMs: 1000 } });

/** Dev's shape (2026-10-26), every job on and ok. */
export const BASE_HEALTH: Readonly<Record<string, unknown>> = {
  environment: "development",
  lastRun: { ok: true, completedAt: AT, sources },
  sources,
  digest: { enabled: true, lastRun: { ok: true, completedAt: AT } },
  searchEmbedding: { enabled: true, lastRun: { ok: true, pending: 0, completedAt: AT } },
  costGuard: { mode: "monitor", status: "ok", reason: null, checkedAt: AT },
  identityLinks: lastRunJob(),
  kipPages: lastRunJob(),
  identityBackfill: lastRunJob(),
  retention: { mode: "dry-run", status: "ok", reason: null, lastRun: { runId: "retention-2026-10-26", at: AT, mode: "dry-run", status: "ok", reason: null, error: null } },
  sreAgent: { mode: "live", status: "ok", reason: null, lastRun: { runId: "sre-agent-1", at: AT, status: "ok", verdicts: [] } },
};

export const testPlanRows = [
  { id: "SM10", component: "every id", state: "{}", off: "—", status: "ok", reason: "—", why: "every job on and run 10 h ago: one ok entry per job and per source" },
  { id: "SM10", component: "publication", state: `{"lastRun":{"ok":false,"completedAt":"${AT}","error":"github: GitHub answered 503"}}`, off: "—", status: "failed", reason: "GitHub answered 503", why: "the last run failed" },
  { id: "SM10", component: "publication", state: `{"lastRun":{"ok":true,"completedAt":"2026-10-25T11:00:00.000Z"}}`, off: "—", status: "warn", reason: "no run for 25.0 h", why: "late: past job.missed warn (24.5 h)" },
  { id: "SM10", component: "publication", state: `{"lastRun":{"ok":true,"completedAt":"2026-10-25T08:00:00.000Z"}}`, off: "—", status: "stale", reason: "no run for 28.0 h", why: "no run within the cadence plus the job.missed grace (27 h)" },
  { id: "SM10", component: "source:jira", state: `{"lastRun":{"ok":true,"completedAt":"${AT}","sources":{"jira":{"ok":false,"lastSuccessAt":"2026-10-25T22:00:00.000Z","error":"Jira answered 429"}}}}`, off: "—", status: "failed", reason: "Jira answered 429", why: "the source failed in the last run" },
  { id: "SM10", component: "source:mail", state: `{"lastRun":{"ok":true,"completedAt":"${AT}","sources":{"mail":{"ok":true,"lastSuccessAt":"2026-10-25T06:00:00.000Z"}}}}`, off: "—", status: "stale", reason: "no success for 30.0 h", why: "no success within the daily limit" },
  { id: "SM10", component: "source:github", state: `{"lastRun":{"ok":true,"completedAt":"${AT}","sources":{}}}`, off: "—", status: "unknown", reason: "no record of this source", why: "the run has no record of the source" },
  { id: "SM10", component: "digest", state: `{"digest":{"enabled":true,"lastRun":{"ok":false,"completedAt":"${AT}","error":"model unavailable"}}}`, off: "—", status: "failed", reason: "model unavailable", why: "the last run failed" },
  { id: "SM10", component: "digest", state: `{"digest":{"enabled":false,"lastRun":null}}`, off: "—", status: "absent", reason: "—", why: "off (DIGEST_ENABLED unset): not listed" },
  { id: "SM10", component: "embedding", state: `{"searchEmbedding":{"enabled":true,"lastRun":{"ok":true,"pending":40,"completedAt":"2026-10-26T08:00:00.000Z"}}}`, off: "—", status: "stale", reason: "no run for 4.0 h", why: "chunks pending and no run within its 3 h limit" },
  { id: "SM10", component: "embedding", state: `{"searchEmbedding":{"enabled":true,"lastRun":{"ok":true,"pending":0,"completedAt":"2026-10-24T08:00:00.000Z"}}}`, off: "—", status: "ok", reason: "—", why: "nothing pending: no run is due" },
  { id: "SM10", component: "cost-guard", state: `{"costGuard":{"mode":"monitor","status":"tripped","reason":null,"checkedAt":"${AT}","metrics":{"r2ClassA":{"percent":207.81,"status":"tripped"},"r2ClassB":{"percent":4.05,"status":"ok"}}}}`, off: "—", status: "warn", reason: "tripped: r2ClassA 207.81%", why: "a tripped guard is degraded, not failed" },
  { id: "SM10", component: "cost-guard", state: "{}", off: "costGuard", status: "absent", reason: "—", why: "off (COST_GUARD unset): not listed" },
  { id: "SM10", component: "identity-links", state: `{"identityLinks":{"lastRun":{"ok":false,"status":"failed","at":"${AT}","durationMs":10,"error":"roster read failed"}}}`, off: "—", status: "failed", reason: "roster read failed", why: "the last run failed" },
  { id: "SM10", component: "identity-backfill", state: `{"identityBackfill":{"lastRun":{"ok":true,"status":"complete","at":"2026-10-20T01:23:00.000Z","durationMs":10}}}`, off: "—", status: "ok", reason: "—", why: "a finished backfill is not due again" },
  { id: "SM10", component: "identity-backfill", state: "{}", off: "identityBackfill", status: "absent", reason: "—", why: "off (IDENTITY_BACKFILL unset): not listed" },
  { id: "SM10", component: "retention", state: `{"retention":{"mode":"dry-run","status":"failed","reason":null,"lastRun":{"at":"${AT}","mode":"dry-run","status":"failed","reason":null,"error":"listing failed"}}}`, off: "—", status: "failed", reason: "listing failed", why: "the last run failed" },
  { id: "SM10", component: "retention", state: `{"retention":{"mode":"dry-run","status":"ok","reason":"evidence-missing","lastRun":{"at":"${AT}","mode":"dry-run","status":"ok","reason":"evidence-missing","error":null}}}`, off: "—", status: "warn", reason: "evidence-missing", why: "a dry run with errors" },
  { id: "SM10", component: "retention", state: `{"retention":{"mode":"dry-run","status":"overrun","reason":null,"lastRun":{"at":"${AT}","mode":"dry-run","status":"overrun","reason":null,"error":null}}}`, off: "—", status: "warn", reason: "overrun", why: "a dry run that ran out of time" },
  { id: "SM10", component: "sre-agent", state: `{"sreAgent":{"mode":"live","status":"ok","lastRun":{"at":"${AT}","status":"ok","verdicts":["explained","inconclusive"]}}}`, off: "—", status: "warn", reason: "inconclusive", why: "a diagnosis the agent could not decide" },
  { id: "SM10", component: "sre-agent", state: `{"sreAgent":{"mode":"live","status":"failed","reason":"model call failed","lastRun":{"at":"${AT}","status":"failed","reason":"model call failed"}}}`, off: "—", status: "failed", reason: "model call failed", why: "the last tick failed" },
  { id: "SM10", component: "sre-agent", state: `{"sreAgent":{"mode":"off"}}`, off: "—", status: "absent", reason: "—", why: "off (SRE_AGENT unset or off): not listed" },
  { id: "SM10", component: "kip-pages", state: `{"kipPages":{"revision":"authors@1","lastRun":null}}`, off: "—", status: "unknown", reason: "no run yet", why: "on, before the first run" },
  { id: "SM18", component: "kip-pages", state: `{"kipPages":null}`, off: "—", status: "unknown", reason: "could not be read", why: "last-run.json unreadable" },
  { id: "SM18", component: "digest", state: `{"digest":null}`, off: "—", status: "unknown", reason: "did not answer", why: "the digest object did not answer while DIGEST_ENABLED is on" },
  { id: "SM18", component: "cost-guard", state: `{"costGuard":null}`, off: "—", status: "unknown", reason: "did not answer", why: "the cost guard object did not answer" },
  { id: "SM18", component: "sre-agent", state: `{"sreAgent":{"mode":"live","status":"unknown","reason":"reading state.json failed: boom","lastRun":null}}`, off: "—", status: "unknown", reason: "reading state.json failed", why: "state.json unreadable" },
  { id: "SM18", component: "publication", state: `{"lastRun":"garbage","sources":42}`, off: "—", status: "unknown", reason: "no run yet", why: "a record of the wrong type counts as missing" },
  { id: "SM18", component: "identity-links", state: `{"identityLinks":{"lastRun":{"ok":true,"status":"ok","at":"not a date"}}}`, off: "—", status: "unknown", reason: "no run yet", why: "an unreadable time is not a run" },
] as const;
