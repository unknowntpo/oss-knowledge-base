/**
 * Spec 019 amendment (7): the identity-link job, its own job (decision 11.3). It reads objects other
 * jobs already write — the activity log's `state.json` and month objects (the publication's
 * append), the ASF roster cache (the review queue) — and the profile's reviewed list (code), and
 * writes `internal/identity/v1/<projectId>/links.json` only when its bytes change, then
 * `internal/identity/v1/last-run.json`, the status `/health` reads. It calls no upstream API, reads
 * no publication state and never starts, waits for or is started by another job.
 *
 * Per run: 1 previous run record (`last-run.json`, which carries `lastGoodAt` and the SHA-256 of each
 * table it wrote), and per project with a `corroboration` config 1 state + 12 months + 1 roster, so
 * at most 15 Class B and 2 Class A on every path (W86); months are read one at a time and reduced to
 * the facts the rule needs before the next is read (Spec 009). The table itself is never read back:
 * its new bytes are compared with the recorded digest. Any failed or unparsable read fails the project closed: no table is written
 * and the last good one stays (W76). Plain puts: equal inputs give equal bytes, so two concurrent
 * runs write the same objects (W82).
 */
import { errorText } from "@oss-knowledge-base/semantic-vectorize";
import {
  classifyPrecision,
  computeIdentityLinks,
  encodeIdentityLinks,
  IDENTITY_LINKS_LAST_RUN_KEY,
  IDENTITY_LINKS_REVISION,
  IdentityFacts,
  identityLinksKey,
  KAFKA_COMMITTERS_CAPTURE,
  parseActivityMonth,
  parseActivityState,
  peopleActivityMonthKey,
  peopleActivityStateKey,
  suppressedIdentities,
  type PeopleIdentityProfile,
  type PrecisionReport,
  type Roster,
} from "@oss-knowledge-base/reference-pipeline";

import { rosterKey } from "../review-queue/store";

/** Decision 4: the newest 12 calendar months. */
const HORIZON_MONTHS = 12;

export interface IdentityLinksBucket {
  get(key: string): Promise<string | undefined>;
  put(key: string, body: string): Promise<void>;
}

export type IdentityLinksStatus = "ok" | "unchanged" | "no-input" | "failed";

export interface IdentityLinksLastRun {
  readonly ok: boolean;
  readonly status: IdentityLinksStatus;
  readonly at: string;
  readonly durationMs: number;
  readonly dryRun?: true;
  readonly blind?: true;
  readonly inputs: { readonly months: readonly string[]; readonly activityUpdatedAt: string | null; readonly rosterAt: string | null; readonly committersAt: string | null };
  readonly links: { readonly roster: number; readonly declared: number; readonly corroborated: number };
  readonly rejected: { readonly dominance: number; readonly competitor: number; readonly minimum: number; readonly conflict: number; readonly contradiction: number; readonly removed: number };
  readonly people: number;
  readonly kipStarters: number;
  readonly bytesWritten: number;
  readonly r2: { readonly classA: number; readonly classB: number };
  readonly error?: string;
}

/** `last-run.json` and `/health` `identityLinks` (W91). */
export interface IdentityLinksRecord {
  readonly revision: string;
  readonly lastRun: IdentityLinksLastRun;
  readonly lastGoodAt: string | null;
  /** SHA-256 of the table last written per project, so an unchanged table is not rewritten (W78). */
  readonly tables?: Readonly<Record<string, string>>;
  /** Dry runs only: the precision check against the committers page (W90). Never stored. */
  readonly precision?: PrecisionReport;
}

/** `IDENTITY_LINKS` unset or blank: off. `corroborated@1`: on. Anything else fails the run, never another job. */
export function identityLinksSet(value: string | undefined): boolean {
  return (value?.trim() ?? "") !== "";
}

class CountingBucket implements IdentityLinksBucket {
  classA = 0;
  classB = 0;
  constructor(private readonly inner: IdentityLinksBucket) {}
  get(key: string) {
    this.classB += 1;
    return this.inner.get(key);
  }
  put(key: string, body: string) {
    this.classA += 1;
    return this.inner.put(key, body);
  }
}

export class R2IdentityLinksBucket implements IdentityLinksBucket {
  constructor(private readonly bucket: R2Bucket) {}
  async get(key: string): Promise<string | undefined> {
    const object = await this.bucket.get(key);
    return object === null ? undefined : object.text();
  }
  async put(key: string, body: string): Promise<void> {
    await this.bucket.put(key, body, { httpMetadata: { contentType: "application/json", cacheControl: "no-store" } });
  }
}

