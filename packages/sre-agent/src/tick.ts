/**
 * One `sre-agent` tick (B26), steps 0–7, as a library: every input is injected (store, `/health`,
 * GitHub fetch, Analytics SQL, model), so the Worker wiring (A2-9 slice 2) only binds them. Errors
 * propagate; the Worker's branch catches them (B23, SRE47).
 */
import type { LanguageModel, generateText } from "ai";
import { buildBundle, type Bundle, type EvidenceItem } from "./bundle";
import type { DrillSummary } from "./drill";
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
  /** SRE80: the `generateText` of every diagnosis (the AI SDK's own by default; the Worker injects the traced one). */
  readonly generateText?: typeof generateText;
  /** Values of the Worker's secrets, redacted from every bundle item and tool result (B29). */
  readonly secrets?: readonly string[];
  readonly library?: PlaybookLibrary;
  readonly toolTimeoutMs?: number;
  readonly ciTimeoutMs?: number;
  /** Called as each step of B26 starts (0–7); a throw ends the tick like any other error (SRE47). */
  readonly onStep?: (step: number) => void;
  /**
   * B42: called after the run record is written and before `state.json`, with the `/health` the tick
   * read and each diagnosed job's final bundle items (tool results included). A summary it returns is
   * stored as `state.lastDrill`. The Worker passes the drill grader here only while the drill is on.
   */
  readonly afterRun?: (input: { readonly runRecord: RunRecord; readonly health: Health; readonly items: ReadonlyMap<string, readonly EvidenceItem[]> }) => Promise<DrillSummary | undefined>;
}

/** B33: the same `runId` in the WAE point, the run record, the trajectories and the log line. */
export const sreRunId = (now: Date) => `sre-agent-${now.toISOString().replace(/[:.]/gu, "-")}`;

/** `state.json`'s `lastRun` (B33), served by `/health.sreAgent`. */
export type LastRun =
  | { readonly runId: string; readonly at: string; readonly status: "ok"; readonly firings: number; readonly diagnosed: number; readonly notDiagnosed: number; readonly modelCalls: number; readonly neurons: number; readonly verdicts: string[]; readonly recordKey: string }
  | { readonly runId: string; readonly at: string; readonly status: "failed"; readonly reason: string };

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
  /** SRE82: `state.json`'s `today.neurons` after the run (the tick span's `neuronsToday`). */
  readonly neuronsToday?: number;
}

function dryRun(bundle: Bundle): Diagnosis {
  return {
    verdict: "dry-run", reason: null, output: null, evidenceCheck: null, modelCalls: 0, steps: 0, toolCalls: 0,
    inputTokens: 0, outputTokens: 0, neurons: 0, trajectory: { system: SYSTEM_PROMPT, prompt: renderPrompt(bundle), steps: [] },
  };
}

export async function runTick(deps: TickDeps): Promise<TickResult> {
  const step = deps.onStep ?? (() => undefined);
  // Step 0: the flag first; `off` touches nothing.
  step(0);
  const flag = parseFlag(deps.flag);
  if (flag.mode === "off") return flag;
  const mode = flag.mode;
  if (mode === "live" && deps.model === undefined) throw new Error("SRE_AGENT=live needs a model");
  const { env } = deps;
  const at = deps.now.toISOString();
  const date = utcDate(deps.now);
  const runId = sreRunId(deps.now);
  const store = scopedStore(env, deps.store);
  const stateKey = sreKey(env, "state.json");
  const state: SreState = loadState(await store.get(stateKey), date);
  const persist = (value: SreState) => store.put(stateKey, JSON.stringify(value));
  const ledger = new NeuronLedger(state, persist);
  const secrets = deps.secrets ?? [];
  const library = deps.library ?? PLAYBOOK_LIBRARY;

  // Steps 1–2: firings of this environment, then dedupe and caps.
  step(1);
  const health = await deps.readHealth();
  const ci = await readCiRelease(env, deps.fetch, deps.ciTimeoutMs === undefined ? {} : { timeoutMs: deps.ciTimeoutMs });
  const { firings, signals } = collectFirings(env, health, ci);
  step(2);
  const plan = planDiagnoses(firings, state, date);
  if (plan.groups.length === 0) step(3);

  // Steps 4–6 per job (step 3, no new firing, is the empty loop).
  const diagnoses: DiagnosisRecord[] = [];
  const items = new Map<string, readonly EvidenceItem[]>();
  for (const group of plan.groups) {
    step(4);
    const bundle = await buildBundle({ env, job: group.job, firings: group.firings, health, querySignals: deps.querySignals, ci, library, secrets });
    state.today.diagnoses += 1;
    step(5);
    const diagnosis = mode === "dry" ? dryRun(bundle) : await diagnoseBundle({
      model: deps.model!, modelId: deps.modelId, bundle, ledger, runId,
      ...(deps.generateText === undefined ? {} : { generateText: deps.generateText }),
      tools: { env, health, querySignals: deps.querySignals, fetch: deps.fetch, library, secrets, ciRuns: group.job === CI_JOB },
      ...(deps.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: deps.toolTimeoutMs }),
    });
    step(6);
    const trajectoryKey = sreKey(env, `trajectories/${date}/${runId}-${group.job}.json`);
    await store.put(trajectoryKey, JSON.stringify({
      runId, job: group.job, bundle: bundle.items, ...diagnosis.trajectory,
      output: diagnosis.output, evidenceCheck: diagnosis.evidenceCheck, verdict: diagnosis.verdict, reason: diagnosis.reason,
    }));
    for (const firing of group.firings) state.fingerprints[fingerprint(firing)] = { runId: firing.runId, diagnosedOn: date };
    items.set(group.job, bundle.items);
    diagnoses.push(record(env, group.firings, bundle, diagnosis, deps.modelId, at, trajectoryKey));
  }

  // Step 7: the run record, then state.json (B33).
  step(7);
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
  const lastDrill = deps.afterRun === undefined ? undefined : await deps.afterRun({ runRecord, health, items });
  if (lastDrill !== undefined) state.lastDrill = lastDrill;
  state.lastRun = {
    runId, at, status: "ok", firings: runRecord.firings, diagnosed: runRecord.diagnosed, notDiagnosed: runRecord.notDiagnosed.length,
    modelCalls: runRecord.modelCalls, neurons: runRecord.neurons, verdicts: diagnoses.map((value) => value.verdict), recordKey,
  };
  await persist(state);
  return { mode, runRecord, neuronsToday: state.today.neurons };
}

/**
 * B23: the Worker branch records a tick that threw as `lastRun.status: "failed"` with its sanitized
 * reason, keeping the fingerprints and `today` already in `state.json`. A `state.json` that cannot be
 * read or parsed is never replaced (that would reset the day's neuron reservations, B31): the error
 * propagates, and `/health.sreAgent` reports the read error instead.
 */
export async function recordFailedTick(input: { readonly env: Env; readonly store: RawStore; readonly now: Date; readonly reason: string }): Promise<LastRun> {
  const store = scopedStore(input.env, input.store);
  const key = sreKey(input.env, "state.json");
  const state = loadState(await store.get(key), utcDate(input.now));
  const lastRun: LastRun = { runId: sreRunId(input.now), at: input.now.toISOString(), status: "failed", reason: input.reason };
  state.lastRun = lastRun;
  await store.put(key, JSON.stringify(state));
  return lastRun;
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
