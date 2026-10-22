/**
 * Spec 027 "Dev fault-injection drill" rows, [pending] until the wiring slice. Worker rows (arm route,
 * Prod guard, faults, manual tick) run in apps/data-publisher-worker; blindness and grader rows run here.
 * Expected causes are provisional until docs/runbooks/sre/job.failures.md and job.missed.md list them.
 */
export const testPlanRows = [
  { id: "SRE67", case: "arm", given: "SRE_DRILL on, development, token, {job: kip-pages, kind: throw}", expected: "201 {drillId, runs 2, armedAt, expiresAt}; drill record and pointer written" },
  { id: "SRE67", case: "arm refused", given: "no token / job digest / kind slow / already armed / SRE_DRILL unset / playbook lacks expected cause", expected: "401 / 400 / 400 / 409 / 404 / 409 with reason" },
  { id: "SRE67", case: "cancel", given: "DELETE /sre-agent/drill while armed", expected: "pointer removed; record cancelled; next run normal" },
  { id: "SRE68", case: "Prod guard", given: "PUBLICATION_ENVIRONMENT production or staging, SRE_DRILL on; pointer present in bucket", expected: "arm and cancel 404; kip-pages run reads no pointer, runs normally" },
  { id: "SRE68", case: "config", given: "wrangler.production.jsonc / wrangler.development.jsonc", expected: "no SRE_DRILL / SRE_DRILL on" },
  { id: "SRE69", case: "throw", given: "throw armed; runs 1, 2, 3", expected: "runs 1-2: 0 upstream requests, record and point equal to a real 503 run (except times, runId), one console.error drill:<id> with runId; run 3 normal; record fired with 2 runIds" },
  { id: "SRE70", case: "skip", given: "skip armed; runs 1, 2", expected: "run 1: 0 upstream requests, no run record, no WAE point, one console.warn drill:<id>; run 2 normal" },
  { id: "SRE71", case: "blind agent", given: "tick diagnosing the throw firing / same firing without a drill", expected: "no 'drill' (any case) or drillId in bundle, prompt, tool results, trajectory; bundles equal except times and runIds" },
  { id: "SRE71", case: "health section refused", given: "get_health_section sreAgent / sreAgent.lastDrill", expected: "refusal result; nothing read" },
  { id: "SRE72", case: "grade pass", given: "throw: cause upstream-unavailable, quotes kipPages.lastRun.error and Q-window, playbook anchor, explained", expected: "pass, reasons []" },
  { id: "SRE72", case: "grade fail", given: "cause unknown / Q-window not quoted / other anchor / verdict unverified", expected: "fail: wrong-cause:unknown / missing-evidence:Q-window / runbook-mismatch:<got> / verdict:unverified" },
  { id: "SRE72", case: "no diagnosis", given: "throw fired, no kip-pages diagnosis 24 h after the last faulted run (skip: 48 h)", expected: "fail: no-diagnosis" },
  { id: "SRE72", case: "drift", given: "drillExpectations vs docs/runbooks/sre/job.failures.md and job.missed.md", expected: "every expected cause and anchor listed, else check fails naming it" },
  { id: "SRE73", case: "manual tick", given: "POST /sre-agent/run with token / without / SRE_AGENT off", expected: "one tick under B31 caps / 401 / 404" },
  { id: "SRE74", case: "expiry and errors", given: "pointer past expiresAt / pointer read throws / drill record write fails on arm", expected: "deleted unapplied, record expired / job runs with no fault, one drill: log line / 503, no pointer" },
];
