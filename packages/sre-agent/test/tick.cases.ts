/**
 * Spec 027 Amendment (2) L1 cases: the deterministic tick before and after the model (no model, no
 * network), run by tick.test.ts. Every boundary named in B25–B35 has a case on each side. The row
 * that needs the Worker's scheduled handler (SRE47) is in worker.cases.ts, [pending] until the
 * wiring slice.
 */
export const testPlanRows = [
  { id: "SRE37", case: "flag", given: "SRE_AGENT unset, off, \"Live\" / dry / live", expected: "off, off, off with reason invalid-flag (0 reads, 0 writes) / steps 0-4 and 7, 0 model calls / all steps" },
  { id: "SRE38", case: "firing collected", given: "signals.rules[] entry status firing", expected: "1 firing with env, job, ruleId, since, runId" },
  { id: "SRE38", case: "warn or unknown", given: "entries warn and unknown only", expected: "0 firings, 0 model calls" },
  { id: "SRE38", case: "cost guard", given: "costGuard.status tripped / warn", expected: "1 firing, since = breaker.trippedAt / 0 firings" },
  { id: "SRE38", case: "signals absent", given: "/health without signals, costGuard ok", expected: "signals unavailable, 0 firings from rules" },
  { id: "SRE39", case: "ci.release per env", given: "Dev: newest main run failure; Prod: newest v* tag run failure / success", expected: "1 ci.release firing in that env only / none" },
  { id: "SRE39", case: "GitHub unavailable", given: "HTTP 403 rate limit, 500, or 20 s timeout", expected: "ci.release unknown, recorded, no firing; GET only, no Authorization header" },
  { id: "SRE39", case: "Prod newest tag", given: "Prod: tags v0.10.0, v0.2.9, v0.9.0 as the refs API lists them (alphabetical), each tag's run found by branch however many pushes followed / only a non-version tag vscode-test / newest tag with 0 runs", expected: "the v0.10.0 run (branch=v0.10.0) / unknown, no tag / unknown, no run" },
  { id: "SRE40", case: "dedupe", given: "fingerprint in state.json, same runId / new runId twice in one UTC day / rule ok then firing", expected: "no diagnosis / 1 diagnosis that day / new since, new fingerprint" },
  { id: "SRE41", case: "daily diagnosis cap", given: "firings of 5 jobs in one tick; second tick same UTC day", expected: "3 diagnosed, 2 notDiagnosed daily-cap; 0 diagnosed" },
  { id: "SRE41", case: "neuron cap boundary", given: "today.neurons 1,000 and next reservation 500 / 501", expected: "step runs / diagnosis stops inconclusive budget" },
  { id: "SRE41", case: "crash after reservation", given: "state written with reservation, model call throws, process ends", expected: "next tick counts the reservation in today.neurons" },
  { id: "SRE41", case: "new UTC day", given: "state.json of 2026-10-21 at the caps (3 diagnoses, 1,500 neurons); a tick on 2026-10-22 with a new firing", expected: "today resets to 2026-10-22; the firing is diagnosed" },
  { id: "SRE42", case: "no new firing", given: "0 firings / 1 new firing", expected: "run record healthy, modelCalls 0 / 1 diagnosis" },
  { id: "SRE42", case: "group by job", given: "job.missed and publication.freshness firing for publication", expected: "1 bundle, 1 diagnosis, 2 fingerprints recorded" },
  { id: "SRE43", case: "bundle per job", given: "a firing for each job of A2", expected: "exactly A2's /health fields, firing entries, costGuard, Q-run and Q-history (Q-window for cost guard, job.failures), playbook and its runbook sections, ids E1..En" },
  { id: "SRE43", case: "bundle size boundary", given: "items totalling 24 KB / 24 KB + 1 byte", expected: "unchanged / head and tail kept with a truncation marker" },
  { id: "SRE43", case: "secret in input", given: "a /health error text containing a Worker secret value", expected: "value redacted in bundle, prompt and trajectory" },
  { id: "SRE43", case: "tool results", given: "tool results holding a Worker secret twice and a Bearer token; a tool error naming the secret; a 20 KB tool result", expected: "every occurrence redacted in prompt and trajectory, Bearer [redacted]; the 20 KB result capped at 16 KB with a truncation marker" },
  { id: "SRE44", case: "verbatim quote", given: "quote equal to text of cited item (whitespace collapsed)", expected: "check passes, verdict kept" },
  { id: "SRE44", case: "fabricated or misplaced quote", given: "quote absent from cited item / present only in another item / unknown id / empty or blank quote", expected: "verdict unverified, failure listed" },
  { id: "SRE44", case: "compact JSON quote", given: "quote verbatim from the cited JSON item's compact serialization (JSON.stringify, no whitespace) / a paraphrase of it / compact JSON of another item / a non-JSON item", expected: "passes (owner 2026-10-25) / unverified / unverified / only its text form counts" },
  { id: "SRE44", case: "cause and runbook", given: "cause not in playbook / runbook anchor not in playbook / cause unknown", expected: "unverified / unverified / passes" },
  { id: "SRE45", case: "output schema", given: "record with every field / missing evidence / confidence \"sure\"", expected: "accepted / rejected / rejected" },
  { id: "SRE46", case: "write scope", given: "keys internal/sre/v1/dev/runs/x.json / internal/sre/v1/prod/x / public/v2/current.json / identity-links last-run.json / public/x/internal/sre/v1/dev/y / a .. segment", expected: "written / refused before any R2 call (5 cases)" },
  { id: "SRE46", case: "forbidden requests", given: "any path of a tick, dry and live", expected: "no request to /run, /*/run, /cost-guard/*, no non-GET, no fetch to the other env's host" },
  { id: "SRE48", case: "playbook format", given: "docs/runbooks/sre/*.md missing a section / cause without anchor / anchor not in docs/runbooks", expected: "check fails naming the file" },
  { id: "SRE48", case: "playbook missing", given: "firing rule with no playbook file", expected: "diagnosed with playbookMissing true; only cause unknown passes" },
  { id: "SRE46", case: "delete scope", given: "scopedStore(dev).delete of internal/sre/v1/prod/... / public/v2/current.json / identity last-run.json / public/x/internal/sre/v1/dev/y / a .. segment; then a Dev drill pointer", expected: "WriteScopeError for each, no raw delete, raw objects unchanged / deleted" },
  { id: "SRE49", case: "scope v1", given: "firing job.duration / job.r2ClassA", expected: "notDiagnosed out-of-scope / diagnosed (type 3)" },
];
