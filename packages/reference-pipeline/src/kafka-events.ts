/**
 * Spec 012 event data contracts (`mail-record@1`, `jira-record@1`) and their construction
 * from Pony Mail and Jira REST responses.
 */
import type { DomainEventV1 } from "@oss-knowledge-base/domain";

import { canonicalJson, sha256 } from "./canonical";
import { kafkaJiraSource, kafkaMailSource, type CommunitySourceProfile } from "./config";
import { extractKeys, isNotificationSubject, jiraStatus, jiraTime, mailAuthor, windowStart } from "./kafka-rules";

export interface MailEventDataV1 extends Readonly<Record<string, unknown>> {
  readonly contract: "mail-record@1";
  readonly subject: string;
  readonly author: string;
  readonly occurredAt: string;
  readonly excerpt: string;
  readonly kips: readonly string[];
  readonly issueKeys: readonly string[];
}

export interface JiraEventDataV1 extends Readonly<Record<string, unknown>> {
  readonly contract: "jira-record@1";
  readonly recordKind: "issue" | "comment";
  readonly key: string;
  readonly parentEntityId?: string;
  readonly title: string;
  readonly excerpt: string;
  readonly author: string;
  readonly occurredAt: string;
  readonly nativeStatus?: string;
  readonly status?: "open" | "resolved";
  readonly kips: readonly string[];
  readonly isBot: boolean;
}

export type MailDomainEventV1 = DomainEventV1 & { readonly data: MailEventDataV1 };
export type JiraDomainEventV1 = DomainEventV1 & { readonly data: JiraEventDataV1 };

const MAIL_EXCERPT_CHARS = 200;
const JIRA_EXCERPT_CHARS = 280;
const FUTURE_TOLERANCE_MS = 3_600_000;
export const JIRA_BROWSE_URL = "https://issues.apache.org/jira/browse/";
export const PONY_THREAD_URL = "https://lists.apache.org/thread/";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function clip(text: string, limit: number, fallback: string): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  if (compact.length === 0) return fallback;
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

/** Jira wiki markup to plain text, enough for an excerpt. */
function jiraPlainText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\{(code|noformat)[^}]*\}[^]*?\{\1\}/gu, " ")
    .replace(/\[~([^\]]+)\]/gu, "$1")
    .replace(/\[([^|\]]+)\|[^\]]+\]/gu, "$1")
    .replace(/\[(https?:[^\]]+)\]/gu, "$1")
    .replace(/^h[1-6]\.\s*/gmu, "");
}

function domainEvent(
  source: CommunitySourceProfile,
  connectorRevision: string,
  observedAt: string,
  entityType: DomainEventV1["entityType"],
  entityId: string,
  sourceCursor: string,
  canonicalUrl: string,
  data: MailEventDataV1 | JiraEventDataV1,
): DomainEventV1 {
  return {
    schemaVersion: 1,
    id: `sha256:${sha256(canonicalJson({ projectId: source.projectId, sourceInstanceId: source.sourceInstanceId, entityId, sourceCursor }))}`,
    projectId: source.projectId,
    sourceType: source.sourceType,
    sourceInstanceId: source.sourceInstanceId,
    entityType,
    entityId,
    eventType: "updated",
    sourceCursor,
    sourceTimestamp: sourceCursor,
    observedAt,
    canonicalUrl,
    payloadRef: `content-addressed://sha256/${sha256(canonicalJson(data))}`,
    sourceConnectorVersion: connectorRevision,
    communityProfileVersion: source.profileVersion,
    data,
  };
}

export type MailParseResult =
  | { readonly kind: "event"; readonly event: DomainEventV1 }
  | { readonly kind: "filtered" }
  | { readonly kind: "outside-window" }
  | { readonly kind: "skipped"; readonly reason: string };

/** One Pony Mail `stats.lua` email → one mail event (Behavior 2). */
export function mailEventFrom(email: unknown, observedAt: string, connectorRevision = "ponymail@1"): MailParseResult {
  if (!isRecord(email)) return { kind: "skipped", reason: "not an object" };
  const mid = email.mid ?? email.id;
  if (!nonEmpty(mid) || !/^[A-Za-z0-9]+$/u.test(mid)) return { kind: "skipped", reason: "missing mid" };
  if (typeof email.epoch !== "number" || !Number.isFinite(email.epoch)) return { kind: "skipped", reason: "missing epoch" };
  if (typeof email.subject !== "string") return { kind: "skipped", reason: "missing subject" };
  const time = email.epoch * 1000;
  if (time > Date.parse(observedAt) + FUTURE_TOLERANCE_MS) return { kind: "skipped", reason: "dated in the future" };
  const occurredAt = new Date(time).toISOString();
  if (occurredAt < windowStart(observedAt)) return { kind: "outside-window" };
  if (isNotificationSubject(email.subject)) return { kind: "filtered" };
  const keys = extractKeys(email.subject);
  const data: MailEventDataV1 = {
    contract: "mail-record@1",
    subject: email.subject.replace(/\s+/gu, " ").trim() || "(no subject)",
    author: mailAuthor(typeof email.from === "string" ? email.from : ""),
    occurredAt,
    excerpt: clip(typeof email.body === "string" ? email.body : "", MAIL_EXCERPT_CHARS, "The message has no preview."),
    kips: keys.kips,
    issueKeys: keys.issueKeys,
  };
  const url = `${PONY_THREAD_URL}${mid}`;
  return {
    kind: "event",
    event: domainEvent(kafkaMailSource, connectorRevision, observedAt, "message", `kafka:mail:dev:message:${mid}`, occurredAt, url, data),
  };
}

