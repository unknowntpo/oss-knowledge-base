/**
 * Spec 019 slice 2b: the activity log's append, run by the publication before `compactState`
 * deletes old events (Behavior 3). Every run rebuilds the rows of every record the state still
 * holds, so a run whose append failed is repaired by the next one while the records are in the
 * state (35 days, W9), and a repeated record replaces its row (W2).
 *
 * Per project and run: one read of `state.json`, one read per month that has rows in the state
 * (at most 12), one write of the month and one of its summary for each month whose bytes changed,
 * and one write of `state.json`. Plain puts: only this Durable Object's alarm writes these keys,
 * and the runtime never runs two alarms at once, so no conditional put (and no failed one) is sent.
 */
import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import { errorText } from "@oss-knowledge-base/semantic-vectorize";
import {
  activityMonthsFromEvents,
  encodeActivityMonth,
  encodeActivitySummary,
  mergeActivityMonth,
  parseActivityMonth,
  parseActivityState,
  PEOPLE_ACTIVITY_REVISION,
  PEOPLE_ACTIVITY_STATE_SCHEMA,
  peopleActivityMonthKey,
  peopleActivityStateKey,
  peopleActivitySummaryKey,
  STATE_RETENTION_DAYS,
  type ActivityStateV1,
} from "@oss-knowledge-base/reference-pipeline";

import type { R2OperationCounts } from "../pipeline";

const DAY_MS = 86_400_000;
/** Decision 4: the newest 12 calendar months, the current one included. */
const HORIZON_MONTHS = 12;

export interface ActivityBucket {
  get(key: string): Promise<string | undefined>;
  put(key: string, body: string): Promise<void>;
}

export type ActivityLogStatus =
  | {
      readonly ok: true;
      readonly revision: typeof PEOPLE_ACTIVITY_REVISION;
      /** Rows the state holds inside the log's coverage, all projects. */
      readonly rows: number;
      readonly monthsRead: number;
      readonly monthsWritten: number;
      readonly monthsUnchanged: number;
      /** Distinct identities in the written and unchanged months of this run. */
      readonly identities: number;
      /** The oldest month that has an object, per project. */
      readonly earliestMonth: Readonly<Record<string, string>>;
      readonly coverageFrom: Readonly<Record<string, string>>;
      readonly bytesWritten: number;
      readonly durationMs: number;
      readonly r2: R2OperationCounts;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly durationMs: number;
      readonly r2: R2OperationCounts;
    };

/** `PEOPLE_ACTIVITY` unset or blank: off. `log@1`: on. Anything else fails the append, never the publication. */
export function peopleActivitySet(value: string | undefined): boolean {
  return (value?.trim() ?? "") !== "";
}

/** Counts R2 requests by billing class: a get is Class B, a put Class A. */
export class CountingActivityBucket implements ActivityBucket {
  classA = 0;
  classB = 0;
  constructor(private readonly inner: ActivityBucket) {}
  get(key: string) {
    this.classB += 1;
    return this.inner.get(key);
  }
  put(key: string, body: string) {
    this.classA += 1;
    return this.inner.put(key, body);
  }
}

export class R2ActivityBucket implements ActivityBucket {
  constructor(private readonly bucket: R2Bucket) {}
  async get(key: string): Promise<string | undefined> {
    const object = await this.bucket.get(key);
    return object === null ? undefined : object.text();
  }
  async put(key: string, body: string): Promise<void> {
    await this.bucket.put(key, body, { httpMetadata: { contentType: "application/json", cacheControl: "no-store" } });
  }
}

function horizonStart(materializedAt: string): string {
  const now = new Date(materializedAt);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (HORIZON_MONTHS - 1), 1)).toISOString();
}

