import { GitHubConnector } from "@oss-knowledge-base/github-publisher/github-connector";
import { asfRosterAdapter, JiraConnector, KAFKA_DIGEST_PROFILE, KAFKA_REVIEW_PROFILE, PonyMailConnector } from "@oss-knowledge-base/reference-pipeline";
import { DigestRunner } from "./digest/runner";
import { R2DigestBucket } from "./digest/store";
import { runReviewQueue } from "./review-queue/run";
import { R2ReviewQueueBucket, reviewQueueLastRunKey } from "./review-queue/store";
import { WorkersAiModel, type AiBinding } from "./digest/workers-ai";
import { DurableObjectPipelineState } from "./durable-object-state";
import { GitHubFetchTransport } from "./github-transport";
import { R2PublicationDestination } from "./r2-destination";
import { runPending } from "./run-schedule";
import { healthBody } from "./health";
import { runDataPublication, type PipelinePhaseMarker, type PipelineRunStatus } from "./pipeline";
import type { EmbeddingAiBinding, VectorIndex } from "@oss-knowledge-base/semantic-vectorize";
import { SearchEmbeddingRunner, unboundSearchEmbeddingHealth } from "./search-embedding/runner";

interface Env {
  readonly PUBLICATION_ENVIRONMENT: "development" | "production";
  readonly GITHUB_SOURCE_TOKEN?: string;
  readonly MANUAL_TRIGGER_TOKEN?: string;
  readonly OSS_KB_BUCKET: R2Bucket;
  readonly PIPELINE_STATE: DurableObjectNamespace;
  readonly DIGEST_RUN: DurableObjectNamespace;
  /** Spec 014: the digest's cron expression. Unset until a Dev dry run is reviewed, so no cron starts a digest. */
  readonly DIGEST_CRON?: string;
  /** Spec 015: the review queue's cron expression. Unset until a Dev dry run is measured. */
  readonly REVIEW_QUEUE_CRON?: string;
  /** "true" enables the digest (Dev); unset on Prod until its gateway exists. */
  readonly DIGEST_ENABLED?: string;
  /** "workers-ai" uses the `AI` binding through `DIGEST_GATEWAY_ID`; otherwise rules only. */
  readonly DIGEST_MODEL?: string;
  readonly DIGEST_GATEWAY_ID?: string;
  readonly AI?: AiBinding;
  /**
   * Spec 016: the lexical revision the Search release is written at. Unset writes
   * `bm25-reference@1`; set `bm25-reference@2` only once Pages that read it are live.
   */
  readonly SEARCH_LEXICAL_REVISION?: string;
  /**
   * Spec 016 slice 2b: the embedding profile (`bge-m3@1`). Unset is off: no model, index, or
   * embedding-object call. An unknown value fails the embedding run, never the publication.
   */
  readonly SEARCH_EMBEDDING?: string;
  /** The search AI Gateway; never the digest's. */
  readonly SEARCH_GATEWAY_ID?: string;
  /** The Vectorize index, one namespace per project. Bound on Dev only. */
  readonly SEARCH_VECTORS?: VectorIndex;
  /** Bound on Dev only; everything that reads it tolerates its absence. */
  readonly SEARCH_EMBEDDING_RUN?: DurableObjectNamespace;
}

const sourceFetch = (url: string, init: { readonly headers: Readonly<Record<string, string>> }) =>
  fetch(url, { headers: init.headers, signal: AbortSignal.timeout(30_000) });

const STATE_OBJECT_NAME = "github-feed-search-pipeline-v1";
const DIGEST_OBJECT_NAME = "topic-digest-apache-kafka-v1";
const SEARCH_EMBEDDING_OBJECT_NAME = "search-embedding-v1";

function searchEmbeddingObject(env: Pick<Env, "SEARCH_EMBEDDING_RUN">): DurableObjectStub | undefined {
  return env.SEARCH_EMBEDDING_RUN?.get(env.SEARCH_EMBEDDING_RUN.idFromName(SEARCH_EMBEDDING_OBJECT_NAME));
}

/**
 * Spec 016 Behavior 15: what a successful publication does next. `undefined` when the flag is
 * blank or the object is not bound, so a publisher without embeddings calls nothing. The answer
 * is logged, not acted on: 409 means a run is already pending, and any failure waits for the
 * next publication.
 */
