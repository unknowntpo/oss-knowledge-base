/**
 * Spec 027 "Dev fault-injection drill" (B37–B46): the drill's kinds and expected answers (B41), its
 * record and pointer under `internal/sre/v1/dev/drills/` (B38, B39), and the grader (B42). Dev only:
 * the Worker calls these only while `SRE_DRILL=on` on `development` (SRE68). No model call.
 *
 * The pointer marks the one active drill: it is written on arm and deleted when the drill is graded,
 * cancelled or expires. A faulted run does not delete it (drill notes, 2026-10-25): the record's
 * `applied` count tells the job when the fault is used up, and the tick and `/health` find a fired,
 * ungraded drill through the pointer without listing the bucket.
 */
import type { EvidenceItem } from "./bundle";
import { parseCauses, type PlaybookLibrary } from "./playbook";
import { PLAYBOOK_LIBRARY } from "./playbooks.generated";
import { scopedStore, sreKey } from "./store";
import type { DiagnosisRecord, RunRecord } from "./tick";
import type { Health, RawStore } from "./types";

export const DRILL_JOB = "kip-pages";
export const DRILL_KINDS = ["throw", "skip"] as const;
export type DrillKind = (typeof DRILL_KINDS)[number];

const HOUR = 3_600_000;
/** B39: `throw` faults 2 runs (`job.failures` fires on 2 consecutive failures), `skip` 1. */
export const DRILL_RUNS: Readonly<Record<DrillKind, number>> = { throw: 2, skip: 1 };
/** B39: an armed pointer older than this is deleted unapplied. */
export const DRILL_EXPIRES_MS = 48 * HOUR;
/** B42: a fired drill with no matching diagnosis this long after its last faulted run fails `no-diagnosis`. */
export const DRILL_GRADE_WAIT_MS: Readonly<Record<DrillKind, number>> = { throw: 24 * HOUR, skip: 48 * HOUR };

/** A required evidence item: a `/health` field whose value a quote must contain, or a bundle item by label. */
export type RequiredEvidence =
  | { readonly name: string; readonly path: readonly string[] }
  | { readonly name: string; readonly label: string };

export interface DrillExpectation {
  readonly rule: string;
  readonly cause: string;
  readonly evidence: readonly RequiredEvidence[];
  readonly runbook: string;
}

/** B41: the expected diagnosis per kind, held in code and never in the bundle. */
export const drillExpectations: Readonly<Record<DrillKind, DrillExpectation>> = {
  throw: {
    rule: "job.failures",
    cause: "upstream-unavailable",
    evidence: [{ name: "kipPages.lastRun.error", path: ["kipPages", "lastRun", "error"] }, { name: "Q-window", label: "Q-window" }],
    runbook: "cloudflare-data-publisher.md#upstream-failures-job-runs",
  },
  skip: {
    rule: "job.missed",
    cause: "cron-not-fired",
    evidence: [{ name: "kipPages.lastRun.at", path: ["kipPages", "lastRun", "at"] }, { name: "Q-history", label: "Q-history" }],
    runbook: "cloudflare-data-publisher.md#health-and-manual-run",
  },
};

export const isDrillKind = (value: unknown): value is DrillKind => typeof value === "string" && (DRILL_KINDS as readonly string[]).includes(value);

/**
 * B41 drift check (SRE72): why a kind's expected answer cannot be graded against the bundled
 * playbooks, naming the rule, cause or anchor; empty when it can. The arm route refuses such a kind.
 */
export function drillExpectationErrors(kind: DrillKind, library: PlaybookLibrary = PLAYBOOK_LIBRARY, expectations: Readonly<Record<DrillKind, DrillExpectation>> = drillExpectations): string[] {
  const expected = expectations[kind];
  const text = library.playbooks[expected.rule];
  if (text === undefined) return [`${kind}: no playbook for ${expected.rule}`];
  const cause = parseCauses(text).find((value) => value.id === expected.cause);
  if (cause === undefined) return [`${kind}: the ${expected.rule} playbook does not list cause ${expected.cause}`];
  if (!cause.anchors.includes(expected.runbook)) return [`${kind}: the ${expected.rule} playbook does not list ${expected.runbook} for cause ${expected.cause}`];
  return [];
}

export type DrillState = "armed" | "fired" | "graded" | "expired" | "cancelled";

/** `drills/armed/kip-pages.json`: the one active drill. */
export interface DrillPointer {
  readonly drillId: string;
  readonly job: typeof DRILL_JOB;
  readonly kind: DrillKind;
  readonly runs: number;
  readonly armedAt: string;
  readonly expiresAt: string;
}

/** `drills/<drillId>.json`: the drill record (B38). */
export interface DrillRecord extends DrillPointer {
  readonly state: DrillState;
  /** Faulted runs so far; the fault applies while `applied < runs`. */
  readonly applied: number;
  /** The `throw` runs' `runId`s (a skipped run has none). */
  readonly runIds: string[];
  /** When the last faulted run happened (`fired`). */
  readonly firedAt: string | null;
  readonly result: "pass" | "fail" | null;
  readonly reasons: string[];
  readonly gradedAt: string | null;
  /** The graded diagnosis: the tick's `runId` and its trajectory. */
  readonly diagnosis: { readonly runId: string; readonly trajectoryKey: string } | null;
}

