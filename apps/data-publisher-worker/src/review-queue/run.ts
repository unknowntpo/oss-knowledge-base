/**
 * Spec 015 slice 2: one review-queue run (ADR-0016). Reads open PRs from GitHub, KIP candidates
 * from the pinned Feed release and their full threads from Pony Mail, the roster through its
 * adapter; builds the queue with the slice 1 core; writes the content object, then the pointer
 * (conditional), and always `last-run.json`. A failed source keeps the previous section.
 */
import { MANIFEST_KEY, isFeedManifest } from "@oss-knowledge-base/serving-contract";
import {
  buildKipRows,
  buildPrQueue,
  checkStoredCounts,
  feedLink,
  kipCandidates,
  memberKey,
  parsePonyThread,
  parseVoteLines,
  RosterError,
  reviewQueueCounts,
  sha256,
  tallyText,
  threadUrl,
  voteRule,
  VOTE_REGEX_VERSION,
  type FeedMailEntry,
  type PrQueue,
  type ReviewProfile,
  type ReviewQueueCounts,
  type Roster,
  type RosterAdapter,
  ThreadParseError,
  type ThreadMessage,
  type VoteLines,
} from "@oss-knowledge-base/reference-pipeline";
import {
  emailUrlFor,
  fetchOpenPrs,
  newCounter,
  PoliteJsonClient,
  SourceError,
  threadUrlFor,
  type Counter,
  type Delay,
  type FetchLike,
  type SourceFailureKind,
} from "./fetchers";
import {
  reviewQueueLastRunKey,
  reviewQueuePointerKey,
  reviewQueuePrefix,
  rosterKey,
  type ReviewQueueBucket,
} from "./store";

export const REVIEW_QUEUE_SCHEMA = "osskb.review-queue.v1";
export const ROSTER_MAX_AGE_MS = 24 * 3_600_000;

type MailFailureKind = SourceFailureKind | "pointer-missing" | "source-read";

export interface SourceStatus {
  readonly ok: boolean;
  readonly fetchedAt: string | null;
  readonly failureKind?: string;
}

export interface KipRowOut {
  readonly key: string;
  readonly displayId: string;
  readonly title: string;
  readonly threadUrl: string;
  readonly feedLink: string;
  readonly rootAt: string;
  readonly rootArchived: boolean;
  readonly lastReplyAt: string | null;
  readonly repliers: number;
  readonly waitDays: number;
  readonly queued: boolean;
  readonly fetchedAt: string;
  readonly tally?: Readonly<Record<string, unknown>> & { readonly text: string; readonly state: string };
}

export interface ReviewQueueObject {
  readonly schema: typeof REVIEW_QUEUE_SCHEMA;
  readonly projectId: string;
  readonly generatedAt: string;
  readonly profile: { readonly reviewWaitDays: number; readonly fewRepliers: number; readonly votes: ReviewProfile["governance"]["votes"] };
  readonly roster: { readonly adapter: string; readonly fetchedAt: string; readonly entries: number } | null;
  readonly sources: { readonly github: SourceStatus; readonly mail: SourceStatus | null };
  readonly prs: { readonly noReviewer: PrQueue["noReviewer"]; readonly waiting: PrQueue["waiting"]; readonly approved: PrQueue["approved"] };
  readonly reviewState: PrQueue["reviewState"];
  readonly kips: { readonly vote: readonly KipRowOut[]; readonly discuss: readonly KipRowOut[]; readonly unavailable: number };
  readonly voteLines: { readonly regexVersion: number; readonly byMid: Readonly<Record<string, VoteLines>> };
  readonly droppedNodes: number;
  readonly counts: ReviewQueueCounts;
}

export interface SourceRun {
  readonly ok: boolean;
  readonly requests: number;
  readonly bytes: number;
  readonly durationMs: number;
  readonly failureKind?: string;
}

