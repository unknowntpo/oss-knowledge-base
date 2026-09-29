import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import {
  canonicalJson,
  githubProjectProfiles,
  sha256,
  type GitHubCheckpointV1,
  type GitHubEventDataV1,
  type GitHubProjectProfile,
} from "@oss-knowledge-base/reference-pipeline";

export interface GitHubUser { readonly login: string }
export interface GitHubLabel { readonly name: string }
export interface GitHubIssue {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly comments_url: string;
  readonly body_text: string | null;
  readonly body?: string | null;
  readonly state: "open" | "closed";
  readonly created_at: string;
  readonly updated_at: string;
  readonly comments: number;
  readonly user: GitHubUser | null;
  readonly author_association: string;
  readonly labels: readonly GitHubLabel[];
  readonly pull_request?: { readonly url: string };
}

export interface GitHubComment {
  readonly id: number;
  readonly html_url: string;
  readonly body_text: string | null;
  readonly body?: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly user: GitHubUser | null;
  readonly author_association: string;
}

export interface GitHubPullRequestDetails { readonly merged_at: string | null }

export interface GitHubJsonTransport {
  getJson<T>(url: string, options?: { readonly cache?: string }): Promise<T>;
}

export interface GitHubConnectorOptions {
  readonly transport?: GitHubJsonTransport;
  readonly projectProfiles?: readonly GitHubProjectProfile[];
  readonly connectorRevision?: string;
  readonly pageSize?: number;
  readonly initialLookbackDays?: number;
  readonly overlapSeconds?: number;
  readonly issueConcurrency?: number;
  /** Caps issues read per source in one poll so a large backlog is caught up over several polls. */
  readonly maxIssuesPerSource?: number;
}

export type GitHubPollResult =
  | {
      readonly complete: true;
      readonly events: readonly DomainEventV1[];
      readonly candidateCheckpoint: GitHubCheckpointV1;
      readonly pageCount: number;
      readonly truncated: boolean;
    }
  | {
      readonly complete: false;
      readonly events: readonly [];
      readonly error: string;
      readonly failureKind: "rate-limit" | "transport";
      readonly retryAfterSeconds: number;
    };

function plainText(value: string | null | undefined, fallback: string): string {
  const text = (value ?? "")
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/```[^]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[>*_~|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return fallback;
  return text.length > 360 ? `${text.slice(0, 357)}…` : text;
}

function roleLabel(association: string): string {
  const normalized = association.toLowerCase();
  if (normalized === "owner" || normalized === "member") return "Apache member";
  if (normalized === "collaborator") return "Collaborator";
  if (normalized === "contributor" || normalized === "first_time_contributor") return "Contributor";
  return "Community member";
}

function isBot(login: string | undefined): boolean {
  return (login ?? "").toLowerCase().includes("bot");
}

function eventId(projectId: string, sourceInstanceId: string, entityId: string, sourceCursor: string): string {
  return `sha256:${sha256(canonicalJson({ projectId, sourceInstanceId, entityId, sourceCursor }))}`;
}

function domainEvent(
  profile: GitHubProjectProfile,
  connectorRevision: string,
  observedAt: string,
  entityId: string,
  sourceCursor: string,
  canonicalUrl: string,
  data: GitHubEventDataV1,
): DomainEventV1 {
  return {
    schemaVersion: 1,
    id: eventId(profile.projectId, profile.sourceInstanceId, entityId, sourceCursor),
    projectId: profile.projectId,
    sourceType: "code-host",
    sourceInstanceId: profile.sourceInstanceId,
    entityType: data.recordKind === "comment" ? "message" : "artifact",
    entityId,
    eventType: "updated",
    sourceCursor,
    sourceTimestamp: data.updatedAt,
    observedAt,
    canonicalUrl,
    payloadRef: `content-addressed://sha256/${sha256(canonicalJson(data))}`,
    sourceConnectorVersion: connectorRevision,
    communityProfileVersion: profile.profileVersion,
    data,
  };
}

function initialSince(observedAt: string, days: number): string {
  return new Date(Date.parse(observedAt) - days * 86_400_000).toISOString();
}

function overlapSince(updatedAt: string, seconds: number): string {
  return new Date(Date.parse(updatedAt) - seconds * 1000).toISOString();
}

function urlWith(base: string, params: Readonly<Record<string, string | number>>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  worker: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const index = cursor++;
      const value = values[index];
      if (value === undefined) return;
      results[index] = await worker(value);
    }
  }));
  return results;
}

export class GitHubConnector {
  private readonly transport: GitHubJsonTransport;
  private readonly profiles: readonly GitHubProjectProfile[];
  private readonly connectorRevision: string;
  private readonly pageSize: number;
  private readonly initialLookbackDays: number;
  private readonly overlapSeconds: number;
  private readonly issueConcurrency: number;
  private readonly maxIssuesPerSource: number;

  constructor(options: GitHubConnectorOptions = {}) {
    if (options.transport === undefined) {
      throw new Error("GitHubConnector requires an explicit transport");
    }
    this.transport = options.transport;
    this.profiles = options.projectProfiles ?? githubProjectProfiles;
    this.connectorRevision = options.connectorRevision ?? "github@1";
    this.pageSize = options.pageSize ?? 100;
    this.initialLookbackDays = options.initialLookbackDays ?? 1;
    this.overlapSeconds = options.overlapSeconds ?? 300;
    this.issueConcurrency = options.issueConcurrency ?? 6;
    this.maxIssuesPerSource = options.maxIssuesPerSource ?? Number.POSITIVE_INFINITY;
  }

