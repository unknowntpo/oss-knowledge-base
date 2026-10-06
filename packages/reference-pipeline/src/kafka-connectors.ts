/**
 * Spec 012 connectors: Pony Mail (dev@kafka.apache.org) and ASF Jira (KAFKA). Each poll is
 * all-or-nothing for its source; a failure keeps the source's cursor (ADR-0014).
 */
import type { DomainEventV1 } from "@oss-knowledge-base/domain";

import { kafkaJiraSource, kafkaMailSource } from "./config";
import { jiraEventsFrom, mailEventFrom } from "./kafka-events";
import { jiraWindow, mailWindow } from "./kafka-rules";
import type { GitHubCheckpointV1 } from "./state";

export const SOURCE_USER_AGENT = "oss-knowledge-base/1.0 (+https://github.com/unknowntpo/oss-knowledge-base)";
/** Larger responses fail the source as `too-large` (4 MiB of text). */
export const MAX_RESPONSE_CHARS = 4 * 1024 * 1024;
const MAX_RETRY_AFTER_SECONDS = 60;
const DEFAULT_RETRY_DELAY_SECONDS = 5;

export type SourceFailureKind = "transport" | "rate-limit" | "schema" | "truncated" | "too-large";

export interface SourcePollStats {
  readonly read: number;
  readonly skipped: number;
  readonly filtered: number;
  readonly gapCapped: boolean;
}

export type SourcePollResult =
  | {
      readonly complete: true;
      readonly events: readonly DomainEventV1[];
      /** Only this source's entries; the pipeline merges them into the stored checkpoint. */
      readonly candidateCheckpoint: GitHubCheckpointV1;
      readonly pageCount: number;
      readonly truncated: boolean;
      readonly stats?: SourcePollStats;
    }
  | {
      readonly complete: false;
      readonly events: readonly [];
      readonly error: string;
      readonly failureKind: SourceFailureKind;
      readonly retryAfterSeconds: number;
    };

export interface SourceHttpResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type SourceFetch = (url: string, init: { readonly headers: Readonly<Record<string, string>> }) => Promise<SourceHttpResponse>;

export interface CommunityConnectorOptions {
  readonly fetch: SourceFetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly maxResponseChars?: number;
}

class SourceFailure extends Error {
  constructor(readonly failureKind: SourceFailureKind, message: string, readonly retryAfterSeconds = 3600) {
    super(message);
  }
}

function retryAfterSeconds(response: SourceHttpResponse): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** GET with one retry after a 5xx, 429, or transport error (Behavior 10). */
async function getText(options: Required<CommunityConnectorOptions>, url: string, counter: { requests: number }): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    let response: SourceHttpResponse;
    try {
      counter.requests += 1;
      response = await options.fetch(url, { headers: { Accept: "application/json", "User-Agent": SOURCE_USER_AGENT } });
    } catch (error) {
      if (attempt === 0) {
        await options.sleep(DEFAULT_RETRY_DELAY_SECONDS * 1000);
        continue;
      }
      throw new SourceFailure("transport", error instanceof Error ? error.message : String(error), 300);
    }
    if (response.status >= 200 && response.status < 300) {
      const body = await response.text();
      if (body.length > options.maxResponseChars) {
        throw new SourceFailure("too-large", `${url} returned ${body.length} characters`);
      }
      return body;
    }
    const retryable = response.status === 429 || response.status >= 500;
    const kind: SourceFailureKind = response.status === 429 ? "rate-limit" : "transport";
    const after = retryAfterSeconds(response);
    if (retryable && attempt === 0 && (after === undefined || after <= MAX_RETRY_AFTER_SECONDS)) {
      await options.sleep((after ?? DEFAULT_RETRY_DELAY_SECONDS) * 1000);
      continue;
    }
    throw new SourceFailure(kind, `${url} returned HTTP ${response.status}`, after ?? 300);
  }
}

function parseJson(body: string, label: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new SourceFailure("schema", `${label} did not return JSON`);
  }
}

function failure(error: unknown): SourcePollResult {
  if (error instanceof SourceFailure) {
    return { complete: false, events: [], error: error.message, failureKind: error.failureKind, retryAfterSeconds: error.retryAfterSeconds };
  }
  return { complete: false, events: [], error: error instanceof Error ? error.message : String(error), failureKind: "schema", retryAfterSeconds: 3600 };
}

function withDefaults(options: CommunityConnectorOptions): Required<CommunityConnectorOptions> {
  return {
    fetch: options.fetch,
    sleep: options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    maxResponseChars: options.maxResponseChars ?? MAX_RESPONSE_CHARS,
  };
}

function checkpointWith(sourceInstanceId: string, revision: string, updatedAt: string): GitHubCheckpointV1 {
  return { schema: "osskb.github-checkpoint.v1", connectorRevision: revision, sources: { [sourceInstanceId]: { updatedAt } } };
}

export const PONY_MAIL_STATS_URL = "https://lists.apache.org/api/stats.lua";

/** dev@kafka.apache.org through Pony Mail `stats.lua`: one request per poll (Behavior 2, 5). */
export class PonyMailConnector {
  private readonly options: Required<CommunityConnectorOptions>;
  readonly requests = { requests: 0 };

