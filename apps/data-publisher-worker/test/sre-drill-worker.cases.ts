/**
 * Spec 027 "Dev fault-injection drill", Worker rows: the arm and cancel route, the Prod guard, the
 * `throw` and `skip` faults in the `kip-pages` job, the manual tick, expiry and errors, and the
 * end-to-end budget (SRE75, [measure]). Run by sre-drill-worker.test.ts with fakes only: a recording
 * bucket, a fake Analytics Engine, a scripted mock model; no network. The core rows (blindness,
 * grader) are packages/sre-agent/test/drill.cases.ts.
 */
export const testPlanRows = [
  { id: "SRE67", case: "arm", given: "SRE_DRILL on, development, token, {job: kip-pages, kind: throw}", expected: "201 {drillId throw-<YYYYMMDDTHHmmZ>, job, kind, runs 2, armedAt, expiresAt +48 h}; drill record (armed) and pointer written" },
  { id: "SRE67", case: "arm refused", given: "no token / job digest / kind slow / a drill already active / SRE_DRILL unset / a playbook library without the expected cause", expected: "401 / 400 / 400 / 409 drill-active / 404 / 409 playbook-missing-cause; nothing written" },
  { id: "SRE67", case: "cancel", given: "DELETE /sre-agent/drill while armed; again with no drill", expected: "200; pointer removed; record cancelled; the next run is normal / 409 no-active-drill" },
  { id: "SRE68", case: "Prod guard", given: "PUBLICATION_ENVIRONMENT production or staging, SRE_DRILL on, token; a pointer present in the bucket", expected: "arm and cancel 404; a kip-pages run reads no drill key and runs normally; development with the same pointer applies the fault (positive control)" },
  { id: "SRE68", case: "config", given: "wrangler.production.jsonc / wrangler.development.jsonc", expected: "no SRE_DRILL, SRE_AGENT off / SRE_DRILL on, SRE_AGENT live" },
  { id: "SRE69", case: "throw", given: "throw armed; runs 1, 2 (route), 3", expected: "runs 1-2: 0 upstream requests, run record and point equal to a run whose transport answers a real 503 (except times and runId), one console.error drill:<id> with the runId; record fired with both runIds; pointer kept until graded; run 3 normal" },
  { id: "SRE70", case: "skip", given: "skip armed; the cron tick, then the route", expected: "tick: 0 upstream requests, no run record, no point, one console.warn drill:<id>, record fired; route: normal run" },
  { id: "SRE73", case: "manual tick", given: "POST /sre-agent/run with SRE_AGENT dry and the token / without the token / SRE_AGENT off", expected: "200 with the tick's run record, state.json written / 401 / 404" },
  { id: "SRE74", case: "expiry and errors", given: "a pointer 49 h after arming / the pointer read throws / the drill record write fails on arm", expected: "deleted unapplied, record expired, run normal / run normal with no fault, one drill: log line / 503, no pointer" },
  { id: "SRE75", case: "budget", given: "a throw drill end to end: arm, 2 faulted runs, one live tick with a one-step mock model", expected: "graded pass; Class A 10 + 1 per model call, Class B as counted; 0 upstream requests from the faulted runs; writes only under internal/sre/v1/dev/ and kip-pages' run record; neurons ≤ 1,500; no publication, digest or cost-guard request" },
];