export interface ReviewQueueLastRun {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly objectKey: string | null;
  readonly pointerUpdated: boolean;
  readonly sources: { readonly github: SourceRun; readonly mail: SourceRun | null; readonly roster: SourceRun & { readonly fetchedAt: string | null } };
  readonly droppedNodes: number;
  readonly unavailable: number;
  readonly counts: ReviewQueueCounts | null;
  readonly failureKind?: "write" | "pointer-conflict" | "counts-mismatch" | "internal";
  readonly error?: string;
}

export interface ReviewQueueDeps {
  readonly bucket: ReviewQueueBucket;
  readonly profile: ReviewProfile;
  readonly githubToken: string;
  readonly githubFetch: FetchLike;
  readonly apacheFetch: FetchLike;
  readonly rosterAdapter: RosterAdapter | null;
  readonly now: () => number;
  readonly delay: Delay;
  readonly dryRun?: boolean;
}

function failureKindOf(error: unknown): SourceFailureKind | "internal" {
  return error instanceof SourceError ? error.failureKind : "internal";
}

/** Behavior 22 / Q52: reuse a roster younger than 24 h; on a failed refresh keep the stored one. */
export async function loadRoster(input: {
  readonly bucket: ReviewQueueBucket;
  readonly adapter: RosterAdapter;
  readonly project: string;
  readonly client: PoliteJsonClient;
  readonly now: number;
  /** A dry run reads but never writes, the roster cache included. */
  readonly dryRun?: boolean;
}): Promise<{ readonly roster: Roster | null; readonly refreshed: boolean; readonly failureKind?: string }> {
  const key = rosterKey(input.adapter.id, input.project);
  const stored = await input.bucket.getJson(key) as Roster | undefined;
  if (stored !== undefined && input.now - Date.parse(stored.fetchedAt) < ROSTER_MAX_AGE_MS) return { roster: stored, refreshed: false };
  try {
    const bodies = [];
    for (const url of input.adapter.sources(input.project)) bodies.push(await input.client.getJson(url, "roster"));
    const roster = input.adapter.parse(bodies, input.project, new Date(input.now).toISOString());
    if (input.dryRun !== true) await input.bucket.put(key, JSON.stringify(roster));
    return { roster, refreshed: true };
  } catch (error) {
    if (!(error instanceof SourceError) && !(error instanceof RosterError)) throw error;
    return { roster: stored ?? null, refreshed: false, failureKind: error instanceof SourceError ? error.failureKind : "schema" };
  }
}

interface IndexEntry {
  readonly displayId?: string;
  readonly projectKey?: string;
  readonly lastActivityAt?: string;
  readonly entry?: { readonly title?: string; readonly recordIds?: readonly string[] };
}

class MailSourceError extends Error {
  constructor(readonly failureKind: MailFailureKind, message: string) {
    super(message);
  }
}

/** Behavior 8: the pinned release's dev@ entries, each with one retained message id. */
export async function readMailEntries(bucket: ReviewQueueBucket, projectKey: string): Promise<{
  readonly releaseId: string;
  readonly entries: readonly FeedMailEntry[];
  readonly mids: ReadonlyMap<string, string>;
}> {
  const manifest = await bucket.getJson(MANIFEST_KEY);
  if (manifest === undefined) throw new MailSourceError("pointer-missing", "Feed pointer is missing");
  if (!isFeedManifest(manifest)) throw new MailSourceError("source-read", "Feed manifest is malformed");
  const index = await bucket.getJson(manifest.feedIndexKey) as { entries?: IndexEntry[] } | undefined;
  if (!Array.isArray(index?.entries)) throw new MailSourceError("source-read", `Feed index of ${manifest.releaseId} is missing`);
  const entries: FeedMailEntry[] = [];
  const mids = new Map<string, string>();
  const prefix = `${projectKey}:mail:`;
  for (const item of index.entries) {
    if (item.projectKey !== projectKey || typeof item.displayId !== "string" || typeof item.entry?.title !== "string") continue;
    const record = item.entry.recordIds?.find((id) => id.startsWith(prefix));
    if (record === undefined) continue;
    entries.push({ displayId: item.displayId, title: item.entry.title, lastActivityAt: item.lastActivityAt ?? "" });
    mids.set(item.displayId, record.slice(record.lastIndexOf(":") + 1));
  }
  return { releaseId: manifest.releaseId, entries, mids };
}

