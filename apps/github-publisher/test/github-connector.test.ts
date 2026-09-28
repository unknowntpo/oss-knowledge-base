import { describe, expect, test } from "bun:test";

import { parseDomainEventV1 } from "@oss-knowledge-base/domain";
import { parseGitHubEventDataV1, type GitHubProjectProfile } from "@oss-knowledge-base/reference-pipeline";

import {
  GitHubConnector,
  type GitHubComment,
  type GitHubIssue,
  type GitHubJsonTransport,
} from "../github-connector";

const profile: GitHubProjectProfile = {
  owner: "apache",
  repo: "kafka",
  projectId: "apache-kafka",
  projectKey: "kafka",
  label: "Apache Kafka",
  sourceInstanceId: "kafka:github",
  profileVersion: "apache-kafka@github-live-1",
  statusPolicyRef: "github-issue-or-pull-request-status@1",
};

function issue(number: number, pull = false): GitHubIssue {
  return {
    id: number,
    number,
    title: `Source ${number}`,
    html_url: `https://github.com/apache/kafka/${pull ? "pull" : "issues"}/${number}`,
    comments_url: `https://api.github.com/repos/apache/kafka/issues/${number}/comments`,
    body_text: `Evidence ${number}`,
    state: pull ? "closed" : "open",
    created_at: `2026-08-2${number}T08:00:00Z`,
    updated_at: `2026-08-2${number}T10:00:00Z`,
    comments: pull ? 0 : 1,
    user: { login: `author-${number}` },
    author_association: "CONTRIBUTOR",
    labels: [{ name: "test" }],
    ...(pull ? { pull_request: { url: `https://api.github.com/repos/apache/kafka/pulls/${number}` } } : {}),
  };
}

const comment: GitHubComment = {
  id: 900,
  html_url: "https://github.com/apache/kafka/issues/1#issuecomment-900",
  body_text: "A source-backed comment with enough detail for the timeline.",
  created_at: "2026-08-21T11:00:00Z",
  updated_at: "2026-08-21T11:05:00Z",
  user: { login: "reviewer" },
  author_association: "MEMBER",
};

describe("Spec 004 GitHub connector", () => {
  test("G1: paginated issue, pull request, and comment payloads become valid DomainEventV1", async () => {
    const requested: string[] = [];
    const transport: GitHubJsonTransport = {
      async getJson<T>(rawUrl: string): Promise<T> {
        requested.push(rawUrl);
        const url = new URL(rawUrl);
        const page = Number(url.searchParams.get("page"));
        if (url.pathname.endsWith("/issues")) {
          return (page === 1 ? [issue(1)] : page === 2 ? [issue(2, true)] : []) as T;
        }
        if (url.pathname.endsWith("/issues/1/comments")) return (page === 1 ? [comment] : []) as T;
        if (url.pathname.endsWith("/pulls/2")) return { merged_at: "2026-08-22T09:59:00Z" } as T;
        throw new Error(`Unexpected URL ${rawUrl}`);
      },
    };
    const connector = new GitHubConnector({
      transport,
      projectProfiles: [profile],
      pageSize: 1,
      initialLookbackDays: 7,
    });
    const result = await connector.poll(undefined, "2026-08-25T12:00:00Z");

    expect(result.complete).toBe(true);
    if (!result.complete) return;
    expect(result.events).toHaveLength(3);
    expect(result.pageCount).toBe(5);
    for (const event of result.events) {
      const parsed = parseGitHubEventDataV1(parseDomainEventV1(event));
      expect(parsed.projectId).toBe("apache-kafka");
      expect(parsed.sourceInstanceId).toBe("kafka:github");
      expect(parsed.canonicalUrl.startsWith("https://github.com/apache/kafka/")).toBe(true);
      expect(parsed.sourceConnectorVersion).toBe("github@1");
      expect(parsed.communityProfileVersion).toBe(profile.profileVersion);
      expect(parsed.payloadRef.startsWith("content-addressed://sha256/")).toBe(true);
    }
    expect(result.events.map((event) => parseGitHubEventDataV1(event).data.recordKind).sort()).toEqual(["comment", "issue", "pull-request"]);
    expect(result.candidateCheckpoint.sources["kafka:github"]?.updatedAt).toBe("2026-08-22T10:00:00Z");
    expect(requested.filter((url) => new URL(url).pathname.endsWith("/issues"))).toHaveLength(3);
  });

  test("bounds a catch-up poll and checkpoints at the last processed issue", async () => {
    const issuePages: number[] = [];
    const transport: GitHubJsonTransport = {
      async getJson<T>(rawUrl: string): Promise<T> {
        const url = new URL(rawUrl);
        const page = Number(url.searchParams.get("page"));
        if (url.pathname.endsWith("/issues")) {
          issuePages.push(page);
          return (page === 1 ? [issue(1)] : page === 2 ? [issue(2)] : []) as T;
        }
        if (url.pathname.endsWith("/issues/1/comments")) return (page === 1 ? [comment] : []) as T;
        throw new Error(`Unexpected URL ${rawUrl}`);
      },
    };
    const connector = new GitHubConnector({
      transport,
      projectProfiles: [profile],
      pageSize: 1,
      initialLookbackDays: 7,
      maxIssuesPerSource: 1,
    });
    const result = await connector.poll(undefined, "2026-08-25T12:00:00Z");

    expect(result.complete).toBe(true);
    if (!result.complete) return;
    expect(issuePages).toEqual([1]);
    expect(result.truncated).toBe(true);
    expect(result.events.map((event) => event.entityId).sort()).toEqual([
      "kafka:github:issue:1",
      "kafka:github:issue:1:comment:900",
    ]);
    // The comment is newer than issue 1, but issue 2 is still unread.
    expect(result.candidateCheckpoint.sources["kafka:github"]?.updatedAt).toBe("2026-08-21T10:00:00Z");
  });

  test("G7: a later page failure returns no partial batch or checkpoint", async () => {
    const transport: GitHubJsonTransport = {
      async getJson<T>(rawUrl: string): Promise<T> {
        const page = Number(new URL(rawUrl).searchParams.get("page"));
        if (page === 1) return [issue(1)] as T;
        throw new Error("page 2 unavailable");
      },
    };
    const connector = new GitHubConnector({ transport, projectProfiles: [profile], pageSize: 1 });
    const result = await connector.poll(undefined, "2026-08-25T12:00:00Z");

    expect(result.complete).toBe(false);
    if (result.complete) return;
    expect(result.events).toEqual([]);
    expect(result.failureKind).toBe("transport");
    expect("candidateCheckpoint" in result).toBe(false);
  });
});
