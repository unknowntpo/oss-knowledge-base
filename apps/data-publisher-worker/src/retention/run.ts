/**
 * Spec 029, dry-run slice: one retention run that lists and reads, then reports what an `enforce`
 * run would delete. The bucket interface has no delete or put: this module cannot remove or write
 * an R2 object (RT5).
 */
import {
  classifyReleases, EVIDENCE_PREFIX, FEED_POOL_PREFIX, FEED_RELEASES_PREFIX, idToken, poolCandidate, poolKeysOf,
  retainedEvidence, SEARCH_POOL_PREFIX, SEARCH_RELEASES_PREFIX,
  type ListedEvidence, type Pins, type Projection, type ReadEvidence, type RetainReason,
} from "./plan";

/** Behavior 12 / Budget: list calls (Class A) a run may make; the Dev drain's worst run needs ≈ 305. */
export const RETENTION_MAX_LISTS = 400;
/** Behavior 12 / Budget: get calls (Class B) a run may make; the Dev drain's worst run needs ≈ 515. */
export const RETENTION_MAX_GETS = 600;
/** Behavior 12: wall-clock budget (the alarm limit is 15 minutes). */
export const RETENTION_WALL_MS = 10 * 60_000;
/** Report lists are capped so the stored report stays far below the 2 MB value limit. */
export const REPORT_LIST_CAP = 5_000;
export const REPORT_POOL_SAMPLE = 100;
const LIST_LIMIT = 1_000;

export interface RetentionListedObject { readonly key: string; readonly size: number; readonly uploaded: Date }

/** The R2 calls a dry run makes: `get` (Class B) and `list` (Class A). No delete, no put. */
export interface RetentionBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  list(options: { readonly prefix: string; readonly cursor?: string; readonly limit?: number }): Promise<{
    readonly objects: readonly RetentionListedObject[];
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
}

export interface RetentionRunDeps {
  readonly bucket: RetentionBucket;
  readonly now: () => number;
  /** Digest project ids whose `public/digest/v1/<id>/current.json` pins a Feed release. */
  readonly digestProjectIds: readonly string[];
  /** The embedding job's `lastRun.releaseId`, or null (unbound, no run yet). */
  readonly embeddingReleaseId: () => Promise<string | null>;
  readonly limits?: { readonly lists?: number; readonly gets?: number; readonly wallMs?: number };
}

export type RetentionStatus = "ok" | "failed" | "overrun";
export type RetentionFailureKind = "pointer-read" | "list" | "internal";

export interface RetentionLastRun {
  readonly runId: string;
  readonly at: string;
  readonly mode: "dry-run";
  readonly status: RetentionStatus;
  readonly reason: "evidence-missing" | null;
  readonly failureKind: RetentionFailureKind | null;
  readonly error: string | null;
  /** Which parts were fully listed; a part not complete is under-counted, never over-counted. */
  readonly complete: { readonly releases: boolean; readonly evidence: boolean; readonly pool: boolean };
  readonly pointers: { readonly feed: string | null; readonly search: string | null };
  readonly retained: { readonly releases: { readonly feed: number; readonly search: number }; readonly evidence: number; readonly poolKeys: number };
  readonly candidates: {
    readonly releases: { readonly feed: number; readonly search: number };
    readonly evidence: number;
    readonly poolObjects: number;
    readonly objects: number;
    readonly bytes: number;
  };
  readonly deleted: { readonly objects: 0; readonly bytes: 0 };
  readonly remaining: number;
  readonly elapsedMs: number;
  readonly r2: { readonly classA: number; readonly classB: number };
}

/** The list the owner reviews before any deletion (`GET /retention/report`). */
export interface RetentionReport {
  readonly runId: string;
  readonly at: string;
  readonly pointers: RetentionLastRun["pointers"];
  readonly retained: readonly { readonly projection: Projection; readonly id: string; readonly reasons: readonly RetainReason[] }[];
  readonly candidates: {
    readonly releases: readonly { readonly projection: Projection; readonly id: string; readonly objects: number; readonly bytes: number }[];
    readonly evidence: readonly { readonly key: string; readonly bytes: number }[];
    readonly pool: { readonly objects: number; readonly bytes: number; readonly oldestUploaded: string | null; readonly newestUploaded: string | null; readonly sample: readonly string[] };
  };
  readonly truncated: { readonly retained: boolean; readonly releases: boolean; readonly evidence: boolean };
}

class BudgetSpent extends Error {}
class PointerError extends Error {}

