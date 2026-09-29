import { describe, expect, test } from "bun:test";
import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import type { GitHubPollResult } from "@oss-knowledge-base/github-publisher/github-connector";
import type { SerializedReferenceStateV1 } from "@oss-knowledge-base/reference-pipeline";
import {
  MANIFEST_KEY,
  SEARCH_CURRENT_KEY,
  type PublicationObjectStore,
} from "@oss-knowledge-base/serving-contract";

import fixture from "../../../packages/reference-pipeline/test/fixtures/github-events.v1.json";
import {
  runDataPublication,
  type PipelineRunStatus,
  type PipelineStateRepository,
  type PublicationDestination,
} from "../src/pipeline";
import { GitHubFetchTransport } from "../src/github-transport";

describe("Cloudflare data publication", () => {
  test.each([500, 502, 503, 504, 524])("bounds retries for HTTP %s", async (status) => {
    let attempts = 0;
    const transport = new GitHubFetchTransport("github_pat_test", {
      fetchImpl: async () => {
        attempts += 1;
        return new Response("temporary", { status });
      },
      delay: async () => undefined,
    });
    await expect(transport.getJson("https://api.github.com/repos/apache/kafka/issues"))
      .rejects.toThrow(`GitHub API ${status}`);
    expect(attempts).toBe(3);
  });

  test.each([401, 403, 404, 429])("does not retry HTTP %s", async (status) => {
    let attempts = 0;
    const transport = new GitHubFetchTransport("github_pat_test", {
      fetchImpl: async () => {
        attempts += 1;
        return new Response("rejected", { status });
      },
      delay: async () => { throw new Error("unexpected retry"); },
    });
    await expect(transport.getJson("https://api.github.com/repos/apache/kafka/issues"))
      .rejects.toThrow(status === 403 || status === 429 ? "GitHub rate limit" : `GitHub API ${status}`);
    expect(attempts).toBe(1);
  });

  test("retries transient GitHub gateway failures without calling them rate limits", async () => {
    const statuses = [524, 503, 200];
    const delays: number[] = [];
    const transport = new GitHubFetchTransport("github_pat_test", {
      fetchImpl: async (_input, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        const status = statuses.shift() ?? 500;
        return Response.json(status === 200 ? [{ id: 1 }] : { error: "temporary" }, { status });
      },
      delay: async (milliseconds) => { delays.push(milliseconds); },
    });

    await expect(transport.getJson("https://api.github.com/repos/apache/kafka/issues"))
      .resolves.toEqual([{ id: 1 }]);
    expect(delays).toEqual([250, 500]);

    const failing = new GitHubFetchTransport("github_pat_test", {
      fetchImpl: async () => Response.json({ error: "gateway" }, { status: 502 }),
      delay: async () => undefined,
    });
    await expect(failing.getJson("https://api.github.com/repos/apache/kafka/issues"))
      .rejects.toThrow("GitHub API 502");
  });

  test("keeps development and production deployment boundaries disjoint", async () => {
    const development = await config("development");
    const production = await config("production");

    expect(development.name).toBe("oss-knowledge-base-data-dev");
    expect(development.vars.PUBLICATION_ENVIRONMENT).toBe("development");
    expect(development.r2_buckets[0]?.bucket_name).toBe("oss-knowledge-base-dev");
    expect(development.triggers.crons).toEqual(["7 * * * *"]);
    expect(production.name).toBe("oss-knowledge-base-data-prod");
    expect(production.vars.PUBLICATION_ENVIRONMENT).toBe("production");
    expect(production.r2_buckets[0]?.bucket_name).toBe("oss-knowledge-base-prod");
    expect(production.triggers.crons).toEqual(["37 * * * *"]);
    expect(development.name).not.toBe(production.name);
    expect(development.r2_buckets[0]?.bucket_name).not.toBe(production.r2_buckets[0]?.bucket_name);
  });

  test("publishes immutable objects before pointers and commits state last", async () => {
    const state = new MemoryState();
    const destination = new MemoryDestination();
    const events = fixture.events as DomainEventV1[];

    const result = await runDataPublication({
      environment: "development",
      materializedAt: fixture.config.materializedAt,
      connector: connectorSuccess(events),
      state,
      destination,
    });

    expect(result.ok).toBe(true);
    expect(state.value.events.length).toBe(events.length);
    expect(state.value.checkpoint?.sources["kafka:github"]?.updatedAt).toBeDefined();
    expect(destination.objects.has(MANIFEST_KEY)).toBe(true);
    expect(destination.objects.has(SEARCH_CURRENT_KEY)).toBe(true);
    const searchPointer = destination.operations.indexOf(`current:${SEARCH_CURRENT_KEY}`);
    const lastSearchImmutable = destination.operations.findLastIndex((operation) =>
      operation.startsWith("immutable:public/search/v1/releases/"));
    const feedPointer = destination.operations.indexOf(`current:${MANIFEST_KEY}`);
    const lastFeedImmutable = destination.operations.findLastIndex((operation) =>
      operation.startsWith("immutable:public/v2/releases/"));
    expect(searchPointer).toBeGreaterThan(lastSearchImmutable);
    expect(feedPointer).toBeGreaterThan(lastFeedImmutable);
    expect(destination.operations.at(-1)?.startsWith("evidence:")).toBe(true);
  });

  test("a partial GitHub poll keeps pointers and checkpoint unchanged", async () => {
    const state = new MemoryState();
    const destination = new MemoryDestination();
    destination.objects.set(MANIFEST_KEY, new TextEncoder().encode("old-feed"));
    destination.objects.set(SEARCH_CURRENT_KEY, new TextEncoder().encode("old-search"));

    const result = await runDataPublication({
      environment: "production",
      materializedAt: "2026-09-02T10:00:00.000Z",
      connector: {
        poll: async (): Promise<GitHubPollResult> => ({
          complete: false,
          events: [],
          failureKind: "rate-limit",
          error: "GitHub API 403",
          retryAfterSeconds: 300,
        }),
      },
      state,
      destination,
    });

    expect(result).toMatchObject({ ok: false, failureKind: "rate-limit" });
    expect(new TextDecoder().decode(destination.objects.get(MANIFEST_KEY))).toBe("old-feed");
    expect(new TextDecoder().decode(destination.objects.get(SEARCH_CURRENT_KEY))).toBe("old-search");
    expect(state.value.events).toEqual([]);
    expect(destination.operations).toEqual([]);
  });

  test("rerunning the same scheduled timestamp is idempotent", async () => {
    const state = new MemoryState();
    const destination = new MemoryDestination();
    const events = fixture.events as DomainEventV1[];
    const connector = connectorSuccess(events);
    const input = {
      environment: "development" as const,
      materializedAt: fixture.config.materializedAt,
      connector,
      state,
      destination,
    };

    const first = await runDataPublication(input);
    const objectCount = destination.objects.size;
    const second = await runDataPublication(input);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(destination.objects.size).toBe(objectCount);
    if (second.ok) expect(second.copiedObjectCount).toBe(0);
  });
});

