/**
 * Spec 019 slice 2b: the activity log's storage format, shared by the publisher that writes it and
 * the profile reader. Browser-safe: no Node import (the writer's event conversion is in
 * `activity-log.ts`).
 *
 * One object per project per month, `internal/people/v1/<projectId>/<YYYY-MM>.json`: one row per
 * human-authored record (who, when, which kind, which thread), the threads those rows point to
 * (title, link, author, labels, KIP numbers), and each identity's display name. No text, no
 * excerpt, no address. Next to it, `<YYYY-MM>.summary.json` holds each identity's counters for the
 * month, built by `indexActivityMonth`, for the contributor list of slice 7 (decision 10).
 */
import { nameKey } from "../review-queue/roster";

export const PEOPLE_ACTIVITY_SCHEMA = "osskb.people-activity.v1";
export const PEOPLE_ACTIVITY_SUMMARY_SCHEMA = "osskb.people-activity-summary.v1";
export const PEOPLE_ACTIVITY_STATE_SCHEMA = "osskb.people-activity-state.v1";
/** The publisher's flag value that turns the log on (`PEOPLE_ACTIVITY`). */
export const PEOPLE_ACTIVITY_REVISION = "log@1";
/** The pipeline state keeps 35 days per record (`compactState`); the first append holds that much. */
export const STATE_RETENTION_DAYS = 35;

export const peopleActivityPrefix = (projectId: string) => `internal/people/v1/${projectId}/`;
export const peopleActivityMonthKey = (projectId: string, month: string) => `${peopleActivityPrefix(projectId)}${month}.json`;
export const peopleActivitySummaryKey = (projectId: string, month: string) => `${peopleActivityPrefix(projectId)}${month}.summary.json`;
export const peopleActivityStateKey = (projectId: string) => `${peopleActivityPrefix(projectId)}state.json`;

export type ActivitySource = "github" | "jira" | "mail";
/** `pull-request` and `issue` are thread roots (GitHub PR or issue, Jira issue); `message` is a dev@ message. */
export type ActivityKind = "pull-request" | "issue" | "comment" | "message";

export interface ActivityRowV1 {
  /** The source record id (`kafka:github:pull:23310:comment:5733589468`); a repeated id replaces the row (W2). */
  readonly id: string;
  readonly source: ActivitySource;
  readonly kind: ActivityKind;
  /** `activityPersonId` of the author. */
  readonly person: string;
  /**
   * When the record was written: creation time for GitHub roots and every comment or message;
   * the last update for a Jira issue, whose creation time the connector does not keep.
   */
  readonly at: string;
  /** Key into the month's `threads`: `KAFKA-PR-23310`, `KAFKA-19028`, `KAFKA-MAIL-e07e6b7f`. */
  readonly thread: string;
  /** A merged pull request's merge time (W3). */
  readonly merged?: string;
  /**
   * Amendment (7), W67: a dev@ message whose subject has no reply prefix (a thread root). Fixed once
   * written, unlike the thread's `author`, which follows the oldest message in the sliding state.
   * Absent on replies and on rows written before the flag existed (W83: those are no root).
   */
  readonly opens?: true;
}

/** Amendment (7), W67: a Jira account on a thread entry. Internal only: no API response carries it. */
export interface ActivityAccountV1 {
  readonly key: string;
  readonly display: string;
}

export interface ActivityThreadV1 {
  readonly source: ActivitySource;
  readonly kind: "pull-request" | "issue" | "mail-thread";
  readonly title: string;
  readonly url: string;
  /** The thread author's person id, or null when unknown or a bot. */
  readonly author: string | null;
  /** GitHub labels, sorted; empty for Jira and dev@ (no label data). */
  readonly labels: readonly string[];
  /** KIP numbers in the title or subject (`KIP-1368`), sorted. */
  readonly kips: readonly string[];
  /**
   * Amendment (7), W67: a Jira issue's reporter and assignee accounts (null when none), the
   * identity-link job's input. Absent on other threads and on entries written before the change.
   */
  readonly reporter?: ActivityAccountV1 | null;
  readonly assignee?: ActivityAccountV1 | null;
}

