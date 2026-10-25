/**
 * Spec 027 "Dev fault-injection drill", core rows: the agent's blindness to a drill (SRE71) and the
 * grader with its drift check (SRE72). Run by drill.test.ts with a scripted mock model, an in-memory
 * store and Dev's /health fixture; no network. The Worker rows (arm route, Prod guard, faults, manual
 * tick, expiry, budget) are apps/data-publisher-worker/test/sre-drill-worker.cases.ts.
 */
export const testPlanRows = [
  { id: "SRE71", case: "blind agent", given: "a live tick diagnosing kip-pages job.failures while a drill is fired, the model asking get_health_section for sreAgent and sreAgent.lastDrill / the same firing without a drill", expected: "no 'drill' (any case) or drillId in bundle, prompt, tool results, trajectory or run record, except the path the model typed; no bundled playbook or runbook section mentions a drill; bundles equal" },
  { id: "SRE71", case: "health section refused", given: "get_health_section sreAgent / sreAgent.lastDrill / kipPages.lastRun (control)", expected: "refusal result and sreAgent never read / refusal / the field as served" },
  { id: "SRE72", case: "grade pass", given: "throw fired; the tick's diagnosis: cause upstream-unavailable, quotes kipPages.lastRun.error and cites Q-window, playbook anchor, explained", expected: "record graded pass, reasons []; pointer deleted; state.json lastDrill the summary" },
  { id: "SRE72", case: "grade fail", given: "cause unknown / Q-window not cited / runbook roll-back / a quote not in its item (unverified)", expected: "fail: wrong-cause:unknown / missing-evidence:Q-window / runbook-mismatch:cloudflare-data-publisher.md#roll-back / verdict:unverified" },
  { id: "SRE72", case: "no diagnosis", given: "throw fired 23 h / 25 h before a tick with no kip-pages diagnosis; skip fired 47 h / 49 h before", expected: "nothing graded, pointer kept / fail no-diagnosis; same for skip at 48 h" },
  { id: "SRE72", case: "failure before the drill", given: "throw fired; the tick diagnoses kip-pages job.failures whose since (21:00) is before armedAt (21:10)", expected: "nothing graded: record stays fired, result null; pointer kept" },
  { id: "SRE72", case: "failure at arming", given: "throw fired; the tick diagnoses kip-pages job.failures whose since equals armedAt (21:00)", expected: "graded pass: a failure at the arming instant is the drill's" },
  { id: "SRE72", case: "drift", given: "drillExpectations vs the bundled job.failures and job.missed playbooks / a library without the cause, the anchor or the playbook", expected: "no error / an error naming the missing cause, anchor or playbook" },
];