export function searchEmbeddingTrigger(
  env: Pick<Env, "SEARCH_EMBEDDING" | "SEARCH_EMBEDDING_RUN">,
): ((status: PipelineRunStatus) => Promise<void>) | undefined {
  if ((env.SEARCH_EMBEDDING?.trim() ?? "") === "" || env.SEARCH_EMBEDDING_RUN === undefined) return undefined;
  return async (status) => {
    if (!status.ok) return;
    const response = await searchEmbeddingObject(env)!.fetch("https://search-embedding.internal/run", { method: "POST" });
    if (!response.ok && response.status !== 409) console.error(`Scheduling the search embedding failed: ${response.status} ${await response.text()}`);
  };
}

const matches = (cron: string, configured: string | undefined) => configured !== undefined && configured.trim() !== "" && cron === configured;

/**
 * Spec 014 Behavior 21 and Spec 015 Q57: a tick starts the digest or the review queue only when it
 * is that job's configured cron; any other tick publishes.
 */
export function cronTarget(cron: string, digestCron: string | undefined, reviewQueueCron?: string): "digest" | "review-queue" | "publisher" {
  if (matches(cron, digestCron)) return "digest";
  if (matches(cron, reviewQueueCron)) return "review-queue";
  return "publisher";
}

/** Slice 2b: Workers AI through the gateway only when all three settings are present. */
export function digestModel(env: Pick<Env, "DIGEST_MODEL" | "DIGEST_GATEWAY_ID" | "AI">): WorkersAiModel | undefined {
  const gateway = env.DIGEST_GATEWAY_ID?.trim() ?? "";
  return env.DIGEST_MODEL === "workers-ai" && env.AI !== undefined && gateway !== "" ? new WorkersAiModel(env.AI, gateway) : undefined;
}

/**
 * `/health`: the publisher's body, unchanged, plus `digest` (null when the digest object fails),
 * `reviewQueue`, the review queue's `last-run.json` (null before the first run or on a read error),
 * and `searchEmbedding` when the caller passes it.
 */
export function mergeHealth(publisher: unknown, digest: unknown, reviewQueue: unknown = null, searchEmbedding?: unknown): unknown {
  return {
    ...(publisher as Record<string, unknown>),
    digest: digest ?? null,
    reviewQueue: reviewQueue ?? null,
    // Spec 016 H51: the embedding object's health, or null when it does not answer.
    ...(searchEmbedding === undefined ? {} : { searchEmbedding }),
  };
}

function reviewQueueRun(env: Env, dryRun: boolean) {
  return runReviewQueue({
    bucket: new R2ReviewQueueBucket(env.OSS_KB_BUCKET),
    profile: KAFKA_REVIEW_PROFILE,
    githubToken: env.GITHUB_SOURCE_TOKEN ?? "",
    githubFetch: (url, init) => fetch(url, init),
    apacheFetch: (url, init) => fetch(url, init),
    rosterAdapter: asfRosterAdapter,
    now: () => Date.now(),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    dryRun,
  });
}

function authorized(request: Request, env: Env): boolean {
  const manualToken = env.MANUAL_TRIGGER_TOKEN?.trim() ?? "";
  return manualToken.length > 0 && request.headers.get("authorization") === `Bearer ${manualToken}`;
}
// Keeps one run under the Durable Object memory limit; a larger backlog catches up over later runs.
const MAX_ISSUES_PER_SOURCE = 200;