async function config(environment: "development" | "production") {
  const file = Bun.file(new URL(`../wrangler.${environment}.jsonc`, import.meta.url));
  return await file.json() as {
    readonly name: string;
    readonly vars: { readonly PUBLICATION_ENVIRONMENT: string };
    readonly r2_buckets: readonly { readonly bucket_name: string }[];
    readonly triggers: { readonly crons: readonly string[] };
  };
}

function connectorSuccess(events: readonly DomainEventV1[]) {
  const watermarks = Object.fromEntries(
    [...new Set(events.map((event) => event.sourceInstanceId))].map((source) => [source, { updatedAt: "2026-08-25T08:00:00.000Z" }]),
  );
  return {
    poll: async (): Promise<GitHubPollResult> => ({
      complete: true,
      events,
      candidateCheckpoint: {
        schema: "osskb.github-checkpoint.v1",
        connectorRevision: "github@1",
        sources: watermarks,
      },
      pageCount: 4,
      truncated: false,
    }),
  };
}

class MemoryState implements PipelineStateRepository {
  value: SerializedReferenceStateV1 = { schema: "osskb.reference-state.v1", events: [] };
  statuses: PipelineRunStatus[] = [];

  async read(): Promise<SerializedReferenceStateV1> { return this.value; }
  async commit(state: SerializedReferenceStateV1): Promise<void> { this.value = state; }
  async recordStatus(status: PipelineRunStatus): Promise<void> { this.statuses.push(status); }
}

class MemoryDestination implements PublicationDestination, PublicationObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly operations: string[] = [];

  async get(key: string): Promise<Uint8Array | undefined> { return this.objects.get(key); }
  async putImmutableIfAbsent(key: string, body: Uint8Array): Promise<"created" | "exists"> {
    if (this.objects.has(key)) return "exists";
    this.objects.set(key, body);
    this.operations.push(`immutable:${key}`);
    return "created";
  }
  async putCurrent(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body);
    this.operations.push(`current:${key}`);
  }
  async putEvidence(key: string, body: Uint8Array): Promise<void> {
    const existing = this.objects.get(key);
    if (existing !== undefined && !bytesEqual(existing, body)) throw new Error(`conflict:${key}`);
    if (existing === undefined) this.objects.set(key, body);
    this.operations.push(`evidence:${key}`);
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
