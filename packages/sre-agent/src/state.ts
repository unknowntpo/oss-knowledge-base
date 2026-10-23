/**
 * Steps 0 and 2 of B26: `state.json`, fingerprint dedupe (A1 item 19) and the daily caps (B31):
 * ≤ 3 diagnoses, ≤ 12 steps each, ≤ 1,500 neurons a UTC day, reserved before each model call.
 */
import { V1_RULES } from "./firings";
import type { LastRun } from "./tick";
import type { Firing } from "./types";

export const MAX_DIAGNOSES_PER_DAY = 3;
export const MAX_STEPS = 12;
export const MAX_OUTPUT_TOKENS = 1024;
export const DAILY_NEURON_CAP = 1500;

export interface SreState {
  /** Fingerprint → the `runId` last diagnosed and its UTC day. */
  fingerprints: Record<string, { runId: string | null; diagnosedOn: string }>;
  today: { date: string; diagnoses: number; neurons: number };
  lastRun?: LastRun;
}

export function emptyState(date: string): SreState {
  return { fingerprints: {}, today: { date, diagnoses: 0, neurons: 0 } };
}

/** Parses `state.json` and rolls `today` over at the UTC day boundary. */
export function loadState(body: string | null, date: string): SreState {
  const state = body === null ? emptyState(date) : (JSON.parse(body) as SreState);
  if (state.today?.date !== date) state.today = { date, diagnoses: 0, neurons: 0 };
  state.fingerprints ??= {};
  return state;
}

export const utcDate = (at: Date) => at.toISOString().slice(0, 10);

export function fingerprint(firing: Pick<Firing, "env" | "job" | "ruleId" | "since">): string {
  return `${firing.env}:${firing.job}:${firing.ruleId}:${firing.since}`;
}

export type NotDiagnosedReason = "out-of-scope" | "daily-cap";

export interface Plan {
  /** One group per job with new in-scope firings, in order of first firing, within the daily cap. */
  readonly groups: { job: string; firings: Firing[] }[];
  readonly notDiagnosed: { fingerprint: string; reason: NotDiagnosedReason }[];
  /** Firings already diagnosed for this `runId`, or for another `runId` earlier the same UTC day. */
  readonly duplicates: string[];
}

export function planDiagnoses(firings: readonly Firing[], state: SreState, date: string): Plan {
  const notDiagnosed: Plan["notDiagnosed"] = [];
  const duplicates: string[] = [];
  const byJob = new Map<string, Firing[]>();
  for (const firing of firings) {
    const key = fingerprint(firing);
    if (V1_RULES[firing.ruleId] === undefined) {
      notDiagnosed.push({ fingerprint: key, reason: "out-of-scope" });
      continue;
    }
    const seen = state.fingerprints[key];
    if (seen !== undefined && (seen.runId === firing.runId || seen.diagnosedOn === date)) {
      duplicates.push(key);
      continue;
    }
    byJob.set(firing.job, [...(byJob.get(firing.job) ?? []), firing]);
  }
  const room = Math.max(0, MAX_DIAGNOSES_PER_DAY - state.today.diagnoses);
  const groups = [...byJob].map(([job, value]) => ({ job, firings: value }));
  for (const group of groups.slice(room)) {
    for (const firing of group.firings) notDiagnosed.push({ fingerprint: fingerprint(firing), reason: "daily-cap" });
  }
  return { groups: groups.slice(0, room), notDiagnosed, duplicates };
}

/** Workers AI neurons per million tokens (Spec 027 A2-6, pricing page 2026-10-22). */
export const NEURON_RATES: Readonly<Record<string, { input: number; output: number }>> = {
  "@cf/zai-org/glm-4.7-flash": { input: 5_500, output: 36_400 },
  "@cf/qwen/qwen3-30b-a3b-fp8": { input: 4_625, output: 30_475 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { input: 26_668, output: 204_805 },
};

/** An unlisted model is charged at the most expensive listed rates, so the cap still bounds it. */
export function neuronsFor(modelId: string, inputTokens: number, outputTokens: number): number {
  const rates = NEURON_RATES[modelId] ?? {
    input: Math.max(...Object.values(NEURON_RATES).map((rate) => rate.input)),
    output: Math.max(...Object.values(NEURON_RATES).map((rate) => rate.output)),
  };
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}

export class BudgetExceededError extends Error {
  constructor(readonly reservation: number, readonly today: number) {
    super(`neuron reservation ${reservation.toFixed(1)} would pass ${DAILY_NEURON_CAP} (today ${today.toFixed(1)})`);
    this.name = "BudgetExceededError";
  }
}

/**
 * B31: reserve a step's worst case in `today.neurons` and persist it before the model call, then
 * settle with the step's usage; a crash between the two leaves the reservation counted.
 */
export class NeuronLedger {
  constructor(readonly state: SreState, private readonly persist: (state: SreState) => Promise<void>, private readonly cap = DAILY_NEURON_CAP) {}

  async reserve(neurons: number): Promise<void> {
    if (this.state.today.neurons + neurons > this.cap) throw new BudgetExceededError(neurons, this.state.today.neurons);
    this.state.today.neurons += neurons;
    await this.persist(this.state);
  }

  settle(reserved: number, actual: number): void {
    this.state.today.neurons += actual - reserved;
  }
}