/** A read the job cannot use: the error names the object key (W76). */
async function readJson<T>(bucket: IdentityLinksBucket, key: string, parse: (value: unknown) => T): Promise<T | undefined> {
  let body: string | undefined;
  try {
    body = await bucket.get(key);
  } catch (error) {
    throw new Error(`reading ${key} failed: ${errorText(error)}`);
  }
  if (body === undefined) return undefined;
  try {
    return parse(JSON.parse(body));
  } catch (error) {
    throw new Error(`${key} does not parse: ${errorText(error)}`);
  }
}

function parseRoster(value: unknown): Roster {
  const roster = value as Partial<Roster> | null;
  if (roster === null || typeof roster !== "object" || typeof roster.fetchedAt !== "string" || !Array.isArray(roster.entries) ||
      !roster.entries.every((entry) => typeof entry?.id === "string" && (entry.name === null || typeof entry.name === "string"))) {
    throw new Error("the roster is malformed");
  }
  return roster as Roster;
}

function parseRecord(value: unknown): Partial<IdentityLinksRecord> {
  const record = value as Partial<IdentityLinksRecord> | null;
  if (record === null || typeof record !== "object" || (record.lastGoodAt !== null && record.lastGoodAt !== undefined && typeof record.lastGoodAt !== "string") ||
      (record.tables !== undefined && (typeof record.tables !== "object" || record.tables === null ||
        !Object.values(record.tables).every((digest) => typeof digest === "string")))) {
    throw new Error("the previous run record is malformed");
  }
  return record;
}

