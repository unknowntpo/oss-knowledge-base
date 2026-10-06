/**
 * Spec 012 pure rules for the Kafka dev@ list and KAFKA Jira: key extraction, notification
 * filter, thread key, status, and poll windows. Connectors and the materializer share them.
 */
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
export const WINDOW_DAYS = 30;
const WINDOW_MINUTES = WINDOW_DAYS * 24 * 60;
const JIRA_OVERLAP_MINUTES = 10;

export interface ExtractedKeys {
  readonly kips: readonly string[];
  readonly issueKeys: readonly string[];
}

/** `\b(KIP|KAFKA)-(\d+)\b`, case-sensitive; sorted and unique. */
export function extractKeys(text: string): ExtractedKeys {
  const kips = new Set<string>();
  const issueKeys = new Set<string>();
  for (const match of text.matchAll(/\b(KIP|KAFKA)-(\d+)\b/gu)) {
    (match[1] === "KIP" ? kips : issueKeys).add(`${match[1]}-${match[2]}`);
  }
  return { kips: [...kips].sort(), issueKeys: [...issueKeys].sort() };
}

const REPLY_PREFIX = /^\s*(?:re|fwd?|fw|aw)\s*:\s*/iu;

/** The subject without leading reply and forward prefixes, whitespace collapsed. */
export function threadTitle(subject: string): string {
  let current = subject.replace(/\s+/gu, " ").trim();
  for (;;) {
    const next = current.replace(REPLY_PREFIX, "");
    if (next === current) return current;
    current = next;
  }
}

/** Messages with the same key form one thread (Behavior 3). */
export function threadKey(subject: string): string {
  return threadTitle(subject).toLowerCase();
}

/** Jira and GitHub notification mail duplicates a direct source (Behavior 2). */
export function isNotificationSubject(subject: string): boolean {
  return /^\[(?:jira|pr)\]/u.test(threadKey(subject));
}

/** Display name of a `From` value; the address is never kept. */
export function mailAuthor(from: string): string {
  const name = from.replace(/<[^>]*>/gu, "").replace(/["']/gu, "").replace(/\s+via\s+\S+\s*$/iu, "").trim();
  // A bare or obfuscated address (`o....@gmail.com`) is not a name.
  return name.length === 0 || name.includes("@") ? "unknown sender" : name;
}

export function jiraStatus(nativeStatus: string): "open" | "resolved" {
  return nativeStatus === "Resolved" || nativeStatus === "Closed" ? "resolved" : "open";
}

/** Jira `2026-09-29T20:24:00.702+0000` → `2026-09-29T20:24:00.702Z`; undefined when unparsable. */
export function jiraTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const iso = value.replace(/([+-]\d{2})(\d{2})$/u, "$1:$2");
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

export interface PollWindow {
  readonly size: number;
  readonly gapCapped: boolean;
}

function gapMs(cursor: string, now: string): number {
  return Date.parse(now) - Date.parse(cursor);
}

/** Pony Mail `d=lte=<days>d`: first run 30 days, then ceil(gap) + 1 days, at least 2, capped at 30. */
export function mailWindow(cursor: string | undefined, now: string): PollWindow {
  if (cursor === undefined) return { size: WINDOW_DAYS, gapCapped: false };
  const gap = gapMs(cursor, now);
  const days = Math.max(1, Math.ceil(gap / DAY_MS)) + 1;
  return { size: Math.min(WINDOW_DAYS, days), gapCapped: gap > WINDOW_DAYS * DAY_MS };
}

/** Jira `updated >= "-<minutes>m"`: first run 30 days, then ceil(gap) + 10 minutes, capped at 30 days. */
export function jiraWindow(cursor: string | undefined, now: string): PollWindow {
  if (cursor === undefined) return { size: WINDOW_MINUTES, gapCapped: false };
  const gap = gapMs(cursor, now);
  const minutes = Math.max(0, Math.ceil(gap / MINUTE_MS)) + JIRA_OVERLAP_MINUTES;
  return { size: Math.min(WINDOW_MINUTES, minutes), gapCapped: gap > WINDOW_DAYS * DAY_MS };
}

export function windowStart(now: string): string {
  return new Date(Date.parse(now) - WINDOW_DAYS * DAY_MS).toISOString();
}

export interface JiraPublicationContext {
  /** Titles of retained GitHub issues and PRs of the project. */
  readonly githubTitles: readonly string[];
  /** Subjects of retained dev@ messages. */
  readonly mailSubjects: readonly string[];
}

export interface JiraLinkIndex {
  readonly citedKeys: ReadonlySet<string>;
  readonly mailKips: ReadonlySet<string>;
}

export function jiraLinkIndex(context: JiraPublicationContext): JiraLinkIndex {
  const citedKeys = new Set<string>();
  const mailKips = new Set<string>();
  for (const title of context.githubTitles) for (const key of extractKeys(title).issueKeys) citedKeys.add(key);
  for (const subject of context.mailSubjects) {
    const keys = extractKeys(subject);
    for (const key of keys.issueKeys) citedKeys.add(key);
    for (const kip of keys.kips) mailKips.add(kip);
  }
  return { citedKeys, mailKips };
}

/** Behavior 6: published when a GitHub title or dev@ subject cites the key, or a dev@ subject names its KIP. */
export function isJiraPublished(issue: { readonly key: string; readonly kips: readonly string[] }, links: JiraLinkIndex): boolean {
  return links.citedKeys.has(issue.key) || issue.kips.some((kip) => links.mailKips.has(kip));
}