/** Counts every R2 call and refuses one that would pass the run's budget. */
class Meter {
  classA = 0;
  classB = 0;
  constructor(private readonly started: number, private readonly now: () => number, private readonly limits: Required<NonNullable<RetentionRunDeps["limits"]>>) {}
  check(kind: "list" | "get"): void {
    if (this.now() - this.started >= this.limits.wallMs) throw new BudgetSpent("the 10-minute budget is spent");
    if (kind === "list" && this.classA >= this.limits.lists) throw new BudgetSpent(`the list budget (${this.limits.lists}) is spent`);
    if (kind === "get" && this.classB >= this.limits.gets) throw new BudgetSpent(`the get budget (${this.limits.gets}) is spent`);
    if (kind === "list") this.classA += 1;
    else this.classB += 1;
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** `retention-<UTC date>` (Behavior 9). */
export const retentionRunId = (now: number) => `retention-${new Date(now).toISOString().slice(0, 10)}`;

/** One dry run. Never throws: every error ends in the returned `lastRun`. */
export async function runRetentionDryRun(deps: RetentionRunDeps): Promise<{ readonly lastRun: RetentionLastRun; readonly report: RetentionReport | null }> {
  const started = deps.now();
  const meter = new Meter(started, deps.now, { lists: RETENTION_MAX_LISTS, gets: RETENTION_MAX_GETS, wallMs: RETENTION_WALL_MS, ...deps.limits });
  const base = {
    runId: retentionRunId(started),
    at: new Date(started).toISOString(),
    mode: "dry-run" as const,
    deleted: { objects: 0 as const, bytes: 0 as const },
  };
  let status: RetentionStatus = "ok";
  let failureKind: RetentionFailureKind | null = null;
  let error: string | null = null;
  const fail = (kind: RetentionFailureKind, cause: unknown) => {
    if (cause instanceof BudgetSpent) {
      if (status === "ok") status = "overrun";
      error ??= cause.message;
      return;
    }
    status = "failed";
    failureKind ??= kind;
    error ??= message(cause);
  };

  const getText = async (key: string): Promise<string | null> => {
    meter.check("get");
    const object = await deps.bucket.get(key);
    return object === null ? null : object.text();
  };
  /** Lists a prefix page by page; `visit` sees each page. Returns whether the listing finished. */
  const listAll = async (prefix: string, visit: (objects: readonly RetentionListedObject[]) => void): Promise<boolean> => {
    let cursor: string | undefined;
    for (;;) {
      meter.check("list");
      const page = await deps.bucket.list({ prefix, limit: LIST_LIMIT, ...(cursor === undefined ? {} : { cursor }) });
      visit(page.objects);
      if (!page.truncated || page.cursor === undefined) return true;
      cursor = page.cursor;
    }
  };

  // 1. Pointers (Behavior 3), read before anything is listed.
  let pins: Pins;
  try {
    const feed = await readPointer(getText, "public/v2/current.json", "releaseId");
    const search = await readPointer(getText, "public/search/v1/current.json", "indexRevision");
    const digest: string[] = [];
    for (const projectId of deps.digestProjectIds) {
      const text = await getText(`public/digest/v1/${projectId}/current.json`);
      if (text === null) continue;
      const pointer = JSON.parse(text) as { schema?: unknown; sourceReleaseId?: unknown };
      if (pointer.schema !== "osskb.digest-pointer.v1" || typeof pointer.sourceReleaseId !== "string") throw new PointerError(`digest pointer of ${projectId} is invalid`);
      digest.push(pointer.sourceReleaseId);
    }
    pins = { feed, search, digest, embedding: await deps.embeddingReleaseId() };
  } catch (cause) {
    // RT10: nothing is listed, nothing is reported as a candidate.
    fail("pointer-read", cause);
    return { lastRun: summary(base, { status, failureKind, error, started, now: deps.now(), meter, pointers: { feed: null, search: null } }), report: null };
  }

  // 2. Evidence: list, then read each retained set one at a time (Behavior 4, Spec 009).
  const now = started;
  const listedEvidence: ListedEvidence[] = [];
  let evidenceListed = false;
  try {
    evidenceListed = await listAll(EVIDENCE_PREFIX, (objects) => {
      for (const object of objects) listedEvidence.push({ setId: object.key.slice(EVIDENCE_PREFIX.length).replace(/\.json$/u, ""), key: object.key, bytes: object.size });
    });
  } catch (cause) { fail("list", cause); }

  const marked = new Set<string>();
  const readSets: ReadEvidence[] = [];
  let markComplete = evidenceListed;
  let evidenceMissing = false;
  const { read, kept } = evidenceListed ? retainedEvidence(listedEvidence, pins, now) : { read: [], kept: new Set<string>() };
  let readsFinished = true;
  for (const item of read) {
    try {
      const text = await getText(item.key);
      const set = text === null ? null : JSON.parse(text) as { schema?: unknown; projections?: readonly { kind?: unknown; releaseId?: unknown; immutableObjects?: readonly { key: string }[] }[] };
      const feed = set?.projections?.find((projection) => projection.kind === "feed");
      const search = set?.projections?.find((projection) => projection.kind === "search");
      if (set?.schema !== "osskb.publication-set.v1" || typeof feed?.releaseId !== "string" || typeof search?.releaseId !== "string") {
        evidenceMissing = true;
        continue;
      }
      for (const key of [...poolKeysOf(feed.immutableObjects ?? []), ...poolKeysOf(search.immutableObjects ?? [])]) marked.add(key);
      readSets.push({ setId: item.setId, reason: item.reason, feed: feed.releaseId, search: search.releaseId });
    } catch (cause) {
      readsFinished = false;
      markComplete = false;
      fail("internal", cause);
      if (cause instanceof BudgetSpent) break;
    }
  }
  // Behavior 4 / RT9: every pinned release needs evidence that names it; otherwise the mark is unsafe.
  const evidenced = new Set(readSets.flatMap((set) => [`feed:${set.feed}`, `search:${set.search}`]));
  const pinned = [`feed:${pins.feed}`, `search:${pins.search}`, ...pins.digest.map((id) => `feed:${id}`), ...(pins.embedding === null ? [] : [`search:${pins.embedding}`])];
  if (pinned.some((key) => !evidenced.has(key))) evidenceMissing = true;
  if (evidenceMissing) markComplete = false;

  // 3. Release prefixes, only when every retained set is known (a window release must never be
  // reported as a candidate because its evidence was not listed or read).
  const releaseSizes = new Map<string, { projection: Projection; id: string; objects: number; bytes: number }>();
  const releasesKnown = evidenceListed && readsFinished;
  let releasesListed = releasesKnown;
  for (const [projection, prefix] of releasesKnown ? [["feed", FEED_RELEASES_PREFIX], ["search", SEARCH_RELEASES_PREFIX]] as const : []) {
    try {
      const done = await listAll(prefix, (objects) => {
        for (const object of objects) {
          const id = object.key.slice(prefix.length).split("/")[0]!;
          const key = `${projection}:${id}`;
          const entry = releaseSizes.get(key) ?? { projection, id, objects: 0, bytes: 0 };
          entry.objects += 1;
          entry.bytes += object.size;
          releaseSizes.set(key, entry);
        }
      });
      releasesListed &&= done;
    } catch (cause) {
      releasesListed = false;
      fail("list", cause);
    }
  }
  const keptTokens = new Map(read.map((item) => [idToken(item.setId)!, item.reason] as const));
  const classified = classifyReleases([...releaseSizes.values()], pins, readSets, now, keptTokens);
  const candidateReleases = classified.candidates.map((release) => releaseSizes.get(`${release.projection}:${release.id}`)!);
  // O3: a set goes with its releases; one sharing a retained release's time token is kept.
  const retainedTokens = new Set([...classified.retained.keys()].map((key) => idToken(key)).filter((token) => token !== null));
  const candidateEvidence = releasesKnown
    ? listedEvidence.filter((item) => !kept.has(item.key) && !retainedTokens.has(idToken(item.setId)!))
    : [];

  // 4. Pools: only after a complete mark (RT9: fail closed).
  const pool = { objects: 0, bytes: 0, oldest: Number.POSITIVE_INFINITY, newest: Number.NEGATIVE_INFINITY, sample: [] as string[] };
  let poolListed = false;
  if (markComplete && (status as RetentionStatus) !== "overrun") {
    for (const prefix of [FEED_POOL_PREFIX, SEARCH_POOL_PREFIX]) {
      try {
        const done = await listAll(prefix, (objects) => {
          for (const object of objects) {
            const uploaded = object.uploaded.getTime();
            if (!poolCandidate(object.key, uploaded, marked, now)) continue;
            pool.objects += 1;
            pool.bytes += object.size;
            pool.oldest = Math.min(pool.oldest, uploaded);
            pool.newest = Math.max(pool.newest, uploaded);
            if (pool.sample.length < REPORT_POOL_SAMPLE) pool.sample.push(object.key);
          }
        });
        poolListed = prefix === FEED_POOL_PREFIX ? done : poolListed && done;
      } catch (cause) {
        poolListed = false;
        fail("list", cause);
        if (cause instanceof BudgetSpent) break;
      }
    }
  }

  const releaseObjects = candidateReleases.reduce((sum, release) => sum + release.objects, 0);
  const releaseBytes = candidateReleases.reduce((sum, release) => sum + release.bytes, 0);
  const evidenceBytes = candidateEvidence.reduce((sum, item) => sum + item.bytes, 0);
  const objects = releaseObjects + candidateEvidence.length + pool.objects;
  const count = (projection: Projection, keys: Iterable<string>) => [...keys].filter((key) => key.startsWith(`${projection}:`)).length;
  const lastRun: RetentionLastRun = {
    ...summary(base, { status, failureKind, error, started, now: deps.now(), meter, pointers: { feed: pins.feed, search: pins.search } }),
    reason: evidenceMissing ? "evidence-missing" : null,
    complete: { releases: releasesListed, evidence: evidenceListed, pool: poolListed },
    retained: {
      releases: { feed: count("feed", classified.retained.keys()), search: count("search", classified.retained.keys()) },
      evidence: kept.size,
      poolKeys: marked.size,
    },
    candidates: {
      releases: { feed: candidateReleases.filter((r) => r.projection === "feed").length, search: candidateReleases.filter((r) => r.projection === "search").length },
      evidence: candidateEvidence.length,
      poolObjects: pool.objects,
      objects,
      bytes: releaseBytes + evidenceBytes + pool.bytes,
    },
    remaining: objects,
  };
  const retainedList = [...classified.retained].map(([key, reasons]) => {
    const [projection, ...rest] = key.split(":");
    return { projection: projection as Projection, id: rest.join(":"), reasons };
  });
  const report: RetentionReport = {
    runId: base.runId,
    at: base.at,
    pointers: lastRun.pointers,
    retained: retainedList.slice(0, REPORT_LIST_CAP),
    candidates: {
      releases: candidateReleases.slice(0, REPORT_LIST_CAP),
      evidence: candidateEvidence.slice(0, REPORT_LIST_CAP).map((item) => ({ key: item.key, bytes: item.bytes })),
      pool: {
        objects: pool.objects,
        bytes: pool.bytes,
        oldestUploaded: pool.objects === 0 ? null : new Date(pool.oldest).toISOString(),
        newestUploaded: pool.objects === 0 ? null : new Date(pool.newest).toISOString(),
        sample: pool.sample,
      },
    },
    truncated: { retained: retainedList.length > REPORT_LIST_CAP, releases: candidateReleases.length > REPORT_LIST_CAP, evidence: candidateEvidence.length > REPORT_LIST_CAP },
  };
  return { lastRun, report };
}

async function readPointer(getText: (key: string) => Promise<string | null>, key: string, field: "releaseId" | "indexRevision"): Promise<string> {
  const text = await getText(key);
  if (text === null) throw new PointerError(`${key} is missing`);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new PointerError(`${key} is not JSON`); }
  const id = (value as Record<string, unknown> | null)?.[field];
  if (typeof id !== "string" || !/^[A-Za-z0-9._-]+$/u.test(id)) throw new PointerError(`${key} has no valid ${field}`);
  return id;
}

function summary(
  base: { readonly runId: string; readonly at: string; readonly mode: "dry-run"; readonly deleted: { readonly objects: 0; readonly bytes: 0 } },
  input: { status: RetentionStatus; failureKind: RetentionFailureKind | null; error: string | null; started: number; now: number; meter: Meter; pointers: RetentionLastRun["pointers"] },
): RetentionLastRun {
  return {
    ...base,
    status: input.status === "ok" && input.failureKind !== null ? "failed" : input.status,
    reason: null,
    failureKind: input.failureKind,
    error: input.error,
    complete: { releases: false, evidence: false, pool: false },
    pointers: input.pointers,
    retained: { releases: { feed: 0, search: 0 }, evidence: 0, poolKeys: 0 },
    candidates: { releases: { feed: 0, search: 0 }, evidence: 0, poolObjects: 0, objects: 0, bytes: 0 },
    remaining: 0,
    elapsedMs: input.now - input.started,
    r2: { classA: input.meter.classA, classB: input.meter.classB },
  };
}