/** `/health.sreAgent.lastDrill` (B42). */
export interface DrillSummary {
  readonly drillId: string;
  readonly kind: DrillKind;
  readonly state: DrillState;
  readonly result: "pass" | "fail" | null;
  readonly reasons: string[];
  readonly runIds: string[];
}

export const DRILL_POINTER_KEY = sreKey("dev", `drills/armed/${DRILL_JOB}.json`);
export const drillRecordKey = (drillId: string) => sreKey("dev", `drills/${drillId}.json`);
/** B38: `<kind>-<armedAt as YYYYMMDDTHHmmZ>`. */
export const drillIdFor = (kind: DrillKind, armedAt: Date) => `${kind}-${armedAt.toISOString().slice(0, 16).replace(/[-:]/gu, "")}Z`;

export const drillSummary = (record: DrillRecord): DrillSummary => ({
  drillId: record.drillId, kind: record.kind, state: record.state, result: record.result, reasons: record.reasons, runIds: record.runIds,
});

/** An HTTP answer for the Worker's routes. */
export interface DrillOutcome {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const parse = <T>(body: string | null): T | null => (body === null ? null : JSON.parse(body) as T);

/** The active drill, after expiring an armed one past `expiresAt` (B39); null when there is none. */
async function active(store: RawStore, now: Date): Promise<{ pointer: DrillPointer; record: DrillRecord } | null> {
  const pointer = parse<DrillPointer>(await store.get(DRILL_POINTER_KEY));
  if (pointer === null) return null;
  const record = parse<DrillRecord>(await store.get(drillRecordKey(pointer.drillId)));
  if (record === null) throw new Error(`the record of ${pointer.drillId} is missing`);
  if (record.state === "armed" && now.getTime() > Date.parse(record.expiresAt)) {
    await store.put(drillRecordKey(record.drillId), JSON.stringify({ ...record, state: "expired" } satisfies DrillRecord));
    await store.delete!(DRILL_POINTER_KEY);
    return null;
  }
  return { pointer, record };
}

/**
 * B38 arm: refuses a kind whose playbook lacks the expected cause (409, B41), a second active drill
 * (409), and answers 503 with no pointer when the record cannot be written. 201 otherwise.
 */
export async function armDrill(raw: RawStore, input: { readonly kind: DrillKind; readonly now: Date; readonly library?: PlaybookLibrary }): Promise<DrillOutcome> {
  const errors = drillExpectationErrors(input.kind, input.library);
  if (errors.length > 0) return { status: 409, body: { ok: false, reason: "playbook-missing-cause", errors } };
  const store = scopedStore("dev", raw);
  let current: Awaited<ReturnType<typeof active>>;
  try {
    current = await active(store, input.now);
  } catch {
    return { status: 503, body: { ok: false, reason: "active-drill-unreadable" } };
  }
  if (current !== null) return { status: 409, body: { ok: false, reason: "drill-active", drillId: current.record.drillId, state: current.record.state } };
  const armedAt = input.now.toISOString();
  const pointer: DrillPointer = {
    drillId: drillIdFor(input.kind, input.now), job: DRILL_JOB, kind: input.kind, runs: DRILL_RUNS[input.kind],
    armedAt, expiresAt: new Date(input.now.getTime() + DRILL_EXPIRES_MS).toISOString(),
  };
  const record: DrillRecord = { ...pointer, state: "armed", applied: 0, runIds: [], firedAt: null, result: null, reasons: [], gradedAt: null, diagnosis: null };
  try {
    await store.put(drillRecordKey(pointer.drillId), JSON.stringify(record));
  } catch {
    return { status: 503, body: { ok: false, reason: "record-unwritable" } };
  }
  try {
    await store.put(DRILL_POINTER_KEY, JSON.stringify(pointer));
  } catch {
    return { status: 503, body: { ok: false, reason: "pointer-unwritable" } };
  }
  return { status: 201, body: { ...pointer } };
}

/** B38 cancel: removes the pointer and marks the record `cancelled`; 409 when no drill is active. */
export async function cancelDrill(raw: RawStore, now: Date): Promise<DrillOutcome> {
  const store = scopedStore("dev", raw);
  const current = await active(store, now);
  if (current === null) return { status: 409, body: { ok: false, reason: "no-active-drill" } };
  await store.delete!(DRILL_POINTER_KEY);
  await store.put(drillRecordKey(current.record.drillId), JSON.stringify({ ...current.record, state: "cancelled" } satisfies DrillRecord));
  return { status: 200, body: { ok: true, drillId: current.record.drillId, state: "cancelled" } };
}

/** B39: the drill whose fault applies to this run, or none (no pointer, expired, or used up). */
export async function takeDrillFault(raw: RawStore, now: Date): Promise<DrillRecord | null> {
  const current = await active(scopedStore("dev", raw), now);
  if (current === null || current.record.state !== "armed" || current.record.applied >= current.record.runs) return null;
  return current.record;
}

/** B39: counts one faulted run; the last one sets the record `fired`. */
export async function recordFaultedRun(raw: RawStore, record: DrillRecord, runId: string | null, now: Date): Promise<DrillRecord> {
  const applied = record.applied + 1;
  const fired = applied >= record.runs;
  const next: DrillRecord = {
    ...record, applied, runIds: runId === null ? record.runIds : [...record.runIds, runId],
    ...(fired ? { state: "fired" as const, firedAt: now.toISOString() } : {}),
  };
  await scopedStore("dev", raw).put(drillRecordKey(record.drillId), JSON.stringify(next));
  return next;
}

const collapse = (text: string) => text.replace(/\s+/gu, " ").trim();

function field(health: Health, path: readonly string[]): unknown {
  return path.reduce<unknown>((node, key) => (node !== null && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), health);
}

/**
 * B42, SRE72: grades one diagnosis against B41 (no model, no LLM judge). Each required evidence item
 * must be cited: a `/health` field by a quote containing its value, a harness result by citing the
 * item with that label. The verdict must be `explained`, so every quote passed the B32 check.
 */
export function gradeDiagnosis(kind: DrillKind, diagnosis: DiagnosisRecord | undefined, items: readonly EvidenceItem[], health: Health): { result: "pass" | "fail"; reasons: string[] } {
  if (diagnosis === undefined) return { result: "fail", reasons: ["no-diagnosis"] };
  const expected = drillExpectations[kind];
  const reasons: string[] = [];
  if (diagnosis.cause !== expected.cause) reasons.push(`wrong-cause:${diagnosis.cause ?? "none"}`);
  for (const required of expected.evidence) {
    const cited = "label" in required
      ? diagnosis.evidence.some((entry) => items.find((item) => item.id === entry.id)?.label === required.label)
      : (() => {
          const value = field(health, required.path);
          const text = typeof value === "string" || typeof value === "number" ? collapse(String(value)) : "";
          return text !== "" && diagnosis.evidence.some((entry) => collapse(entry.quote).includes(text));
        })();
    if (!cited) reasons.push(`missing-evidence:${required.name}`);
  }
  if (diagnosis.runbook !== expected.runbook) reasons.push(`runbook-mismatch:${diagnosis.runbook ?? "none"}`);
  if (diagnosis.verdict !== "explained") reasons.push(`verdict:${diagnosis.verdict}`);
  return { result: reasons.length === 0 ? "pass" : "fail", reasons };
}

/**
 * B42: at the end of a tick, grades a `fired` drill with this tick's `kip-pages` diagnosis whose
 * `since` is at or after `armedAt`, or fails it `no-diagnosis` once the wait is over. Writes the
 * record, deletes the pointer and returns the summary for `state.json`; undefined when nothing was graded.
 */
export async function gradeActiveDrill(raw: RawStore, input: {
  readonly now: Date;
  readonly runRecord: RunRecord;
  readonly items: ReadonlyMap<string, readonly EvidenceItem[]>;
  readonly health: Health;
}): Promise<DrillSummary | undefined> {
  const store = scopedStore("dev", raw);
  const current = await active(store, input.now);
  if (current === null || current.record.state !== "fired") return undefined;
  const { record } = current;
  const diagnosis = input.runRecord.diagnoses.find((value) => value.job === DRILL_JOB && value.since >= record.armedAt);
  if (diagnosis === undefined && input.now.getTime() - Date.parse(record.firedAt ?? record.armedAt) < DRILL_GRADE_WAIT_MS[record.kind]) return undefined;
  const grade = gradeDiagnosis(record.kind, diagnosis, input.items.get(DRILL_JOB) ?? [], input.health);
  const graded: DrillRecord = {
    ...record, state: "graded", result: grade.result, reasons: grade.reasons, gradedAt: input.now.toISOString(),
    diagnosis: diagnosis === undefined ? null : { runId: input.runRecord.runId, trajectoryKey: diagnosis.trajectoryKey },
  };
  await store.put(drillRecordKey(record.drillId), JSON.stringify(graded));
  await store.delete!(DRILL_POINTER_KEY);
  return drillSummary(graded);
}

/** `/health.sreAgent.lastDrill` while a drill is active (reads only); null when none is. */
export async function activeDrillSummary(raw: RawStore): Promise<DrillSummary | null> {
  const store = scopedStore("dev", raw);
  const pointer = parse<DrillPointer>(await store.get(DRILL_POINTER_KEY));
  if (pointer === null) return null;
  const record = parse<DrillRecord>(await store.get(drillRecordKey(pointer.drillId)));
  return record === null ? null : drillSummary(record);
}