export interface ActivityMonthV1 {
  readonly schema: typeof PEOPLE_ACTIVITY_SCHEMA;
  readonly projectId: string;
  readonly month: string;
  /** Person id → display name as the source spells it. */
  readonly people: Readonly<Record<string, string>>;
  readonly threads: Readonly<Record<string, ActivityThreadV1>>;
  readonly rows: readonly ActivityRowV1[];
}

export interface ActivityStateV1 {
  readonly schema: typeof PEOPLE_ACTIVITY_STATE_SCHEMA;
  /** The first append's publication time. */
  readonly firstAppendAt: string;
  /** What the first append could hold: `STATE_RETENTION_DAYS` before it. Counts start here. */
  readonly coverageFrom: string;
  /** The last append's publication time: the log is complete up to here. */
  readonly updatedAt: string;
  /** Months that have an object, oldest first. */
  readonly months: readonly string[];
}

/**
 * Strict identity (Spec 019 rule 1, decision 5): a GitHub login, case-insensitive; a Jira or dev@
 * display name normalized with `nameKey` and case-folded. The source is part of the id, so a Jira
 * and a dev@ identity with the same name stay two identities. Undefined for names that are no one.
 */
export function activityPersonId(source: ActivitySource, author: string): string | undefined {
  const key = source === "github" ? author.trim().toLowerCase() : nameKey(author).toLowerCase();
  if (key === "" || key === "unknown" || key === "unknown sender" || key === "ghost" || key.length > 200) return undefined;
  if (/[\u0000-\u001f]/u.test(key)) return undefined;
  return `${source}:${key}`;
}

export function activityMonth(at: string): string {
  return new Date(at).toISOString().slice(0, 7);
}

/** Deterministic JSON: rows by time then id, threads and people by key, so an unchanged month encodes the same bytes. */
export function encodeActivityMonth(month: ActivityMonthV1): string {
  const sortedRecord = <T>(record: Readonly<Record<string, T>>) =>
    Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]!]));
  const rows = [...month.rows].sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.at < b.at ? -1 : 1));
  return JSON.stringify({
    schema: PEOPLE_ACTIVITY_SCHEMA,
    projectId: month.projectId,
    month: month.month,
    people: sortedRecord(month.people),
    threads: sortedRecord(month.threads),
    rows: rows.map((row) => ({
      id: row.id, source: row.source, kind: row.kind, person: row.person, at: row.at, thread: row.thread,
      ...(row.merged === undefined ? {} : { merged: row.merged }),
      ...(row.opens === true ? { opens: true } : {}),
    })),
  });
}

/** W2: incoming rows replace stored rows with the same id; threads and names take the newest value. */
export function mergeActivityMonth(stored: ActivityMonthV1 | undefined, incoming: ActivityMonthV1): ActivityMonthV1 {
  if (stored === undefined) return incoming;
  const rows = new Map(stored.rows.map((row) => [row.id, row]));
  for (const row of incoming.rows) rows.set(row.id, row);
  return {
    schema: PEOPLE_ACTIVITY_SCHEMA,
    projectId: incoming.projectId,
    month: incoming.month,
    people: { ...stored.people, ...incoming.people },
    threads: { ...stored.threads, ...incoming.threads },
    rows: [...rows.values()],
  };
}

const SOURCES: readonly ActivitySource[] = ["github", "jira", "mail"];
const KINDS: readonly ActivityKind[] = ["pull-request", "issue", "comment", "message"];