export type JiraParseResult =
  | { readonly kind: "events"; readonly events: readonly DomainEventV1[]; readonly updated: string }
  | { readonly kind: "skipped"; readonly reason: string };

function displayName(user: unknown): string {
  if (!isRecord(user)) return "unknown";
  if (nonEmpty(user.displayName)) return user.displayName.trim();
  return nonEmpty(user.name) ? user.name.trim() : "unknown";
}

function isBotUser(user: unknown): boolean {
  if (!isRecord(user)) return false;
  return /bot/iu.test(`${String(user.name ?? "")} ${String(user.displayName ?? "")}`);
}

/** One KAFKA issue from `/rest/api/2/search` → an issue event and its comments within 30 days (Behavior 4). */
export function jiraEventsFrom(issue: unknown, observedAt: string, connectorRevision = "jira@1"): JiraParseResult {
  if (!isRecord(issue) || !nonEmpty(issue.key) || !/^KAFKA-\d+$/u.test(issue.key)) return { kind: "skipped", reason: "missing key" };
  const fields = issue.fields;
  if (!isRecord(fields)) return { kind: "skipped", reason: "missing fields" };
  const updated = jiraTime(fields.updated);
  if (updated === undefined) return { kind: "skipped", reason: "missing updated" };
  if (!nonEmpty(fields.summary)) return { kind: "skipped", reason: "missing summary" };
  const key = issue.key;
  const entityId = `kafka:jira:issue:${key}`;
  const nativeStatus = isRecord(fields.status) && nonEmpty(fields.status.name) ? fields.status.name : "Unknown";
  const description = jiraPlainText(fields.description);
  const issueData: JiraEventDataV1 = {
    contract: "jira-record@1",
    recordKind: "issue",
    key,
    title: `${key}: ${fields.summary.trim()}`,
    excerpt: clip(description, JIRA_EXCERPT_CHARS, "The issue has no description."),
    author: displayName(fields.reporter),
    occurredAt: updated,
    nativeStatus,
    status: jiraStatus(nativeStatus),
    kips: extractKeys(`${fields.summary} ${typeof fields.description === "string" ? fields.description : ""}`).kips,
    isBot: isBotUser(fields.reporter),
  };
  const events = [domainEvent(kafkaJiraSource, connectorRevision, observedAt, "artifact", entityId, updated, `${JIRA_BROWSE_URL}${key}`, issueData)];
  const comments = isRecord(fields.comment) && Array.isArray(fields.comment.comments) ? fields.comment.comments : [];
  const earliest = windowStart(observedAt);
  for (const comment of comments) {
    if (!isRecord(comment) || !nonEmpty(comment.id)) continue;
    const commentUpdated = jiraTime(comment.updated);
    const created = jiraTime(comment.created) ?? commentUpdated;
    if (commentUpdated === undefined || created === undefined || commentUpdated < earliest) continue;
    const data: JiraEventDataV1 = {
      contract: "jira-record@1",
      recordKind: "comment",
      key,
      parentEntityId: entityId,
      title: `Comment on ${key}`,
      excerpt: clip(jiraPlainText(comment.body), JIRA_EXCERPT_CHARS, "The comment has no text."),
      author: displayName(comment.author),
      occurredAt: created,
      kips: [],
      isBot: isBotUser(comment.author),
    };
    events.push(domainEvent(
      kafkaJiraSource, connectorRevision, observedAt, "message", `${entityId}:comment:${comment.id}`, commentUpdated,
      `${JIRA_BROWSE_URL}${key}?focusedCommentId=${comment.id}`, data,
    ));
  }
  return { kind: "events", events, updated };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseMailEventDataV1(event: DomainEventV1): MailDomainEventV1 {
  const data: unknown = event.data;
  if (!isRecord(data) || data.contract !== "mail-record@1") throw new Error(`Mail event ${event.id} has an unsupported data contract`);
  for (const key of ["subject", "author", "occurredAt", "excerpt"] as const) {
    if (!nonEmpty(data[key])) throw new Error(`Mail event ${event.id} has an invalid ${key}`);
  }
  if (!isStringArray(data.kips) || !isStringArray(data.issueKeys)) throw new Error(`Mail event ${event.id} has invalid keys`);
  return event as MailDomainEventV1;
}

export function parseJiraEventDataV1(event: DomainEventV1): JiraDomainEventV1 {
  const data: unknown = event.data;
  if (!isRecord(data) || data.contract !== "jira-record@1") throw new Error(`Jira event ${event.id} has an unsupported data contract`);
  if (data.recordKind !== "issue" && data.recordKind !== "comment") throw new Error(`Jira event ${event.id} has an invalid recordKind`);
  for (const key of ["key", "title", "excerpt", "author", "occurredAt"] as const) {
    if (!nonEmpty(data[key])) throw new Error(`Jira event ${event.id} has an invalid ${key}`);
  }
  if (!isStringArray(data.kips) || typeof data.isBot !== "boolean") throw new Error(`Jira event ${event.id} has invalid kips or isBot`);
  if (data.recordKind === "comment" && !nonEmpty(data.parentEntityId)) throw new Error(`Jira comment ${event.id} requires parentEntityId`);
  if (data.recordKind === "issue" && data.status !== "open" && data.status !== "resolved") {
    throw new Error(`Jira issue ${event.id} requires status`);
  }
  return event as JiraDomainEventV1;
}
