/** Spec 014 stage 1: candidates, machine authors, and the thread score (Behavior 1–3). */
import type { DigestDetail, DigestEntry, DigestProfile, DigestRecord, DigestSource, Thread } from "./types";

const DAY_MS = 86_400_000;
export const DIGEST_WINDOW_DAYS = 7;
export const HALF_LIFE_DAYS = 3.5;
export const SCORING_REVISION = "digest-score@1";
/** Spec 012 stores this author when a mail sender has no display name. */
export const ANONYMOUS_AUTHOR = "unknown sender";

/** Behavior 2: a `[bot]` login or a profile machine user; never a substring match. */
export function isMachineAuthor(author: string, profile: DigestProfile): boolean {
  return author.endsWith("[bot]") || profile.machineUsers.includes(author);
}

export function digestWindowStart(windowEnd: string): string {
  return new Date(Date.parse(windowEnd) - DIGEST_WINDOW_DAYS * DAY_MS).toISOString();
}

function inWindow(at: string, windowEnd: string): boolean {
  const time = Date.parse(at);
  return time >= Date.parse(digestWindowStart(windowEnd)) && time <= Date.parse(windowEnd);
}

/** Behavior 3: Σ 0.5^(ageDays / 3.5) / k, k counting each author's records in time order. */
export function threadScore(records: readonly Pick<DigestRecord, "id" | "author" | "occurredAt">[], windowEnd: string): number {
  const end = Date.parse(windowEnd);
  const perAuthor = new Map<string, number>();
  let score = 0;
  const ordered = [...records].sort((a, b) =>
    Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const record of ordered) {
    const k = (perAuthor.get(record.author) ?? 0) + 1;
    perAuthor.set(record.author, k);
    score += 0.5 ** ((end - Date.parse(record.occurredAt)) / DAY_MS / HALF_LIFE_DAYS) / k;
  }
  return score;
}

function threadSource(entry: DigestEntry): DigestSource {
  const keys = Object.keys(entry.sourceCounts);
  return (keys.length === 1 ? keys[0] : "github") as DigestSource;
}

/** Behavior 1: entries with at least one in-window human record; only those records count. */
export function selectCandidates(
  entries: readonly DigestEntry[],
  details: Readonly<Record<string, DigestDetail>>,
  profile: DigestProfile,
  windowEnd: string,
): Thread[] {
  const start = digestWindowStart(windowEnd);
  const threads: Thread[] = [];
  for (const entry of entries) {
    if (entry.projectKey !== profile.projectKey || entry.lastActivityAt < start) continue;
    const detail = details[entry.displayId];
    if (detail === undefined) continue;
    const records = detail.records
      .filter((record) => !isMachineAuthor(record.author, profile) && inWindow(record.occurredAt, windowEnd))
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || (a.id < b.id ? -1 : 1));
    if (records.length === 0) continue;
    // The root artifact (issue, PR, Jira issue, first message) when retained, else the oldest human
    // record: a bot comment is never the excerpt the reader or the model sees.
    const byTime = [...detail.records].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    const root = byTime.find((record) => !record.id.includes(":comment:") && !isMachineAuthor(record.author, profile))
      ?? byTime.find((record) => !isMachineAuthor(record.author, profile))
      ?? byTime[0];
    const source = threadSource(entry);
    threads.push({
      displayId: entry.displayId,
      entryId: entry.id,
      title: detail.title,
      source,
      status: entry.status,
      url: entry.links?.[source] ?? root?.canonicalUrl ?? null,
      rootExcerpt: root?.excerpt ?? "",
      records,
      score: threadScore(records, windowEnd),
      lastActivityAt: records[records.length - 1]!.occurredAt,
    });
  }
  return threads.sort(byScore);
}

/** Score descending, ties by display id ascending. */
export function byScore(a: { score: number; displayId: string }, b: { score: number; displayId: string }): number {
  return b.score - a.score || (a.displayId < b.displayId ? -1 : a.displayId > b.displayId ? 1 : 0);
}

/** Behavior 18: newest `lastActivityAt` of single-source entries, per source; lagging before window start. */
export function sourceCoverage(
  entries: readonly DigestEntry[],
  profile: DigestProfile,
  windowEnd: string,
): Record<string, { newestAt: string | null; lagging: boolean }> {
  const start = Date.parse(digestWindowStart(windowEnd));
  const coverage: Record<string, { newestAt: string | null; lagging: boolean }> = {};
  for (const source of profile.sources) {
    let newest: string | null = null;
    for (const entry of entries) {
      const keys = Object.keys(entry.sourceCounts);
      if (entry.projectKey !== profile.projectKey || keys.length !== 1 || keys[0] !== source) continue;
      if (newest === null || Date.parse(entry.lastActivityAt) > Date.parse(newest)) newest = entry.lastActivityAt;
    }
    coverage[source] = { newestAt: newest, lagging: newest === null || Date.parse(newest) < start };
  }
  return coverage;
}