/** Reads a stored month; throws on any other shape (W10: the reader reports the month unavailable). */
export function parseActivityMonth(value: unknown, projectId: string, month: string): ActivityMonthV1 {
  const object = value as Partial<ActivityMonthV1> | null;
  if (object === null || typeof object !== "object" || object.schema !== PEOPLE_ACTIVITY_SCHEMA ||
      object.projectId !== projectId || object.month !== month || !Array.isArray(object.rows) ||
      typeof object.threads !== "object" || object.threads === null || typeof object.people !== "object" || object.people === null) {
    throw new Error(`Activity month ${projectId} ${month} is malformed`);
  }
  for (const row of object.rows) {
    if (typeof row?.id !== "string" || !SOURCES.includes(row.source) || !KINDS.includes(row.kind) || typeof row.person !== "string" ||
        typeof row.at !== "string" || typeof row.thread !== "string" || !(row.thread in object.threads) ||
        (row.opens !== undefined && row.opens !== true)) {
      throw new Error(`Activity month ${projectId} ${month} has a malformed row`);
    }
  }
  return object as ActivityMonthV1;
}

export function parseActivityState(value: unknown): ActivityStateV1 {
  const state = value as Partial<ActivityStateV1> | null;
  if (state === null || typeof state !== "object" || state.schema !== PEOPLE_ACTIVITY_STATE_SCHEMA ||
      [state.firstAppendAt, state.coverageFrom, state.updatedAt].some((time) => typeof time !== "string" || Number.isNaN(Date.parse(time))) ||
      !Array.isArray(state.months)) {
    throw new Error("The activity log's state is malformed");
  }
  return state as ActivityStateV1;
}

/** One identity's records in one month: the counters slice 7's list needs (decision 10). */
export interface ActivityPersonSummaryV1 {
  readonly display: string;
  readonly counts: Readonly<Record<"pullRequests" | "issues" | "comments" | "jiraIssues" | "jiraComments" | "messages", number>>;
  /** Thread keys of what the identity opened this month (pull requests, GitHub and Jira issues), so distinct counts stay exact across months. */
  readonly opened: readonly string[];
  /** Thread keys of the identity's pull requests in this month that are merged. */
  readonly merged: readonly string[];
  readonly lastAt: string;
}

export interface ActivityMonthIndex {
  readonly people: ReadonlyMap<string, { readonly rows: readonly ActivityRowV1[]; readonly summary: ActivityPersonSummaryV1 }>;
}

/** The per-identity index of one month: the reader's request-time index and the stored summary are the same function. */
export function indexActivityMonth(month: ActivityMonthV1): ActivityMonthIndex {
  const byPerson = new Map<string, ActivityRowV1[]>();
  for (const row of month.rows) (byPerson.get(row.person) ?? byPerson.set(row.person, []).get(row.person)!).push(row);
  const people = new Map<string, { rows: readonly ActivityRowV1[]; summary: ActivityPersonSummaryV1 }>();
  for (const [person, rows] of byPerson) {
    const counts = { pullRequests: 0, issues: 0, comments: 0, jiraIssues: 0, jiraComments: 0, messages: 0 };
    const opened = new Set<string>();
    const merged = new Set<string>();
    let lastAt = "";
    for (const row of rows) {
      if (row.at > lastAt) lastAt = row.at;
      if (row.source === "mail") counts.messages += 1;
      else if (row.source === "jira") counts[row.kind === "issue" ? "jiraIssues" : "jiraComments"] += 1;
      else if (row.kind === "pull-request") counts.pullRequests += 1;
      else if (row.kind === "issue") counts.issues += 1;
      else counts.comments += 1;
      if (row.kind === "pull-request" || row.kind === "issue") opened.add(row.thread);
      if (row.merged !== undefined) merged.add(row.thread);
    }
    people.set(person, {
      rows,
      summary: { display: month.people[person] ?? person, counts, opened: [...opened].sort(), merged: [...merged].sort(), lastAt },
    });
  }
  return { people };
}

export function encodeActivitySummary(month: ActivityMonthV1, index: ActivityMonthIndex = indexActivityMonth(month)): string {
  return JSON.stringify({
    schema: PEOPLE_ACTIVITY_SUMMARY_SCHEMA,
    projectId: month.projectId,
    month: month.month,
    people: Object.fromEntries([...index.people.keys()].sort().map((person) => [person, index.people.get(person)!.summary])),
  });
}
