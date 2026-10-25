/**
 * Spec 027 Amendment (2), A2-9 slice 2: the `sre-agent` job wired into the data publisher Worker
 * (cron branch, flag, `/health.sreAgent`, model from the `AI` binding, WAE point, cost-guard neuron
 * term). Run by sre-agent-worker.test.ts with fakes only: no network, no Cloudflare binding.
 */
export const testPlanRows = [
  { id: "SRE34", case: "health as served", given: "the sre-agent tick's /health on a Worker with signals on and a firing rule", expected: "equal to GET /health without sreAgent, redacted as served; no derived field" },
  { id: "SRE37", case: "flag off in the Worker", given: "SRE_AGENT unset / off / \"Live\"; the sre-agent cron tick, then GET /health", expected: "0 R2 calls, 0 AI calls, no point, no log line; sreAgent {mode: off} / {mode: off} / {mode: off, reason: invalid-flag}" },
  { id: "SRE37", case: "deploy config", given: "wrangler.development.jsonc / wrangler.production.jsonc", expected: "SRE_AGENT live (owner decision 2026-10-25), SRE_AGENT_CRON 30 0 * * *;0 11 * * * in vars and in triggers / SRE_AGENT off, no SRE_AGENT_CRON, no sre-agent trigger" },
  { id: "SRE43", case: "job names", given: "Spec 028 SIGNAL_JOBS of the Worker", expected: "each one is in SRE_JOBS (query_signals' job enum) and JOB_HEALTH_FIELDS; embedding, not search-embedding" },
  { id: "SRE47", case: "isolation", given: "sre-agent branch throws at each step 0-7 on a tick shared with the publication cron", expected: "publication still scheduled; sreAgent lastRun.status failed with sanitized reason" },
  { id: "SRE47", case: "own tick", given: "an SRE_AGENT_CRON expression with the flag off, dry or live; /health unreadable; a state.json read that throws", expected: "cron target sre-agent, never the publisher; the handler resolves; lastRun failed / state.json not replaced, the reason in the log line and /health" },
  { id: "SRE47", case: "model construction throws", given: "SRE_AGENT live; building the model from the AI binding throws on the sre-agent cron tick", expected: "the handler resolves; lastRun.status failed with the sanitized reason; 0 AI calls" },
  { id: "SRE57", case: "model from the binding", given: "SRE_AGENT_MODEL @cf/zai-org/glm-4.7-flash and an AI binding / either missing with SRE_AGENT live", expected: "one binding.run with that model id / no model; the run fails with a reason, 0 AI calls" },
  { id: "SRE62", case: "neuron term", given: "digest, embedding and query ledgers at 5,000, 2,500, 1,000; the agent at 1,500 / the agent off or of another day", expected: "neurons today 10,000 / 8,500 with no state.json read while off" },
  { id: "SRE63", case: "dry tick observability", given: "a dry tick with a publication job.missed firing, signals on, SIGNALS bound", expected: "/health.sreAgent {mode, status, reason, lastRun {runId, at, firings, diagnosed, notDiagnosed, modelCalls, neurons, verdicts, recordKey}, today}; one point job sre-agent with c1-c6; one runId in point, run record, trajectory and log line" },
];
