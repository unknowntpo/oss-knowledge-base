/**
 * Spec 029: the retained-set rules, free of Workers types. Pure functions over what the run listed
 * and read; nothing here touches R2. The dry-run slice has no delete path: `enforce` resolves to
 * `unconfigured` until the slice that adds deletion.
 */

/** O1: every verified release of the last 30 days is kept. A change is a spec change. */
export const RETENTION_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** O1: the newest verified releases kept whatever their age; below 2 is rejected (Behavior 3). */
export const RETENTION_FLOOR = 2;
/** Behavior 3, 5: anything younger than this is kept (a crashed attempt's retry reuses it). */
export const RETENTION_GRACE_MS = 48 * 60 * 60_000;

export const FEED_RELEASES_PREFIX = "public/v2/releases/";
export const SEARCH_RELEASES_PREFIX = "public/search/v1/releases/";
export const EVIDENCE_PREFIX = "publication-sets/v1/";
export const FEED_POOL_PREFIX = "public/v2/objects/details/";
export const SEARCH_POOL_PREFIX = "public/search/v1/objects/details/";

export type RetentionMode = "off" | "dry-run" | "unconfigured";

/**
 * Behavior 1 (dry-run slice): unset, blank or `off` is off; `dry-run` lists and reports; anything
 * else, `enforce` included, is unconfigured with a reason, because this slice cannot delete.
 */
export function resolveRetentionMode(flag: string | undefined): { readonly mode: RetentionMode; readonly reason: string | null } {
  const value = flag?.trim() ?? "";
  if (value === "" || value === "off") return { mode: "off", reason: null };
  if (value === "dry-run") return { mode: "dry-run", reason: null };
  if (value === "enforce") return { mode: "unconfigured", reason: "R2_RETENTION \"enforce\" is not available: this build has only the dry run (Spec 029)" };
  return { mode: "unconfigured", reason: `R2_RETENTION "${value.slice(0, 40)}" is not off or dry-run` };
}

/** Behavior 3: a floor below 2 would let the live or the previous release become a candidate. */
export function assertFloor(floor: number): number {
  if (!Number.isInteger(floor) || floor < 2) throw new Error(`retention floor must be ≥ 2, got ${floor}`);
  return floor;
}

const TIME = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/u;

/** The time a release or publication-set id names (`2026-10-20T22-07-19-086Z`), or null. */
export function idTime(id: string): number | null {
  const match = TIME.exec(id);
  if (match === null) return null;
  const time = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isNaN(time) ? null : time;
}

/** The time token shared by a publication set and its two releases (`github-T`, `T`, `feed-T`). */
export function idToken(id: string): string | null {
  return TIME.exec(id)?.[0] ?? null;
}

export type Projection = "feed" | "search";
export type RetainReason = "pointer" | "digest" | "embedding" | "window" | "floor" | "pinned" | "grace" | "unparsable";

export interface Pins {
  readonly feed: string;
  readonly search: string;
  /** Feed release ids the digest pointers name (`sourceReleaseId`). */
  readonly digest: readonly string[];
  /** The Search release the embedding job last read, or null. */
  readonly embedding: string | null;
}

export interface ListedEvidence {
  readonly setId: string;
  readonly key: string;
  readonly bytes: number;
}

/**
 * Behavior 3, first half: which publication sets are retained, so their evidence is read. In the
 * window, among the floor's newest, or sharing a pinned release's time token. A set id without a
 * time is retained (never a candidate) and not read.
 */