async function sha256Hex(body: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface RunIdentityLinksInput {
  readonly flag: string | undefined;
  readonly bucket: IdentityLinksBucket;
  readonly profiles: readonly PeopleIdentityProfile[];
  /** Bot logins per project (the people profile's list), which pair nothing. */
  readonly bots: (projectId: string) => readonly string[];
  /** P-e suppression digests per project, and the digest function. */
  readonly suppressed: Readonly<Record<string, readonly string[]>>;
  readonly digest: (projectId: string, personId: string) => Promise<string>;
  readonly now: () => number;
  readonly dryRun?: boolean;
  /** W103: leave the committers page's `declared` entries out (precision check). */
  readonly blind?: boolean;
}

/** One run over every project with a `corroboration` config (Kafka; DataFusion makes no call). */
export async function runIdentityLinks(input: RunIdentityLinksInput): Promise<IdentityLinksRecord> {
  const started = input.now();
  const at = new Date(started).toISOString();
  const bucket = new CountingBucket(input.bucket);
  const links = { roster: 0, declared: 0, corroborated: 0 };
  const rejected = { dominance: 0, competitor: 0, minimum: 0, conflict: 0, contradiction: 0, removed: 0 };
  let people = 0;
  let kipStarters = 0;
  let bytesWritten = 0;
  let inputs: IdentityLinksLastRun["inputs"] = { months: [], activityUpdatedAt: null, rosterAt: null, committersAt: null };
  const statuses: IdentityLinksStatus[] = [];
  let precision: PrecisionReport | undefined;
  const lastRun = (status: IdentityLinksStatus, error?: string): IdentityLinksLastRun => ({
    ok: status !== "failed", status, at, durationMs: input.now() - started,
    ...(input.dryRun === true ? { dryRun: true as const } : {}),
    ...(input.blind === true ? { blind: true as const } : {}),
    inputs, links, rejected, people, kipStarters, bytesWritten,
    r2: { classA: bucket.classA, classB: bucket.classB },
    ...(error === undefined ? {} : { error }),
  });

  let failure: string | undefined;
  let previous: Partial<IdentityLinksRecord> | undefined;
  const tables: Record<string, string> = {};
  try {
    if (input.flag?.trim() !== IDENTITY_LINKS_REVISION) {
      throw new Error(`IDENTITY_LINKS "${input.flag}" is not supported (${IDENTITY_LINKS_REVISION}, or unset)`);
    }
    // The one read that carries `lastGoodAt` and the written tables' digests, also into a failed run.
    previous = await readJson(bucket, IDENTITY_LINKS_LAST_RUN_KEY, parseRecord);
    Object.assign(tables, previous?.tables ?? {});
    for (const profile of input.profiles) {
      const config = profile.corroboration;
      if (config === undefined) continue;
      inputs = { ...inputs, committersAt: profile.committersAt ?? null };
      const state = await readJson(bucket, peopleActivityStateKey(profile.projectId), parseActivityState);
      if (state === undefined) {
        statuses.push("no-input");
        continue;
      }
      const tableKey = identityLinksKey(profile.projectId);
      const roster = profile.roster === null
        ? null
        : await readJson(bucket, rosterKey(profile.roster.adapter, profile.roster.project), parseRoster) ?? null;
      const months = [...state.months].sort().slice(-HORIZON_MONTHS);
      const facts = new IdentityFacts(profile.projectId, config.issueKey, input.bots(profile.projectId));
      for (const month of months) {
        const key = peopleActivityMonthKey(profile.projectId, month);
        const parsed = await readJson(bucket, key, (value) => parseActivityMonth(value, profile.projectId, month));
        // A month the state lists but R2 lacks could hide a competing pairing: fail closed.
        if (parsed === undefined) throw new Error(`${key} is listed in the state but missing`);
        facts.add(parsed);
      }
      inputs = { months, activityUpdatedAt: state.updatedAt, rosterAt: roster?.fetchedAt ?? null, committersAt: profile.committersAt ?? null };
      const suppressed = await suppressedIdentities({
        ids: [...facts.identities(), ...profile.identityLinks.flatMap((entry) => [entry.a, entry.b])],
        accountNames: facts.accountNames(),
        digests: input.suppressed[profile.projectId] ?? [],
        digest: (personId) => input.digest(profile.projectId, personId),
      });
      const result = computeIdentityLinks({
        projectId: profile.projectId,
        config,
        facts,
        roster,
        identityLinks: profile.identityLinks,
        blind: input.blind === true,
        suppressed,
        inputs: { coverageFrom: state.coverageFrom, months, activityUpdatedAt: state.updatedAt, rosterAt: roster?.fetchedAt ?? null },
        ...(profile.committersAt === undefined ? {} : { committersAt: profile.committersAt }),
      });
      for (const basis of ["roster", "declared", "corroborated"] as const) links[basis] += result.counts.links[basis];
      for (const reason of Object.keys(rejected) as (keyof typeof rejected)[]) rejected[reason] += result.counts.rejected[reason];
      people += result.counts.people;
      kipStarters += result.counts.kipStarters;
      if (input.dryRun === true) {
        precision = classifyPrecision(result.table, KAFKA_COMMITTERS_CAPTURE.committers, facts.pullAuthors());
        statuses.push("ok");
        continue;
      }
      const body = encodeIdentityLinks(result.table);
      const digest = await sha256Hex(body);
      if (digest === tables[profile.projectId]) {
        statuses.push("unchanged");
        continue;
      }
      await bucket.put(tableKey, body);
      tables[profile.projectId] = digest;
      bytesWritten += body.length;
      statuses.push("ok");
    }
  } catch (error) {
    failure = errorText(error);
  }

  const status: IdentityLinksStatus = failure !== undefined ? "failed"
    : statuses.includes("ok") ? "ok"
    : statuses.includes("unchanged") ? "unchanged"
    : "no-input";
  if (input.dryRun === true) {
    return { revision: IDENTITY_LINKS_REVISION, lastRun: lastRun(status, failure), lastGoodAt: null, ...(precision === undefined ? {} : { precision }) };
  }
  // A run that wrote or confirmed a table is good; a failed or input-less run carries the last good time.
  const good = status === "ok" || status === "unchanged";
  const lastGoodAt = good ? at : typeof previous?.lastGoodAt === "string" ? previous.lastGoodAt : null;
  // Last, after the table: a crash between the two puts leaves the old digest, so the next run
  // rewrites the same table bytes and then the record (W79).
  const record: IdentityLinksRecord = { revision: IDENTITY_LINKS_REVISION, lastRun: lastRun(status, failure), lastGoodAt, tables };
  const recordBody = JSON.stringify({ ...record, lastRun: { ...record.lastRun, r2: { classA: bucket.classA + 1, classB: bucket.classB } } });
  await bucket.put(IDENTITY_LINKS_LAST_RUN_KEY, recordBody);
  return JSON.parse(recordBody) as IdentityLinksRecord;
}