function previousObject(value: unknown, projectId: string): ReviewQueueObject | undefined {
  const object = value as ReviewQueueObject | undefined;
  return object?.schema === REVIEW_QUEUE_SCHEMA && object.projectId === projectId ? object : undefined;
}

async function buildMailSection(deps: ReviewQueueDeps, client: PoliteJsonClient, previous: ReviewQueueObject | undefined, nowIso: string, rosterResult: { roster: Roster | null }) {
  const { profile } = deps;
  const release = await readMailEntries(deps.bucket, profile.projectKey);
  const cache = previous?.voteLines.regexVersion === VOTE_REGEX_VERSION ? previous.voteLines.byMid : {};
  const byMid: Record<string, VoteLines> = {};
  const threads = new Map<string, ThreadMessage[]>();
  const { candidates } = kipCandidates(release.entries, profile);
  for (const candidate of candidates) {
    const mid = release.mids.get(candidate.displayId);
    if (mid === undefined) continue;
    let messages: ThreadMessage[];
    try {
      messages = parsePonyThread(await client.getJson(threadUrlFor(mid), "Pony Mail thread"));
    } catch (error) {
      if (!(error instanceof SourceError) && !(error instanceof ThreadParseError)) throw error;
      continue; // Q25: unavailable; a previous row is reused below
    }
    if (candidate.stage === "vote") {
      const key = memberKey(candidate.title);
      const read: ThreadMessage[] = [];
      for (const message of messages) {
        if (memberKey(message.subject) !== key) {
          read.push(message);
          continue;
        }
        const cached = Object.hasOwn(cache, message.mid) ? cache[message.mid] : undefined;
        if (cached !== undefined) {
          byMid[message.mid] = cached;
          read.push({ ...message, lines: cached });
          continue;
        }
        try {
          const email = await client.getJson(emailUrlFor(message.mid), "Pony Mail email") as { body?: unknown };
          if (typeof email?.body !== "string") throw new SourceError("schema", "Pony Mail email has no body");
          const lines = parseVoteLines(email.body);
          byMid[message.mid] = lines;
          read.push({ ...message, lines });
        } catch (error) {
          if (!(error instanceof SourceError)) throw error;
          read.push(message); // Q26: unread; the tally says "seen"
        }
      }
      messages = read;
    }
    threads.set(candidate.displayId, messages);
  }
  // Every thread failed (Pony Mail down): the source failed, so the previous section is kept (Q43).
  if (candidates.length > 0 && threads.size === 0) throw new MailSourceError("transport", "no candidate thread could be read");
  const rows = buildKipRows({ entries: release.entries, threads, roster: rosterResult.roster, profile, now: nowIso });
  const quorum = voteRule(profile, "proposal")?.quorum ?? 0;
  const out = (row: (typeof rows.vote)[number] | (typeof rows.discuss)[number], tally?: (typeof rows.vote)[number]["tally"]): KipRowOut => ({
    key: row.key, displayId: row.displayId, title: row.title, threadUrl: threadUrl(row.rootMid), feedLink: feedLink(row.displayId),
    rootAt: row.stats.openedAt, rootArchived: row.stats.rootArchived, lastReplyAt: row.stats.lastReplyAt,
    repliers: row.stats.repliers, waitDays: row.waitDays, queued: row.queued, fetchedAt: nowIso,
    ...(tally === undefined ? {} : { tally: { ...tally, text: tallyText(tally, quorum) } }),
  });
  const vote = rows.vote.map((row) => out(row, row.tally));
  const discuss = rows.discuss.map((row) => out(row));
  // Q25: a candidate whose thread failed keeps its previous row (with its fetchedAt); otherwise it is unavailable.
  const built = new Set([...vote, ...discuss].map((row) => row.displayId));
  let unavailable = 0;
  for (const candidate of candidates) {
    if (built.has(candidate.displayId)) continue;
    const list = candidate.stage === "vote" ? previous?.kips.vote : previous?.kips.discuss;
    const kept = list?.find((row) => row.displayId === candidate.displayId);
    if (kept === undefined) unavailable += 1;
    else (candidate.stage === "vote" ? vote : discuss).push(kept);
  }
  return { kips: { vote, discuss, unavailable }, voteLines: { regexVersion: VOTE_REGEX_VERSION, byMid } };
}