export async function appendActivityLog(input: {
  readonly flag: string | undefined;
  readonly bucket: ActivityBucket;
  readonly events: readonly DomainEventV1[];
  readonly materializedAt: string;
  /** Every project the publication reads, so a project without rows still records its coverage. */
  readonly projectIds: readonly string[];
}): Promise<ActivityLogStatus> {
  const started = Date.now();
  const bucket = new CountingActivityBucket(input.bucket);
  const r2 = () => ({ classA: bucket.classA, classB: bucket.classB });
  try {
    if (input.flag?.trim() !== PEOPLE_ACTIVITY_REVISION) {
      throw new Error(`PEOPLE_ACTIVITY "${input.flag}" is not supported (${PEOPLE_ACTIVITY_REVISION}, or unset)`);
    }
    const states = new Map<string, ActivityStateV1 | undefined>();
    for (const projectId of input.projectIds) {
      const body = await bucket.get(peopleActivityStateKey(projectId));
      states.set(projectId, body === undefined ? undefined : parseActivityState(JSON.parse(body)));
    }
    const firstCoverage = new Date(Date.parse(input.materializedAt) - STATE_RETENTION_DAYS * DAY_MS).toISOString();
    const coverageFrom = new Map(input.projectIds.map((projectId) => [projectId, states.get(projectId)?.coverageFrom ?? firstCoverage]));
    const earliest = [...coverageFrom.values(), horizonStart(input.materializedAt)].sort()[0]!;
    const horizon = horizonStart(input.materializedAt);
    const incoming = activityMonthsFromEvents(input.events, earliest)
      .filter((month) => coverageFrom.has(month.projectId))
      .map((month) => {
        const from = [coverageFrom.get(month.projectId)!, horizon].sort().at(-1)!;
        return { ...month, rows: month.rows.filter((row) => row.at >= from) };
      })
      .filter((month) => month.rows.length > 0);

    let monthsRead = 0;
    let monthsWritten = 0;
    let monthsUnchanged = 0;
    let bytesWritten = 0;
    const identities = new Set<string>();
    const written = new Map<string, Set<string>>(input.projectIds.map((projectId) => [projectId, new Set(states.get(projectId)?.months ?? [])]));
    // One month at a time, so at most one stored month is parsed at once (W19).
    for (const month of incoming) {
      const key = peopleActivityMonthKey(month.projectId, month.month);
      const storedBody = await bucket.get(key);
      monthsRead += 1;
      const stored = storedBody === undefined ? undefined : parseActivityMonth(JSON.parse(storedBody), month.projectId, month.month);
      const merged = mergeActivityMonth(stored, month);
      for (const row of merged.rows) identities.add(`${month.projectId}\u0000${row.person}`);
      const body = encodeActivityMonth(merged);
      if (body === storedBody) {
        monthsUnchanged += 1;
        // The month exists in R2 even when an earlier, failed run wrote it.
        written.get(month.projectId)!.add(month.month);
        continue;
      }
      // The summary first: the month's bytes are what the next run compares, so a month whose
      // summary write failed is not taken as done.
      const summary = encodeActivitySummary(merged);
      await bucket.put(peopleActivitySummaryKey(month.projectId, month.month), summary);
      await bucket.put(key, body);
      bytesWritten += body.length + summary.length;
      monthsWritten += 1;
      written.get(month.projectId)!.add(month.month);
    }
    // Last, so `updatedAt` advances only when every month of the project was written (W9).
    for (const projectId of input.projectIds) {
      const previous = states.get(projectId);
      const state: ActivityStateV1 = {
        schema: PEOPLE_ACTIVITY_STATE_SCHEMA,
        firstAppendAt: previous?.firstAppendAt ?? input.materializedAt,
        coverageFrom: coverageFrom.get(projectId)!,
        updatedAt: input.materializedAt,
        months: [...written.get(projectId)!].sort(),
      };
      const body = JSON.stringify(state);
      await bucket.put(peopleActivityStateKey(projectId), body);
      bytesWritten += body.length;
    }
    return {
      ok: true,
      revision: PEOPLE_ACTIVITY_REVISION,
      rows: incoming.reduce((sum, month) => sum + month.rows.length, 0),
      monthsRead,
      monthsWritten,
      monthsUnchanged,
      identities: identities.size,
      earliestMonth: Object.fromEntries(input.projectIds.flatMap((projectId) => {
        const first = [...written.get(projectId)!].sort()[0];
        return first === undefined ? [] : [[projectId, first]];
      })),
      coverageFrom: Object.fromEntries(coverageFrom),
      bytesWritten,
      durationMs: Date.now() - started,
      r2: r2(),
    };
  } catch (error) {
    return { ok: false, error: errorText(error), durationMs: Date.now() - started, r2: r2() };
  }
}