  constructor(options: CommunityConnectorOptions, private readonly revision = "ponymail@1") {
    this.options = withDefaults(options);
  }

  async poll(previous: GitHubCheckpointV1 | undefined, observedAt: string): Promise<SourcePollResult> {
    const cursor = previous?.sources[kafkaMailSource.sourceInstanceId]?.updatedAt;
    const window = mailWindow(cursor, observedAt);
    const url = `${PONY_MAIL_STATS_URL}?list=dev&domain=kafka.apache.org&d=lte=${window.size}d`;
    try {
      const response = parseJson(await getText(this.options, url, this.requests), "Pony Mail");
      if (typeof response !== "object" || response === null || !Array.isArray((response as { emails?: unknown }).emails)) {
        throw new SourceFailure("schema", "Pony Mail response has no emails array");
      }
      const { emails, hits } = response as { readonly emails: readonly unknown[]; readonly hits?: unknown };
      if (typeof hits === "number" && emails.length < hits) {
        throw new SourceFailure("truncated", `Pony Mail returned ${emails.length} of ${hits} emails`, 3600);
      }
      const events: DomainEventV1[] = [];
      let skipped = 0;
      let filtered = 0;
      let newest = cursor;
      for (const email of emails) {
        const parsed = mailEventFrom(email, observedAt, this.revision);
        if (parsed.kind === "skipped") skipped += 1;
        else if (parsed.kind === "filtered") filtered += 1;
        else if (parsed.kind === "event") {
          events.push(parsed.event);
          if (newest === undefined || parsed.event.sourceTimestamp > newest) newest = parsed.event.sourceTimestamp;
        }
      }
      const nextCursor = newest === undefined || newest > observedAt ? observedAt : newest;
      return {
        complete: true,
        events,
        candidateCheckpoint: checkpointWith(kafkaMailSource.sourceInstanceId, this.revision, nextCursor),
        pageCount: 1,
        truncated: false,
        stats: { read: emails.length, skipped, filtered, gapCapped: window.gapCapped },
      };
    } catch (error) {
      return failure(error);
    }
  }
}

export const JIRA_SEARCH_URL = "https://issues.apache.org/jira/rest/api/2/search";
const JIRA_FIELDS = "summary,description,status,updated,created,reporter,comment";

export interface JiraConnectorOptions extends CommunityConnectorOptions {
  readonly pageSize?: number;
  /** Issues read per poll; a larger backlog is caught up by later polls (Behavior 5). */
  readonly maxIssues?: number;
}

/** KAFKA issues through ASF Jira v2 search with a relative `updated` window (Behavior 4, 5). */
export class JiraConnector {
  private readonly options: Required<CommunityConnectorOptions>;
  private readonly pageSize: number;
  private readonly maxIssues: number;
  readonly requests = { requests: 0 };

  constructor(options: JiraConnectorOptions, private readonly revision = "jira@1") {
    this.options = withDefaults(options);
    this.pageSize = options.pageSize ?? 100;
    this.maxIssues = options.maxIssues ?? 200;
  }

  async poll(previous: GitHubCheckpointV1 | undefined, observedAt: string): Promise<SourcePollResult> {
    const cursor = previous?.sources[kafkaJiraSource.sourceInstanceId]?.updatedAt;
    const window = jiraWindow(cursor, observedAt);
    const jql = `project = KAFKA AND updated >= "-${window.size}m" ORDER BY updated ASC, key ASC`;
    try {
      const issues: unknown[] = [];
      let pageCount = 0;
      let truncated = false;
      for (let startAt = 0; ;) {
        const url = `${JIRA_SEARCH_URL}?${new URLSearchParams({
          jql, fields: JIRA_FIELDS, startAt: String(startAt), maxResults: String(this.pageSize),
        }).toString()}`;
        const page = parseJson(await getText(this.options, url, this.requests), "Jira");
        pageCount += 1;
        const values = (page as { issues?: unknown }).issues;
        const total = (page as { total?: unknown }).total;
        if (typeof page !== "object" || page === null || !Array.isArray(values) || typeof total !== "number") {
          throw new SourceFailure("schema", "Jira response has no issues array or total");
        }
        issues.push(...values);
        startAt += values.length;
        if (values.length === 0 || startAt >= total) break;
        if (issues.length >= this.maxIssues) {
          truncated = true;
          break;
        }
      }
      const events: DomainEventV1[] = [];
      let skipped = 0;
      let newest = cursor;
      for (const issue of issues.slice(0, this.maxIssues)) {
        const parsed = jiraEventsFrom(issue, observedAt, this.revision);
        if (parsed.kind === "skipped") {
          skipped += 1;
          continue;
        }
        events.push(...parsed.events);
        if (newest === undefined || parsed.updated > newest) newest = parsed.updated;
      }
      return {
        complete: true,
        events,
        candidateCheckpoint: checkpointWith(kafkaJiraSource.sourceInstanceId, this.revision, newest ?? observedAt),
        pageCount,
        truncated,
        stats: { read: Math.min(issues.length, this.maxIssues), skipped, filtered: 0, gapCapped: window.gapCapped },
      };
    } catch (error) {
      return failure(error);
    }
  }
}