/** One run. Returns the run record (also written to `last-run.json` unless dry) and the object. */
export async function runReviewQueue(deps: ReviewQueueDeps): Promise<{ readonly lastRun: ReviewQueueLastRun; readonly object: ReviewQueueObject | null }> {
  const { profile, bucket } = deps;
  const startedMs = deps.now();
  const startedAt = new Date(startedMs).toISOString();
  const githubCounter: Counter = newCounter();
  const mailCounter: Counter = newCounter();
  const rosterCounter: Counter = newCounter();
  const client = new PoliteJsonClient({ fetchImpl: deps.apacheFetch, delay: deps.delay, now: deps.now, counter: mailCounter });
  const rosterClient = new PoliteJsonClient({ fetchImpl: deps.apacheFetch, delay: deps.delay, now: deps.now, counter: rosterCounter });
  let object: ReviewQueueObject | null = null;
  let objectKey: string | null = null;
  let pointerUpdated = false;
  let failure: Pick<ReviewQueueLastRun, "failureKind" | "error"> = {};
  let githubRun: SourceRun = { ok: false, requests: 0, bytes: 0, durationMs: 0 };
  let mailRun: SourceRun | null = null;
  let rosterRun: SourceRun & { fetchedAt: string | null } = { ok: false, requests: 0, bytes: 0, durationMs: 0, fetchedAt: null };
  try {
    const pointer = await bucket.getWithEtag(reviewQueuePointerKey(profile.projectId));
    const pointerValue = pointer?.value as { objectKey?: unknown } | undefined;
    const previous = typeof pointerValue?.objectKey === "string"
      ? previousObject(await bucket.getJson(pointerValue.objectKey), profile.projectId)
      : undefined;
    const nowIso = startedAt;

    // GitHub (Behavior 1–7)
    let prs: ReviewQueueObject["prs"] = previous?.prs ?? { noReviewer: [], waiting: [], approved: [] };
    let reviewState: ReviewQueueObject["reviewState"] = previous?.reviewState ?? {};
    let githubStatus: SourceStatus = { ok: false, fetchedAt: previous?.sources.github.fetchedAt ?? null };
    let droppedNodes = 0;
    const githubStarted = deps.now();
    try {
      const snapshot = await fetchOpenPrs({
        token: deps.githubToken, owner: profile.github.owner, repo: profile.github.repo,
        fetchImpl: deps.githubFetch, delay: deps.delay, counter: githubCounter,
      });
      const queue = buildPrQueue(snapshot.nodes, nowIso, profile);
      prs = { noReviewer: queue.noReviewer, waiting: queue.waiting, approved: queue.approved };
      reviewState = queue.reviewState;
      droppedNodes = snapshot.droppedNodes;
      githubStatus = { ok: true, fetchedAt: nowIso };
      githubRun = { ok: true, ...githubCounter, durationMs: deps.now() - githubStarted };
    } catch (error) {
      const kind = failureKindOf(error);
      if (kind === "internal") throw error;
      githubStatus = { ...githubStatus, failureKind: kind };
      githubRun = { ok: false, ...githubCounter, durationMs: deps.now() - githubStarted, failureKind: kind };
    }

    // Roster and mail (Behavior 8–13, 22)
    let rosterResult: { roster: Roster | null } = { roster: null };
    let kips: ReviewQueueObject["kips"] = previous?.kips ?? { vote: [], discuss: [], unavailable: 0 };
    let voteLines: ReviewQueueObject["voteLines"] = previous?.voteLines ?? { regexVersion: VOTE_REGEX_VERSION, byMid: {} };
    let mailStatus: SourceStatus | null = null;
    if (profile.proposal.kind !== null && profile.mail !== null) {
      if (deps.rosterAdapter !== null && profile.governance.roster !== null) {
        const rosterStarted = deps.now();
        const loaded = await loadRoster({ bucket, adapter: deps.rosterAdapter, project: profile.governance.roster.project, client: rosterClient, now: deps.now(), ...(deps.dryRun === true ? { dryRun: true } : {}) });
        rosterResult = loaded;
        rosterRun = {
          ok: loaded.roster !== null && loaded.failureKind === undefined, ...rosterCounter, durationMs: deps.now() - rosterStarted, fetchedAt: loaded.roster?.fetchedAt ?? null,
          ...(loaded.failureKind === undefined ? {} : { failureKind: loaded.failureKind }),
        };
      }
      const mailStarted = deps.now();
      try {
        const section = await buildMailSection(deps, client, previous, nowIso, rosterResult);
        kips = section.kips;
        voteLines = section.voteLines;
        mailStatus = { ok: true, fetchedAt: nowIso };
        mailRun = { ok: true, ...mailCounter, durationMs: deps.now() - mailStarted };
      } catch (error) {
        if (!(error instanceof MailSourceError)) throw error;
        mailStatus = { ok: false, fetchedAt: previous?.sources.mail?.fetchedAt ?? null, failureKind: error.failureKind };
        mailRun = { ok: false, ...mailCounter, durationMs: deps.now() - mailStarted, failureKind: error.failureKind };
      }
    }

    const counts = reviewQueueCounts({ prs, kips });
    object = {
      schema: REVIEW_QUEUE_SCHEMA,
      projectId: profile.projectId,
      generatedAt: nowIso,
      profile: { reviewWaitDays: profile.reviewWaitDays, fewRepliers: profile.fewRepliers, votes: profile.governance.votes },
      roster: rosterResult.roster === null ? null : { adapter: rosterResult.roster.adapter, fetchedAt: rosterResult.roster.fetchedAt, entries: rosterResult.roster.entries.length },
      sources: { github: githubStatus, mail: mailStatus },
      prs, reviewState, kips, voteLines, droppedNodes, counts,
    };
    if (!checkStoredCounts(object, object.counts)) {
      failure = { failureKind: "counts-mismatch" };
      object = null;
    } else if (deps.dryRun !== true) {
      const body = JSON.stringify(object);
      objectKey = `${reviewQueuePrefix(profile.projectId)}${sha256(body)}.json`;
      try {
        await bucket.putIfAbsent(objectKey, body);
      } catch (error) {
        failure = { failureKind: "write", error: error instanceof Error ? error.message : String(error) };
        objectKey = null;
      }
      if (objectKey !== null) {
        pointerUpdated = await bucket.putPointerIfMatch(
          reviewQueuePointerKey(profile.projectId),
          JSON.stringify({ schema: "osskb.review-queue-pointer.v1", objectKey, generatedAt: nowIso }),
          pointer?.etag ?? null,
        );
        if (!pointerUpdated) failure = { failureKind: "pointer-conflict" }; // Q32: a newer run wrote; no retry
      }
    }
  } catch (error) {
    failure = { failureKind: "internal", error: error instanceof Error ? error.message : String(error) };
  }
  const completedMs = deps.now();
  const lastRun: ReviewQueueLastRun = {
    ok: failure.failureKind === undefined && (githubRun.ok || mailRun?.ok === true),
    dryRun: deps.dryRun === true,
    startedAt,
    completedAt: new Date(completedMs).toISOString(),
    durationMs: completedMs - startedMs,
    objectKey: pointerUpdated ? objectKey : null,
    pointerUpdated,
    sources: { github: githubRun, mail: mailRun, roster: rosterRun },
    droppedNodes: object?.droppedNodes ?? 0,
    unavailable: object?.kips.unavailable ?? 0,
    counts: object?.counts ?? null,
    ...failure,
  };
  if (deps.dryRun !== true) await bucket.put(reviewQueueLastRunKey(profile.projectId), JSON.stringify(lastRun));
  return { lastRun, object };
}