  async poll(previous: GitHubCheckpointV1 | undefined, observedAt: string): Promise<GitHubPollResult> {
    const events: DomainEventV1[] = [];
    const nextSources: Record<string, { readonly updatedAt: string }> = {};
    let pageCount = 0;
    let truncated = false;
    try {
      for (const profile of this.profiles) {
        const previousUpdatedAt = previous?.sources[profile.sourceInstanceId]?.updatedAt;
        const since = previousUpdatedAt === undefined
          ? initialSince(observedAt, this.initialLookbackDays)
          : overlapSince(previousUpdatedAt, this.overlapSeconds);
        const issuesBase = `https://api.github.com/repos/${profile.owner}/${profile.repo}/issues`;
        const issuesResult = await this.fetchAllPages<GitHubIssue>(issuesBase, {
          state: "all",
          sort: "updated",
          direction: "asc",
          since,
        }, this.maxIssuesPerSource);
        pageCount += issuesResult.pageCount;
        let watermark = previousUpdatedAt ?? since;

        const issueResults = await mapConcurrent(issuesResult.items, this.issueConcurrency, async (issue) => {
          const issueEvents: DomainEventV1[] = [];
          let issuePageCount = 0;
          const isPullRequest = issue.pull_request !== undefined;
          const rootId = `${profile.projectKey}:github:${isPullRequest ? "pull" : "issue"}:${issue.number}`;
          let mergedAt: string | undefined;
          if (isPullRequest && issue.state === "closed") {
            const pull = await this.transport.getJson<GitHubPullRequestDetails>(issue.pull_request!.url);
            mergedAt = pull.merged_at ?? undefined;
          }
          const rootData: GitHubEventDataV1 = {
            contract: "github-record@1",
            recordKind: isPullRequest ? "pull-request" : "issue",
            externalNumber: issue.number,
            title: issue.title,
            excerpt: plainText(issue.body_text ?? issue.body, "The source record has no description."),
            author: issue.user?.login ?? "unknown",
            authorRole: roleLabel(issue.author_association),
            occurredAt: issue.updated_at,
            createdAt: issue.created_at,
            updatedAt: issue.updated_at,
            nativeState: issue.state,
            ...(mergedAt === undefined ? {} : { mergedAt }),
            labels: issue.labels.map((label) => label.name).sort(),
            isBot: isBot(issue.user?.login),
          };
          issueEvents.push(domainEvent(profile, this.connectorRevision, observedAt, rootId, issue.updated_at, issue.html_url, rootData));
          let issueWatermark = issue.updated_at;

          if (issue.comments > 0) {
            const commentsResult = await this.fetchAllPages<GitHubComment>(issue.comments_url, {
              sort: "created",
              direction: "asc",
              since,
            });
            issuePageCount += commentsResult.pageCount;
            for (const comment of commentsResult.items) {
              const entityId = `${rootId}:comment:${comment.id}`;
              const data: GitHubEventDataV1 = {
                contract: "github-record@1",
                recordKind: "comment",
                externalNumber: issue.number,
                parentEntityId: rootId,
                title: `Comment on #${issue.number}`,
                excerpt: plainText(comment.body_text ?? comment.body, "The comment has no text."),
                author: comment.user?.login ?? "unknown",
                authorRole: roleLabel(comment.author_association),
                occurredAt: comment.created_at,
                createdAt: comment.created_at,
                updatedAt: comment.updated_at,
                labels: [],
                isBot: isBot(comment.user?.login),
              };
              issueEvents.push(domainEvent(profile, this.connectorRevision, observedAt, entityId, comment.updated_at, comment.html_url, data));
              if (comment.updated_at > issueWatermark) issueWatermark = comment.updated_at;
            }
          }
          return { events: issueEvents, pageCount: issuePageCount, watermark: issueWatermark };
        });
        for (const result of issueResults) {
          events.push(...result.events);
          pageCount += result.pageCount;
          if (result.watermark > watermark) watermark = result.watermark;
        }
        if (issuesResult.truncated) {
          // Unread issues sort after the last read one; a newer comment watermark would skip them.
          truncated = true;
          watermark = issuesResult.items.at(-1)!.updated_at;
        }
        nextSources[profile.sourceInstanceId] = { updatedAt: watermark };
      }
      return {
        complete: true,
        events,
        candidateCheckpoint: {
          schema: "osskb.github-checkpoint.v1",
          connectorRevision: this.connectorRevision,
          sources: nextSources,
        },
        pageCount,
        truncated,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rateLimited = /rate.?limit|secondary rate|\b403\b/i.test(message);
      return {
        complete: false,
        events: [],
        error: message,
        failureKind: rateLimited ? "rate-limit" : "transport",
        retryAfterSeconds: rateLimited ? 300 : 60,
      };
    }
  }

  private async fetchAllPages<T>(
    baseUrl: string,
    params: Readonly<Record<string, string | number>>,
    maxItems = Number.POSITIVE_INFINITY,
  ): Promise<{ readonly items: readonly T[]; readonly pageCount: number; readonly truncated: boolean }> {
    const items: T[] = [];
    let page = 1;
    for (;;) {
      const values = await this.transport.getJson<T[]>(urlWith(baseUrl, { ...params, per_page: this.pageSize, page }));
      items.push(...values);
      if (values.length < this.pageSize) return { items, pageCount: page, truncated: false };
      if (items.length >= maxItems) return { items: items.slice(0, maxItems), pageCount: page, truncated: true };
      page += 1;
    }
  }
}
