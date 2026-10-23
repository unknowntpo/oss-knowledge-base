/**
 * One `sre-agent` tick (B26), steps 0–7, as a library: every input is injected (store, `/health`,
 * GitHub fetch, Analytics SQL, model), so the Worker wiring (A2-9 slice 2) only binds them. Errors
 * propagate; the Worker's branch catches them (B23, SRE47).
 */
import type { LanguageModel } from "ai";
import { buildBundle, type Bundle } from "./bundle";
import type { EvidenceCheck } from "./evidence";
import { CI_JOB, collectFirings, parseFlag, readCiRelease } from "./firings";
import { diagnoseBundle, renderPrompt, SYSTEM_PROMPT, type Diagnosis } from "./loop";
import type { PlaybookLibrary } from "./playbook";
import { PLAYBOOK_LIBRARY } from "./playbooks.generated";
import { NeuronLedger, fingerprint, loadState, planDiagnoses, utcDate, type NotDiagnosedReason, type SreState } from "./state";
import { scopedStore, sreKey } from "./store";
import type { CiRelease, Env, Firing, Health, Mode, QuerySignals, RawStore } from "./types";

/** Workers AI price above the free allocation: $0.011 per 1,000 neurons (A2-6). */
export const USD_PER_NEURON = 0.011 / 1000;

export interface TickDeps {
  readonly env: Env;
  /** `SRE_AGENT` as configured (B25). */
  readonly flag: string | undefined;
  readonly now: Date;
  readonly store: RawStore;
  readonly readHealth: () => Promise<Health>;
  /** Used only for the public GitHub API (`ci.release`, `get_ci_run`). */
  readonly fetch: typeof fetch;
  readonly querySignals: QuerySignals;
  /** Required for `live`; the Worker builds it from the `AI` binding. */
  readonly model?: Exclude<LanguageModel, string>;
  readonly modelId: string;
  /** Values of the Worker's secrets, redacted from every bundle item and tool result (B29). */
  readonly secrets?: readonly string[];
  readonly library?: PlaybookLibrary;
  readonly toolTimeoutMs?: number;
  readonly ciTimeoutMs?: number;
}

export interface DiagnosisRecord {
  readonly fingerprints: string[];
  readonly env: Env;
  readonly job: string;
  readonly ruleIds: string[];
  readonly since: string;
  readonly runId: string | null;
  readonly verdict: Diagnosis["verdict"];
  readonly reason: Diagnosis["reason"];
  readonly cause: string | null;
  readonly confidence: string | null;
  readonly evidence: { id: string; quote: string }[];
  readonly runbook: string | null;
  readonly ownerAction: string | null;
  readonly playbookMissing: boolean;
  readonly evidenceCheck: EvidenceCheck | null;
  readonly model: string;
  readonly modelCalls: number;
  readonly steps: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly neurons: number;
  readonly costUsd: number;
  readonly at: string;
  readonly trajectoryKey: string;
}

export interface RunRecord {
  readonly runId: string;
  readonly env: Env;
  readonly mode: Exclude<Mode, "off">;
  readonly at: string;
  readonly verdict: "healthy" | "firing";
  readonly signals: "available" | "unavailable";
  readonly ci: { status: CiRelease["status"]; reason?: string };
  readonly firings: number;
  readonly diagnosed: number;
  readonly notDiagnosed: { fingerprint: string; reason: NotDiagnosedReason }[];
  readonly duplicates: string[];
  readonly modelCalls: number;
  readonly neurons: number;
  readonly diagnoses: DiagnosisRecord[];
  readonly recordKey: string;
}

export interface TickResult {
  readonly mode: Mode;
  readonly reason?: "invalid-flag";
  readonly runRecord?: RunRecord;
}

function dryRun(bundle: Bundle): Diagnosis {
  return {
    verdict: "dry-run", reason: null, output: null, evidenceCheck: null, modelCalls: 0, steps: 0, toolCalls: 0,
    inputTokens: 0, outputTokens: 0, neurons: 0, trajectory: { system: SYSTEM_PROMPT, prompt: renderPrompt(bundle), steps: [] },
  };
}