export function retainedEvidence(evidence: readonly ListedEvidence[], pins: Pins, now: number, floor = RETENTION_FLOOR): {
  readonly read: readonly (ListedEvidence & { readonly reason: EvidenceReason })[];
  readonly kept: ReadonlySet<string>;
} {
  assertFloor(floor);
  const pinTokens = new Set([pins.feed, pins.search, ...pins.digest, ...(pins.embedding === null ? [] : [pins.embedding])]
    .map(idToken).filter((token): token is string => token !== null));
  const timed = evidence.filter((item) => idTime(item.setId) !== null)
    .sort((a, b) => idTime(b.setId)! - idTime(a.setId)!);
  const newest = new Set(timed.slice(0, floor).map((item) => item.key));
  const reasonOf = (item: ListedEvidence): EvidenceReason | null =>
    idTime(item.setId)! > now - RETENTION_WINDOW_MS ? "window"
      : newest.has(item.key) ? "floor"
      : pinTokens.has(idToken(item.setId)!) ? "pinned" : null;
  const read = timed.flatMap((item) => {
    const reason = reasonOf(item);
    return reason === null ? [] : [{ ...item, reason }];
  });
  const kept = new Set([...read.map((item) => item.key), ...evidence.filter((item) => idTime(item.setId) === null).map((item) => item.key)]);
  return { read, kept };
}

export type EvidenceReason = "window" | "floor" | "pinned";

export interface ReadEvidence {
  readonly setId: string;
  readonly reason: EvidenceReason;
  readonly feed: string;
  readonly search: string;
}

export interface ClassifiedReleases {
  /** `<projection>:<id>` → why it is kept. */
  readonly retained: ReadonlyMap<string, readonly RetainReason[]>;
  readonly candidates: readonly { readonly projection: Projection; readonly id: string }[];
}

export const releaseKey = (projection: Projection, id: string) => `${projection}:${id}`;

/**
 * Behavior 3, second half: every listed release is retained or a candidate. Retained: the pointers,
 * the digest's and embedding job's pins, both releases of every read evidence, anything within the
 * grace period, and any id without a time. Everything else is a candidate, oldest first.
 */
export function classifyReleases(
  listed: readonly { readonly projection: Projection; readonly id: string }[],
  pins: Pins,
  evidence: readonly ReadEvidence[],
  now: number,
  /** Time tokens of every retained set, read or not: a release sharing one is kept even when its evidence could not be parsed. */
  keptTokens: ReadonlyMap<string, EvidenceReason> = new Map(),
): ClassifiedReleases {
  const retained = new Map<string, RetainReason[]>();
  const keep = (projection: Projection, id: string, reason: RetainReason) => {
    const key = releaseKey(projection, id);
    const reasons = retained.get(key) ?? [];
    if (!reasons.includes(reason)) reasons.push(reason);
    retained.set(key, reasons);
  };
  keep("feed", pins.feed, "pointer");
  keep("search", pins.search, "pointer");
  for (const id of pins.digest) keep("feed", id, "digest");
  if (pins.embedding !== null) keep("search", pins.embedding, "embedding");
  // Both releases of a read set are kept; a set read because it shares a pin's time token
  // ("pinned") keeps its sibling release too, since its pool keys are marked.
  for (const item of evidence) {
    keep("feed", item.feed, item.reason);
    keep("search", item.search, item.reason);
  }
  const candidates: { projection: Projection; id: string }[] = [];
  for (const release of listed) {
    const time = idTime(release.id);
    if (time === null) keep(release.projection, release.id, "unparsable");
    else if (time > now - RETENTION_GRACE_MS) keep(release.projection, release.id, "grace");
    else if (keptTokens.has(idToken(release.id)!)) keep(release.projection, release.id, keptTokens.get(idToken(release.id)!)!);
    else if (!retained.has(releaseKey(release.projection, release.id))) candidates.push(release);
  }
  candidates.sort((a, b) => idTime(a.id)! - idTime(b.id)! || a.projection.localeCompare(b.projection));
  return { retained, candidates };
}

/** Behavior 5: a pool object is a candidate when unmarked and uploaded longer ago than the grace period. */
export function poolCandidate(key: string, uploaded: number, marked: ReadonlySet<string>, now: number): boolean {
  return !marked.has(key) && uploaded < now - RETENTION_GRACE_MS;
}

/** Behavior 4: the pool keys an evidence object lists. */
export function poolKeysOf(immutableObjects: readonly { readonly key: string }[]): string[] {
  return immutableObjects.map((object) => object.key).filter((key) => key.startsWith(FEED_POOL_PREFIX) || key.startsWith(SEARCH_POOL_PREFIX));
}