export default {
  async scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    const target = cronTarget(controller.cron, env.DIGEST_CRON, env.REVIEW_QUEUE_CRON);
    if (target === "review-queue") {
      context.waitUntil(reviewQueueRun(env, false).then(() => undefined));
      return;
    }
    if (target === "digest") {
      const digest = env.DIGEST_RUN.get(env.DIGEST_RUN.idFromName(DIGEST_OBJECT_NAME));
      context.waitUntil(digest.fetch("https://digest.internal/run", { method: "POST" }).then(async (response) => {
        if (!response.ok && response.status !== 409) throw new Error(`Scheduling the digest failed: ${await response.text()}`);
      }));
      return;
    }
    const stub = env.PIPELINE_STATE.get(env.PIPELINE_STATE.idFromName(STATE_OBJECT_NAME));
    context.waitUntil(stub.fetch("https://pipeline.internal/run", {
      method: "POST",
      headers: { "x-scheduled-at": new Date(controller.scheduledTime).toISOString() },
    }).then(async (response) => {
      // 409 means a run is already scheduled or active; the next Cron tick picks up the rest.
      if (!response.ok && response.status !== 409) {
        throw new Error(`Scheduling publication failed: ${await response.text()}`);
      }
    }));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const stub = env.PIPELINE_STATE.get(env.PIPELINE_STATE.idFromName(STATE_OBJECT_NAME));
    const url = new URL(request.url);
    const digest = env.DIGEST_RUN.get(env.DIGEST_RUN.idFromName(DIGEST_OBJECT_NAME));
    if (request.method === "GET" && url.pathname === "/health") {
      const publisher = await stub.fetch("https://pipeline.internal/status");
      if (!publisher.ok) return publisher;
      const digestHealth = await digest.fetch("https://digest.internal/status")
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
      const reviewQueue = await env.OSS_KB_BUCKET.get(reviewQueueLastRunKey(KAFKA_REVIEW_PROFILE.projectId))
        .then((object) => (object === null ? null : object.json()))
        .catch(() => null);
      const embedding = searchEmbeddingObject(env);
      const searchEmbedding = embedding === undefined
        ? unboundSearchEmbeddingHealth(env.SEARCH_EMBEDDING, new Date())
        : await embedding.fetch("https://search-embedding.internal/status")
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null);
      return Response.json(mergeHealth(await publisher.json(), digestHealth, reviewQueue, searchEmbedding));
    }
    if (request.method === "POST" && url.pathname === "/search-embedding/run") {
      if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
      const embedding = searchEmbeddingObject(env);
      if (embedding === undefined) return Response.json({ ok: false, disabled: true }, { status: 403 });
      const forwarded = new URLSearchParams();
      for (const name of ["dryRun", "reset"]) if (url.searchParams.get(name) === "1") forwarded.set(name, "1");
      const profile = url.searchParams.get("profile");
      if (profile !== null) forwarded.set("profile", profile);
      const query = forwarded.toString();
      return embedding.fetch(`https://search-embedding.internal/run${query === "" ? "" : `?${query}`}`, { method: "POST" });
    }
    if (request.method === "POST" && url.pathname === "/digest/run") {
      if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
      const dryRun = url.searchParams.get("dryRun") === "1";
      return digest.fetch(`https://digest.internal/run${dryRun ? "?dryRun=1" : ""}`, { method: "POST" });
    }
    if (request.method === "POST" && url.pathname === "/review-queue/run") {
      if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
      // Runs while the caller waits (about 1–3 min): no Durable Object holds this job (ADR-0016).
      const { lastRun } = await reviewQueueRun(env, url.searchParams.get("dryRun") === "1");
      return Response.json(lastRun, { status: lastRun.ok ? 200 : 502 });
    }
    if (request.method === "POST" && url.pathname === "/run") {
      if (!authorized(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      return stub.fetch("https://pipeline.internal/run", {
        method: "POST",
        headers: { "x-scheduled-at": new Date().toISOString() },
      });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Runs publish from the object's alarm instead of the triggering request. The runtime never runs
 * two alarms at once and retries one that dies, so no lease is needed, and a run no longer depends
 * on the Cron invocation or the manual caller staying connected.
 */
export class PipelineState implements DurableObject {
  private running = false;

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/status") {
      const status = await this.ctx.storage.get<PipelineRunStatus>("status");
      const phase = await this.ctx.storage.get<PipelinePhaseMarker>("phase");
      return Response.json(healthBody({
        environment: this.env.PUBLICATION_ENVIRONMENT,
        running: this.running,
        scheduled: runPending(false, await this.ctx.storage.getAlarm(), Date.now()),
        phase,
        status,
      }));
    }
    if (request.method !== "POST" || path !== "/run") return new Response("Not found", { status: 404 });
    // A stale alarm (its retries exhausted) is overwritten below instead of blocking every trigger.
    if (runPending(this.running, await this.ctx.storage.getAlarm(), Date.now())) {
      return Response.json({ ok: false, skipped: "already-running" }, { status: 409 });
    }
    await this.ctx.storage.put("requested-at", request.headers.get("x-scheduled-at") ?? new Date().toISOString());
    await this.ctx.storage.delete("run-lease"); // written by the pre-alarm implementation
    await this.ctx.storage.setAlarm(Date.now());
    return Response.json({ ok: true, scheduled: true }, { status: 202 });
  }

  async alarm(): Promise<void> {
    this.running = true;
    try {
      // Sources are read live, so a retry of an attempt that died reads different data; it must
      // publish under its own release id, not rewrite the release-specific keys already written.
      const requestedAt = await this.ctx.storage.get<string>("requested-at");
      await this.ctx.storage.delete("requested-at");
      const materializedAt = requestedAt ?? new Date().toISOString();
      const onPublished = searchEmbeddingTrigger(this.env);
      await runDataPublication({
        environment: this.env.PUBLICATION_ENVIRONMENT,
        materializedAt,
        connector: new GitHubConnector({
          transport: new GitHubFetchTransport(this.env.GITHUB_SOURCE_TOKEN ?? ""),
          maxIssuesPerSource: MAX_ISSUES_PER_SOURCE,
        }),
        // Spec 012: public Apache sources, read anonymously; each may fail without stopping the run.
        sources: [
          { key: "mail", connector: new PonyMailConnector({ fetch: sourceFetch }) },
          { key: "jira", connector: new JiraConnector({ fetch: sourceFetch }) },
        ],
        state: new DurableObjectPipelineState(this.ctx.storage),
        destination: new R2PublicationDestination(this.env.OSS_KB_BUCKET),
        ...(this.env.SEARCH_LEXICAL_REVISION === undefined ? {} : { searchLexicalRevision: this.env.SEARCH_LEXICAL_REVISION }),
        ...(onPublished === undefined ? {} : { onPublished }),
      });
    } finally {
      this.running = false;
    }
  }
}

/**
 * Spec 014: the weekly digest. Its own object, isolate, memory, and alarm; slice 2 runs the rules
 * classifier with no model (no `AI` binding), so it generates no text.
 */
export class DigestRun implements DurableObject {
  private readonly runner: DigestRunner;

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    this.runner = new DigestRunner({
      storage: {
        get: (key) => ctx.storage.get(key),
        put: (key, value) => ctx.storage.put(key, value),
        delete: (key) => ctx.storage.delete(key),
        getAlarm: () => ctx.storage.getAlarm(),
        setAlarm: (time) => ctx.storage.setAlarm(time),
      },
      bucket: new R2DigestBucket(env.OSS_KB_BUCKET),
      profile: KAFKA_DIGEST_PROFILE,
      environment: env.PUBLICATION_ENVIRONMENT,
      enabled: env.DIGEST_ENABLED === "true",
      ...(digestModel(env) === undefined ? {} : { model: digestModel(env)! }),
      now: () => new Date(),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      publisherRunning: async () => {
        const publisher = env.PIPELINE_STATE.get(env.PIPELINE_STATE.idFromName(STATE_OBJECT_NAME));
        const status = await publisher.fetch("https://pipeline.internal/status").then((response) => response.json() as Promise<{ running?: boolean }>);
        return status.running === true;
      },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") return Response.json(await this.runner.health());
    if (request.method === "POST" && url.pathname === "/run") {
      const result = await this.runner.request(url.searchParams.get("dryRun") === "1");
      return Response.json(result.body, { status: result.status });
    }
    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.runner.alarm();
  }
}

/**
 * Spec 016 slice 2b: embeds the published Search chunks into the vector index. Its own object,
 * isolate, memory, storage, and alarm, so no failure here reaches the publication.
 */
export class SearchEmbeddingRun implements DurableObject {
  private readonly runner: SearchEmbeddingRunner;

  constructor(ctx: DurableObjectState, env: Env) {
    this.runner = new SearchEmbeddingRunner({
      storage: {
        get: (key) => ctx.storage.get(key),
        put: (key, value) => ctx.storage.put(key, value),
        putMany: (entries) => ctx.storage.put(entries as Record<string, unknown>),
        delete: (key) => ctx.storage.delete(key),
        deleteMany: async (keys) => { await ctx.storage.delete([...keys]); },
        list: (prefix) => ctx.storage.list({ prefix }),
        getAlarm: () => ctx.storage.getAlarm(),
        setAlarm: (time) => ctx.storage.setAlarm(time),
      },
      bucket: new R2DigestBucket(env.OSS_KB_BUCKET),
      flag: env.SEARCH_EMBEDDING,
      gatewayId: env.SEARCH_GATEWAY_ID,
      digestGatewayId: env.DIGEST_GATEWAY_ID,
      ai: env.AI as EmbeddingAiBinding | undefined,
      index: env.SEARCH_VECTORS,
      now: () => new Date(),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") return Response.json(await this.runner.health());
    if (request.method === "POST" && url.pathname === "/run") {
      const result = await this.runner.request({
        dryRun: url.searchParams.get("dryRun") === "1",
        reset: url.searchParams.get("reset") === "1",
        ...(url.searchParams.get("profile") === null ? {} : { profile: url.searchParams.get("profile")! }),
      });
      return Response.json(result.body, { status: result.status });
    }
    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.runner.alarm();
  }
}