export async function runTick(deps: TickDeps): Promise<TickResult> {
  // Step 0: the flag first; `off` touches nothing.
  const flag = parseFlag(deps.flag);
  if (flag.mode === "off") return flag;
  const mode = flag.mode;
  if (mode === "live" && deps.model === undefined) throw new Error("SRE_AGENT=live needs a model");
  const { env } = deps;
  const at = deps.now.toISOString();
  const date = utcDate(deps.now);
  const runId = `sre-agent-${at.replace(/[:.]/gu, "-")}`;
  const store = scopedStore(env, deps.store);
  const stateKey = sreKey(env, "state.json");
  const state: SreState = loadState(await store.get(stateKey), date);
  const persist = (value: SreState) => store.put(stateKey, JSON.stringify(value));
  const ledger = new NeuronLedger(state, persist);
  const secrets = deps.secrets ?? [];
  const library = deps.library ?? PLAYBOOK_LIBRARY;

  // Steps 1–2: firings of this environment, then dedupe and caps.
  const health = await deps.readHealth();
  const ci = await readCiRelease(env, deps.fetch, deps.ciTimeoutMs === undefined ? {} : { timeoutMs: deps.ciTimeoutMs });
  const { firings, signals } = collectFirings(env, health, ci);
  const plan = planDiagnoses(firings, state, date);

  // Steps 4–6 per job (step 3, no new firing, is the empty loop).
  const diagnoses: DiagnosisRecord[] = [];
  for (const group of plan.groups) {
    const bundle = await buildBundle({ env, job: group.job, firings: group.firings, health, querySignals: deps.querySignals, ci, library, secrets });
    state.today.diagnoses += 1;
    const diagnosis = mode === "dry" ? dryRun(bundle) : await diagnoseBundle({
      model: deps.model!, modelId: deps.modelId, bundle, ledger,
      tools: { env, health, querySignals: deps.querySignals, fetch: deps.fetch, library, secrets, ciRuns: group.job === CI_JOB },
      ...(deps.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: deps.toolTimeoutMs }),
    });
    const trajectoryKey = sreKey(env, `trajectories/${date}/${runId}-${group.job}.json`);
    await store.put(trajectoryKey, JSON.stringify({
      runId, job: group.job, bundle: bundle.items, ...diagnosis.trajectory,
      output: diagnosis.output, evidenceCheck: diagnosis.evidenceCheck, verdict: diagnosis.verdict, reason: diagnosis.reason,
    }));
    for (const firing of group.firings) state.fingerprints[fingerprint(firing)] = { runId: firing.runId, diagnosedOn: date };
    diagnoses.push(record(env, group.firings, bundle, diagnosis, deps.modelId, at, trajectoryKey));
  }

  // Step 7: the run record, then state.json (B33).
  const recordKey = sreKey(env, `runs/${date}/${runId}.json`);
  const runRecord: RunRecord = {
    runId, env, mode, at,
    verdict: plan.groups.length === 0 && plan.notDiagnosed.length === 0 ? "healthy" : "firing",
    signals,
    ci: { status: ci.status, ...(ci.reason === undefined ? {} : { reason: ci.reason }) },
    firings: firings.length,
    diagnosed: diagnoses.length,
    notDiagnosed: plan.notDiagnosed,
    duplicates: plan.duplicates,
    modelCalls: diagnoses.reduce((total, value) => total + value.modelCalls, 0),
    neurons: diagnoses.reduce((total, value) => total + value.neurons, 0),
    diagnoses,
    recordKey,
  };
  await store.put(recordKey, JSON.stringify(runRecord));
  state.lastRun = {
    runId, at, firings: runRecord.firings, diagnosed: runRecord.diagnosed, notDiagnosed: runRecord.notDiagnosed.length,
    modelCalls: runRecord.modelCalls, neurons: runRecord.neurons, verdicts: diagnoses.map((value) => value.verdict), recordKey,
  };
  await persist(state);
  return { mode, runRecord };
}

function record(env: Env, firings: readonly Firing[], bundle: Bundle, diagnosis: Diagnosis, model: string, at: string, trajectoryKey: string): DiagnosisRecord {
  const output = diagnosis.output;
  return {
    fingerprints: firings.map(fingerprint),
    env,
    job: bundle.job,
    ruleIds: firings.map((firing) => firing.ruleId),
    since: firings.map((firing) => firing.since).sort()[0]!,
    runId: firings.find((firing) => firing.runId !== null)?.runId ?? null,
    verdict: diagnosis.verdict,
    reason: diagnosis.reason,
    cause: output?.cause ?? null,
    confidence: output?.confidence ?? null,
    evidence: output?.evidence ?? [],
    runbook: output?.runbook ?? null,
    ownerAction: output?.ownerAction ?? null,
    playbookMissing: bundle.playbookMissing.length > 0,
    evidenceCheck: diagnosis.evidenceCheck,
    model,
    modelCalls: diagnosis.modelCalls,
    steps: diagnosis.steps,
    toolCalls: diagnosis.toolCalls,
    inputTokens: diagnosis.inputTokens,
    outputTokens: diagnosis.outputTokens,
    neurons: diagnosis.neurons,
    costUsd: diagnosis.neurons * USD_PER_NEURON,
    at,
    trajectoryKey,
  };
}
