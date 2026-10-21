import { GitHubConnector } from "@oss-knowledge-base/github-publisher/github-connector";
import { asfRosterAdapter, GITHUB_REVIEWS_AREAS_REVISION, githubProjectProfiles, JiraConnector, KAFKA_DIGEST_PROFILE, KAFKA_REVIEW_PROFILE, PonyMailConnector, resolveBackfillFrom } from "@oss-knowledge-base/reference-pipeline";
import { IDENTITY_LINKS_LAST_RUN_KEY, PEOPLE_IDENTITY_PROFILES } from "@oss-knowledge-base/reference-pipeline";
import { PEOPLE_PROJECTS, PEOPLE_SUPPRESSED, suppressionDigest } from "@oss-knowledge-base/reference-pipeline/people";
import { DigestRunner, publisherBusy } from "./digest/runner";
import { R2DigestBucket } from "./digest/store";
import { runReviewQueue } from "./review-queue/run";
import { githubReviewsProjects } from "./github-reviews/projects";
import { runGithubReviews, runGithubReviewsBackfill } from "./github-reviews/run";
import { runGithubReviewsRefresh } from "./github-reviews/refresh";
import { GITHUB_REVIEWS_BACKFILL_LAST_RUN_KEY, GITHUB_REVIEWS_LAST_RUN_KEY, GITHUB_REVIEWS_REFRESH_LAST_RUN_KEY, R2GithubReviewsBucket } from "./github-reviews/store";
import { R2ReviewQueueBucket, reviewQueueLastRunKey } from "./review-queue/store";
import { WorkersAiModel, type AiBinding } from "./digest/workers-ai";
import { DurableObjectPipelineState } from "./durable-object-state";
import { GitHubFetchTransport } from "./github-transport";
import { R2PublicationDestination } from "./r2-destination";
import { FOLLOW_UP_KEY, runPending, runStarting, scheduleFollowUp, type FollowUpMarker } from "./run-schedule";
import { healthBody } from "./health";
import { identityLinksSet, R2IdentityLinksBucket, runIdentityLinks } from "./identity-links/run";
import { KIP_PAGES_CRON_WALL_MS, kipPagesHealth, kipPagesRun, kipPagesSet } from "./kip-pages/run";
import { appendActivityLog, peopleActivitySet, R2ActivityBucket } from "./people-activity/run";
import { runDataPublication, type PipelinePhaseMarker, type PipelineRunStatus } from "./pipeline";
import { SEARCH_QUERY_GATE_OBJECT_NAME, unboundQueryGateHealth, type EmbeddingAiBinding, type SemanticQueryGate, type VectorIndex } from "@oss-knowledge-base/semantic-vectorize";
import { createSearchQueryGate } from "./search-query/gate";
import { SearchEmbeddingRunner, unboundSearchEmbeddingHealth } from "./search-embedding/runner";
import { errorText, sanitizeErrorMessage } from "./search-embedding/sanitize";
import { redactRecord } from "./redact";
import { COST_GUARD_OBJECT_NAME, COST_GUARD_RETRY_AFTER_MS } from "./cost-guard/profile";
import { CostGuardRunner, costGuardMissing, resolveCostGuardMode, unboundCostGuardHealth, type CostGuardInApp } from "./cost-guard/guard";
import { COST_GUARD_REFUSAL } from "./digest/runner";

interface Env {
  readonly PUBLICATION_ENVIRONMENT: "development" | "production";
  readonly GITHUB_SOURCE_TOKEN?: string;
  /** Spec 018 T17: days a repository with no GitHub cursor is read back; integer 1..35, default 1. */
  readonly GITHUB_INITIAL_LOOKBACK_DAYS?: string;
  readonly MANUAL_TRIGGER_TOKEN?: string;
  readonly OSS_KB_BUCKET: R2Bucket;
  readonly PIPELINE_STATE: DurableObjectNamespace;
  readonly DIGEST_RUN: DurableObjectNamespace;
  /** Spec 014: the digest's cron expression (Dev `47 22 * * *`, D86). Unset on Prod, so no cron starts a digest there. */
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
   * `bm25-reference@1`; set `bm25-reference@2` or `@3` (Spec 017) only once Pages that read it
   * are live.
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
  /**
   * Spec 016 slice 3: `true` makes a Search release declare each shard's first group root, which
   * semantic candidates need. Unset writes the manifest as before.
   */
  readonly SEARCH_SHARD_ROOTS?: string;
  /**
   * Spec 016 slice 3: the query gate's namespace, bound here only so `/health` can read it. The
   * Pages project reaches the same class through its own binding. Unbound until the enable.
   */
  readonly SEARCH_QUERY_GATE?: DurableObjectNamespace;
  /**
   * Spec 022: `metadata@1` ingests GitHub pull-request reviews as metadata rows on each
   * publication tick. Unset is off: no GitHub request, no R2 request, no `/health` field. Any
   * other value fails the review run (never the publication) and is reported in `/health`.
   */
  readonly GITHUB_REVIEWS?: string;
  /**
   * Spec 019 slice 2b: `log@1` appends every record the publication state holds to the activity
   * log (`internal/people/v1/`) before the state is compacted. Unset is off: no R2 request, no
   * `lastRun.activity`. Any other value fails the append (never the publication) and is reported
   * in `lastRun.activity`.
   */
  readonly PEOPLE_ACTIVITY?: string;
  /**
   * Spec 026: `monitor` checks the account's cost once a day and records the breaker; `enforce`
   * also makes the digest, the embedding job and the query gate refuse while it is open (and the
   * publication when R2 Class A tripped). Unset, blank or `off`: nothing runs and `/health` is unchanged.
   */
  readonly COST_GUARD?: string;
  /** Spec 026: Account Analytics Read token for the GraphQL Analytics API. Never logged or returned. */
  readonly CF_ANALYTICS_TOKEN?: string;
  /** Spec 026: the account whose usage the guard reads. */
  readonly CF_ACCOUNT_ID?: string;
  /** Spec 026: the `CostGuard` object (breaker and last check). Unbound until the Dev enable. */
  readonly COST_GUARD_STATE?: DurableObjectNamespace;
  /**
   * Spec 019 amendment (7): `corroborated@1` runs the identity-link job on its own cron
   * (`IDENTITY_LINKS_CRON`, Dev `17 2 * * *`) and `POST /identity-links/run`. Unset is off: the
   * cron tick and the route do nothing (404), no R2 call, no `/health` field (W85).
   */
  readonly IDENTITY_LINKS?: string;
  readonly IDENTITY_LINKS_CRON?: string;
  /**
   * Spec 019 amendment (7): `authors@1` runs the `kip-pages` job (KIP page author lines and the
   * `JIRA:` field's assignees, `internal/kips/v1/`). Unset is off: no request, no R2 call, no `/health` field.
   */
  readonly KIP_PAGES?: string;
  /** Spec 019 amendment (7): the `kip-pages` job's cron expression (`43 3 * * *` once enabled). */
  readonly KIP_PAGES_CRON?: string;
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
 * is logged, not acted on: 409 means a run is already starting, and a run that leaves work
 * continues on its own alarm (Behavior 46).
 */
export function searchEmbeddingTrigger(
  env: Pick<Env, "SEARCH_EMBEDDING" | "SEARCH_EMBEDDING_RUN">,
): ((status: PipelineRunStatus) => Promise<void>) | undefined {
  if ((env.SEARCH_EMBEDDING?.trim() ?? "") === "" || env.SEARCH_EMBEDDING_RUN === undefined) return undefined;
  return async (status) => {
    if (!status.ok) return;
    const response = await searchEmbeddingObject(env)!.fetch("https://search-embedding.internal/run", { method: "POST" });
    if (!response.ok && response.status !== 409) console.error(sanitizeErrorMessage(`Scheduling the search embedding failed: ${response.status} ${await response.text()}`));
  };
}

function costGuardObject(env: Pick<Env, "COST_GUARD_STATE">): DurableObjectStub | undefined {
  return env.COST_GUARD_STATE?.get(env.COST_GUARD_STATE.idFromName(COST_GUARD_OBJECT_NAME));
}

const NO_REFUSAL = { refuse: false, pausePublication: false } as const;

/**
 * Spec 026 Behavior 9–10: what a guarded feature must do now. Only under `enforce` with the object
 * bound is the object asked; when it cannot answer, nothing is refused (fail open).
 */
export async function costGuardDecisionFor(env: Pick<Env, "COST_GUARD" | "COST_GUARD_STATE">): Promise<{ readonly refuse: boolean; readonly pausePublication: boolean }> {
  if (resolveCostGuardMode(env.COST_GUARD) !== "enforce") return NO_REFUSAL;
  const object = costGuardObject(env);
  if (object === undefined) return NO_REFUSAL;
  try {
    const response = await object.fetch("https://cost-guard.internal/decision");
    if (!response.ok) throw new Error(`the cost guard answered ${response.status}`);
    const body = await response.json() as { refuse?: unknown; pausePublication?: unknown };
    return { refuse: body.refuse === true, pausePublication: body.pausePublication === true };
  } catch (error) {
    console.error(`cost guard: no decision, proceeding: ${errorText(error)}`);
    return NO_REFUSAL;
  }
}

const costGuardRefuses = (env: Env) => async () => (await costGuardDecisionFor(env)).refuse;

async function statusOf(namespace: DurableObjectNamespace | undefined, objectName: string, url: string): Promise<unknown> {
  if (namespace === undefined) return undefined;
  const response = await namespace.get(namespace.idFromName(objectName)).fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

/**
 * Spec 026 Behavior 4: the estimates this Worker can make itself. Neurons today are the three
 * ledgers' (an object that is not bound adds 0, a ledger of another day adds 0); Vectorize uses the
 * index and the gate's month. A ledger that does not answer makes the metric unavailable.
 */
export function inAppSources(env: Pick<Env, "AI" | "DIGEST_RUN" | "SEARCH_EMBEDDING_RUN" | "SEARCH_QUERY_GATE" | "SEARCH_VECTORS">, now: () => Date): CostGuardInApp {
  return {
    async neuronsToday() {
      if (env.AI === undefined) return null;
      const date = now().toISOString().slice(0, 10);
      const today = (body: unknown, field: "estimatedNeurons" | "neurons") => {
        const ledger = (body as { today?: Record<string, unknown> } | undefined)?.today;
        return ledger?.date === date && typeof ledger[field] === "number" ? ledger[field] as number : 0;
      };
      const [digest, embedding, gate] = await Promise.all([
        statusOf(env.DIGEST_RUN, DIGEST_OBJECT_NAME, "https://digest.internal/status"),
        statusOf(env.SEARCH_EMBEDDING_RUN, SEARCH_EMBEDDING_OBJECT_NAME, "https://search-embedding.internal/status"),
        statusOf(env.SEARCH_QUERY_GATE, SEARCH_QUERY_GATE_OBJECT_NAME, "https://search-query.internal/status"),
      ]);
      return today(digest, "estimatedNeurons") + today(embedding, "estimatedNeurons") + today(gate, "neurons");
    },
    async vectorize(month) {
      if (env.SEARCH_VECTORS === undefined) return null;
      const info = await env.SEARCH_VECTORS.describe();
      const usage = await statusOf(env.SEARCH_QUERY_GATE, SEARCH_QUERY_GATE_OBJECT_NAME, `https://search-query.internal/month?month=${month}`) as { indexQueries?: unknown } | undefined;
      const queries = typeof usage?.indexQueries === "number" ? usage.indexQueries : 0;
      return { storedDimensions: info.vectorCount * info.dimensions, queriedDimensions: (queries + info.vectorCount) * info.dimensions };
    },
  };
}

/** Spec 026 Behavior 13: `/health` `costGuard`, or undefined while the flag is off. */
async function costGuardHealth(env: Env): Promise<unknown> {
  if (resolveCostGuardMode(env.COST_GUARD) === "off") return undefined;
  const object = costGuardObject(env);
  if (object === undefined) {
    return unboundCostGuardHealth(env.COST_GUARD, costGuardMissing({ flag: env.COST_GUARD, token: env.CF_ANALYTICS_TOKEN, accountId: env.CF_ACCOUNT_ID, bound: false })!);
  }
  return object.fetch("https://cost-guard.internal/status").then((response) => (response.ok ? response.json() : null)).catch(() => null);
}

const matches = (cron: string, configured: string | undefined) => configured !== undefined && configured.trim() !== "" && cron === configured;

/**
 * Spec 014 Behavior 21 and Spec 015 Q57: a tick starts the digest or the review queue only when it
 * is that job's configured cron; any other tick publishes.
 */
export function cronTarget(cron: string, digestCron: string | undefined, reviewQueueCron?: string, identityLinksCron?: string, kipPagesCron?: string): "digest" | "review-queue" | "identity-links" | "kip-pages" | "publisher" {
  if (matches(cron, digestCron)) return "digest";
  if (matches(cron, reviewQueueCron)) return "review-queue";
  // Spec 019 amendment (7): the identity-link job's own tick never publishes (W81).
  if (matches(cron, identityLinksCron)) return "identity-links";
  // Spec 019 amendment (7): nor does the kip-pages job's (W98, W99).
  if (matches(cron, kipPagesCron)) return "kip-pages";
  return "publisher";
}

/** Slice 2b: Workers AI through the gateway only when all three settings are present. */
export function digestModel(env: Pick<Env, "DIGEST_MODEL" | "DIGEST_GATEWAY_ID" | "AI">): WorkersAiModel | undefined {
  const gateway = env.DIGEST_GATEWAY_ID?.trim() ?? "";
  return env.DIGEST_MODEL === "workers-ai" && env.AI !== undefined && gateway !== "" ? new WorkersAiModel(env.AI, gateway) : undefined;
}

/** Spec 014 D95: every JSON body the Worker and its objects serve goes through the error redaction. */
function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(redactRecord(body), init);
}

/**
 * `/health`: the publisher's body, unchanged, plus `digest` (null when the digest object fails),
 * `reviewQueue`, the review queue's `last-run.json` (null before the first run or on a read error),
 * `searchEmbedding` (null when the embedding object does not answer), and `searchQuery` (the query
 * gate; null when it does not answer), and, only while `GITHUB_REVIEWS` is set, `githubReviews` (the
 * review ingestion's `last-run.json`; null before the first run or on a read error) and
 * `githubReviewsBackfill` (the last manual backfill call's record; null before the first one).
 */
export function mergeHealth(publisher: unknown, digest: unknown, reviewQueue: unknown = null, searchEmbedding: unknown = null, searchQuery: unknown = null, githubReviews?: unknown, githubReviewsBackfill?: unknown, githubReviewsRefresh?: unknown, costGuard?: unknown): unknown {
  // D95: redacted here as well as in `json`, so callers of mergeHealth get a safe body too.
  return redactRecord({
    ...(publisher as Record<string, unknown>),
    digest: digest ?? null,
    reviewQueue: reviewQueue ?? null,
    // Spec 016 H51: the embedding object's health, or null when it does not answer.
    searchEmbedding: searchEmbedding ?? null,
    // Spec 016 H69: the query gate's health, or null when it does not answer.
    searchQuery: searchQuery ?? null,
    // Spec 022 RV24: present only while `GITHUB_REVIEWS` is set; null before the first run.
    ...(githubReviews === undefined ? {} : { githubReviews }),
    // Spec 022 RV34: the backfill's own record, so the daily `githubReviews` keeps its meaning.
    ...(githubReviewsBackfill === undefined ? {} : { githubReviewsBackfill }),
    // Spec 022 RV41: the metadata refresh's record, only under `metadata@2` (absent under `metadata@1`, so its /health is unchanged).
    ...(githubReviewsRefresh === undefined ? {} : { githubReviewsRefresh }),
    // Spec 026 CG11: present only while `COST_GUARD` is set.
    ...(costGuard === undefined ? {} : { costGuard }),
  });
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

/** Spec 022 Behavior 1: the flag is "set" when it is not blank, whether or not its value is supported. */
export function githubReviewsSet(env: Pick<Env, "GITHUB_REVIEWS">): boolean {
  return (env.GITHUB_REVIEWS?.trim() ?? "") !== "";
}

/** RV41: the flag names the areas revision (`metadata@2`); only then does `/health` carry the refresh record. */
export function githubReviewsAreas(env: Pick<Env, "GITHUB_REVIEWS">): boolean {
  return env.GITHUB_REVIEWS?.trim() === GITHUB_REVIEWS_AREAS_REVISION;
}

function githubReviewsDeps(env: Env, dryRun: boolean) {
  return {
    flag: env.GITHUB_REVIEWS,
    bucket: new R2GithubReviewsBucket(env.OSS_KB_BUCKET),
    projects: githubReviewsProjects,
    githubToken: env.GITHUB_SOURCE_TOKEN ?? "",
    githubFetch: (url: string, init: RequestInit) => fetch(url, init),
    now: () => Date.now(),
    delay: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    dryRun,
  };
}

function githubReviewsRun(env: Env, dryRun: boolean) {
  return runGithubReviews(githubReviewsDeps(env, dryRun));
}

function authorized(request: Request, env: Env): boolean {
  const manualToken = env.MANUAL_TRIGGER_TOKEN?.trim() ?? "";
  return manualToken.length > 0 && request.headers.get("authorization") === `Bearer ${manualToken}`;
}
// Keeps one run under the Durable Object memory limit; a larger backlog catches up over later runs.
const MAX_ISSUES_PER_SOURCE = 200;
/** The publication state keeps 35 days, so reading further back on a first run gains nothing. */
const MAX_INITIAL_LOOKBACK_DAYS = 35;

/**
 * Spec 018 T17 (closes gardening G95): how far back a repository with no cursor is read. Unset, blank or not
 * a whole number reads one day (the connector's default); larger values are clamped to 35 days.
 * The connector applies it only while a repository has no cursor; the per-run cap still holds, so
 * a long first window is read over catch-up runs and later ticks.
 */
export function githubInitialLookbackDays(env: Pick<Env, "GITHUB_INITIAL_LOOKBACK_DAYS">): number {
  const value = env.GITHUB_INITIAL_LOOKBACK_DAYS?.trim() ?? "";
  if (!/^\d+$/u.test(value)) return 1;
  return Math.min(Math.max(Number(value), 1), MAX_INITIAL_LOOKBACK_DAYS);
}

export default {
  async scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    const target = cronTarget(controller.cron, env.DIGEST_CRON, env.REVIEW_QUEUE_CRON, env.IDENTITY_LINKS_CRON, env.KIP_PAGES_CRON);
    if (target === "identity-links") {
      // W85: with the flag unset the tick does nothing; W81: it never starts the publication.
      if (identityLinksSet(env.IDENTITY_LINKS)) context.waitUntil(identityLinksRun(env, {}).then(() => undefined));
      return;
    }
    if (target === "kip-pages") {
      // Spec 019 amendment (7), W98/W99: the kip-pages tick runs that job only, and nothing while `KIP_PAGES` is unset.
      // The scheduled handler has 15 minutes of wall time; the run stops before a request that could outlast 14 (W97).
      if (kipPagesSet(env)) context.waitUntil(kipPagesRun(env, false, Date.now() + KIP_PAGES_CRON_WALL_MS).then(() => undefined));
      return;
    }
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
      // 409 means a run is active or about to start; it reads the same sources this tick would have.
      if (!response.ok && response.status !== 409) {
        throw new Error(`Scheduling publication failed: ${await response.text()}`);
      }
    }));
    // Spec 022: the review ingestion rides the publication tick but runs here, outside the
    // publication's Durable Object, so neither can fail or slow the other. Spec 026: an R2 Class A
    // trip under `enforce` pauses it with the publication.
    if (githubReviewsSet(env)) {
      context.waitUntil(costGuardDecisionFor(env).then((decision) => (decision.pausePublication ? undefined : githubReviewsRun(env, false).then(() => undefined))));
    }
    // Spec 026 Behavior 3: the daily cost check rides the publication tick, also while publication is paused.
    const guard = resolveCostGuardMode(env.COST_GUARD) === "off" ? undefined : costGuardObject(env);
    if (guard !== undefined) {
      context.waitUntil(guard.fetch("https://cost-guard.internal/check", { method: "POST" }).then(async (response) => {
        if (!response.ok) console.error(sanitizeErrorMessage(`The cost check failed: ${response.status}`));
      }));
    }
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
      const searchQuery = env.SEARCH_QUERY_GATE === undefined
        ? unboundQueryGateHealth(new Date())
        : await env.SEARCH_QUERY_GATE.get(env.SEARCH_QUERY_GATE.idFromName(SEARCH_QUERY_GATE_OBJECT_NAME)).fetch("https://search-query.internal/status")
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null);
      const reviewRecord = (key: string) => (githubReviewsSet(env)
        ? env.OSS_KB_BUCKET.get(key).then((object) => (object === null ? null : object.json())).catch(() => null)
        : undefined);
      const githubReviews = await reviewRecord(GITHUB_REVIEWS_LAST_RUN_KEY);
      const githubReviewsBackfill = await reviewRecord(GITHUB_REVIEWS_BACKFILL_LAST_RUN_KEY);
      const githubReviewsRefresh = githubReviewsAreas(env) ? await reviewRecord(GITHUB_REVIEWS_REFRESH_LAST_RUN_KEY) : undefined;
      const costGuard = await costGuardHealth(env);
      const health = mergeHealth(await publisher.json(), digestHealth, reviewQueue, searchEmbedding, searchQuery, githubReviews, githubReviewsBackfill, githubReviewsRefresh, costGuard) as Record<string, unknown>;
      // Spec 019 amendment (7): each job's record only while its flag is set (W91 identityLinks, null before its first run; W100 kipPages).
      const identityLinks = identityLinksSet(env.IDENTITY_LINKS)
        ? await env.OSS_KB_BUCKET.get(IDENTITY_LINKS_LAST_RUN_KEY).then((object) => (object === null ? null : object.json())).catch(() => null)
        : undefined;
      const kipPages = await kipPagesHealth(env);
      return json({
        ...health,
        ...(identityLinks === undefined ? {} : { identityLinks }),
        ...(kipPages === undefined ? {} : { kipPages }),
      });
    }
    if (request.method === "POST" && url.pathname === "/search-embedding/run") {
      if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
      const embedding = searchEmbeddingObject(env);
      if (embedding === undefined) return json({ ok: false, disabled: true }, { status: 403 });
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
      return json(lastRun, { status: lastRun.ok ? 200 : 502 });
    }
    if (request.method === "POST" && url.pathname === "/github-reviews/run") {
      if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
      if (!githubReviewsSet(env)) return json({ ok: false, disabled: true }, { status: 403 });
      // Runs while the caller waits (seconds): no Durable Object holds this job.
      const lastRun = await githubReviewsRun(env, url.searchParams.get("dryRun") === "1");
      return json(lastRun, { status: lastRun.ok ? 200 : 502 });
    }
    if (request.method === "POST" && url.pathname === "/github-reviews/backfill") {
      if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
      if (!githubReviewsSet(env)) return json({ ok: false, disabled: true }, { status: 403 });
      const from = resolveBackfillFrom(url.searchParams.get("from"), Date.now());
      if (!from.ok) return json({ ok: false, error: from.error }, { status: 400 });
      // Spec 022 Behavior 13: one bounded chunk per project, while the caller waits (up to about 70 s).
      const lastRun = await runGithubReviewsBackfill({ ...githubReviewsDeps(env, url.searchParams.get("dryRun") === "1"), from: from.from });
      return json(lastRun, { status: lastRun.ok ? 200 : 502 });
    }
    if (request.method === "POST" && url.pathname === "/github-reviews/refresh-areas") {
      if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
      if (!githubReviewsSet(env)) return json({ ok: false, disabled: true }, { status: 403 });
      // Spec 022 Behavior 15: at most 500 pull requests per project, while the caller waits (about a minute).
      const lastRun = await runGithubReviewsRefresh(githubReviewsDeps(env, url.searchParams.get("dryRun") === "1"));
      return json(lastRun, { status: lastRun.ok ? 200 : 502 });
    }
    if (request.method === "POST" && (url.pathname === "/cost-guard/check" || url.pathname === "/cost-guard/reset")) {
      if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
      if (resolveCostGuardMode(env.COST_GUARD) === "off") return json({ ok: false, disabled: true }, { status: 403 });
      const guard = costGuardObject(env);
      if (guard === undefined) {
        return json({ ok: false, status: "unconfigured", reason: costGuardMissing({ flag: env.COST_GUARD, token: env.CF_ANALYTICS_TOKEN, accountId: env.CF_ACCOUNT_ID, bound: false }) }, { status: 503 });
      }
      const dryRun = url.pathname === "/cost-guard/check" && url.searchParams.get("dryRun") === "1";
      return guard.fetch(`https://cost-guard.internal${url.pathname.slice("/cost-guard".length)}${dryRun ? "?dryRun=1" : ""}`, { method: "POST" });
    }
    if (request.method === "POST" && url.pathname === "/identity-links/run") {
      // W85: off answers as an unknown route, before any other check.
      if (!identityLinksSet(env.IDENTITY_LINKS)) return new Response("Not found", { status: 404 });
      if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
      // Runs while the caller waits (seconds): no Durable Object holds this job.
      const record = await identityLinksRun(env, { dryRun: url.searchParams.get("dryRun") === "1", blind: url.searchParams.get("blind") === "1" });
      return json(record, { status: record.lastRun.ok ? 200 : 502 });
    }
    if (request.method === "POST" && url.pathname === "/kip-pages/run") {
      // W99: no route while the flag is unset.
      if (!kipPagesSet(env)) return new Response("Not found", { status: 404 });
      if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
      // Runs while the caller waits (at most 13 upstream requests, 2 s apart): no Durable Object holds this job.
      const result = await kipPagesRun(env, url.searchParams.get("dryRun") === "1");
      return json(result, { status: result.lastRun?.ok === true ? 200 : 502 });
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

/** Spec 019 amendment (7): one identity-link run over the activity log, the roster and the profiles. */
function identityLinksRun(env: Env, options: { readonly dryRun?: boolean; readonly blind?: boolean }) {
  return runIdentityLinks({
    flag: env.IDENTITY_LINKS,
    bucket: new R2IdentityLinksBucket(env.OSS_KB_BUCKET),
    profiles: PEOPLE_IDENTITY_PROFILES,
    bots: (projectId) => PEOPLE_PROJECTS.find((project) => project.projectId === projectId)?.bots ?? [],
    suppressed: PEOPLE_SUPPRESSED,
    digest: suppressionDigest,
    now: () => Date.now(),
    dryRun: options.dryRun === true,
    blind: options.blind === true,
  });
}

/** Spec 019 slice 2b: the publication's `activityLog` option; none while `PEOPLE_ACTIVITY` is unset or blank. */
export function activityLogOption(env: Pick<Env, "PEOPLE_ACTIVITY" | "OSS_KB_BUCKET">): { readonly activityLog?: ReturnType<typeof activityLogFor> } {
  return peopleActivitySet(env.PEOPLE_ACTIVITY) ? { activityLog: activityLogFor(env) } : {};
}

/** Spec 019 slice 2b: the append the publication runs before compacting its state. */
export function activityLogFor(env: Pick<Env, "PEOPLE_ACTIVITY" | "OSS_KB_BUCKET">) {
  return (events: Parameters<typeof appendActivityLog>[0]["events"], materializedAt: string) => appendActivityLog({
    flag: env.PEOPLE_ACTIVITY,
    bucket: new R2ActivityBucket(env.OSS_KB_BUCKET),
    events,
    materializedAt,
    projectIds: githubProjectProfiles.map((profile) => profile.projectId),
  });
}

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
      return json(healthBody({
        environment: this.env.PUBLICATION_ENVIRONMENT,
        running: this.running,
        scheduled: runPending(false, await this.ctx.storage.getAlarm(), Date.now()),
        phase,
        status,
        followUp: await this.ctx.storage.get<FollowUpMarker>(FOLLOW_UP_KEY),
      }));
    }
    if (request.method !== "POST" || path !== "/run") return new Response("Not found", { status: 404 });
    // Spec 026 Behavior 9: an R2 Class A trip under `enforce` pauses the publication.
    if ((await costGuardDecisionFor(this.env)).pausePublication) return json(COST_GUARD_REFUSAL.body, { status: COST_GUARD_REFUSAL.status });
    // A stale alarm (its retries exhausted) and a follow-up waiting for later (Spec 018) are
    // overwritten below instead of blocking the trigger; the trigger starts a new follow-up count.
    if (runStarting(this.running, await this.ctx.storage.getAlarm(), Date.now())) {
      return json({ ok: false, skipped: "already-running" }, { status: 409 });
    }
    await this.ctx.storage.put("requested-at", request.headers.get("x-scheduled-at") ?? new Date().toISOString());
    await this.ctx.storage.delete("run-lease"); // written by the pre-alarm implementation
    await this.ctx.storage.delete(FOLLOW_UP_KEY);
    await this.ctx.storage.setAlarm(Date.now());
    return json({ ok: true, scheduled: true }, { status: 202 });
  }

  async alarm(): Promise<void> {
    // Spec 026: a follow-up alarm while publication is paused runs nothing and schedules nothing.
    if ((await costGuardDecisionFor(this.env)).pausePublication) {
      console.log("publication: paused by the cost guard");
      return;
    }
    this.running = true;
    try {
      // Sources are read live, so a retry of an attempt that died reads different data; it must
      // publish under its own release id, not rewrite the release-specific keys already written.
      const requestedAt = await this.ctx.storage.get<string>("requested-at");
      await this.ctx.storage.delete("requested-at");
      const materializedAt = requestedAt ?? new Date().toISOString();
      const onPublished = searchEmbeddingTrigger(this.env);
      const status = await runDataPublication({
        environment: this.env.PUBLICATION_ENVIRONMENT,
        materializedAt,
        connector: new GitHubConnector({
          transport: new GitHubFetchTransport(this.env.GITHUB_SOURCE_TOKEN ?? ""),
          maxIssuesPerSource: MAX_ISSUES_PER_SOURCE,
          initialLookbackDays: githubInitialLookbackDays(this.env),
        }),
        // Spec 012: public Apache sources, read anonymously; each may fail without stopping the run.
        sources: [
          { key: "mail", connector: new PonyMailConnector({ fetch: sourceFetch }) },
          { key: "jira", connector: new JiraConnector({ fetch: sourceFetch }) },
        ],
        state: new DurableObjectPipelineState(this.ctx.storage),
        destination: new R2PublicationDestination(this.env.OSS_KB_BUCKET),
        ...(this.env.SEARCH_LEXICAL_REVISION === undefined ? {} : { searchLexicalRevision: this.env.SEARCH_LEXICAL_REVISION }),
        ...(this.env.SEARCH_SHARD_ROOTS === undefined ? {} : { searchShardRoots: this.env.SEARCH_SHARD_ROOTS }),
        ...(onPublished === undefined ? {} : { onPublished }),
        ...activityLogOption(this.env),
      });
      // Spec 018: the Cron fires once a day, so a truncated or failed run schedules its own
      // follow-up. A failure here must not throw: the runtime would run the publication again.
      await scheduleFollowUp(this.ctx.storage, status, Date.now())
        .catch((error: unknown) => console.error(`Scheduling the follow-up run failed: ${errorText(error)}`));
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
      publisherBusy: async () => {
        const publisher = env.PIPELINE_STATE.get(env.PIPELINE_STATE.idFromName(STATE_OBJECT_NAME));
        return publisherBusy(await publisher.fetch("https://pipeline.internal/status").then((response) => response.json()));
      },
      costGuardRefuses: costGuardRefuses(env),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") return json(await this.runner.health());
    if (request.method === "POST" && url.pathname === "/run") {
      const result = await this.runner.request(url.searchParams.get("dryRun") === "1");
      return json(result.body, { status: result.status });
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
      costGuardRefuses: costGuardRefuses(env),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") return json(await this.runner.health());
    if (request.method === "POST" && url.pathname === "/run") {
      const result = await this.runner.request({
        dryRun: url.searchParams.get("dryRun") === "1",
        reset: url.searchParams.get("reset") === "1",
        ...(url.searchParams.get("profile") === null ? {} : { profile: url.searchParams.get("profile")! }),
      });
      return json(result.body, { status: result.status });
    }
    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.runner.alarm();
  }
}

/**
 * Spec 016 slice 3: the only place a search query may reach the embedding model or the vector
 * index. Its own object, storage, and ledger, so query traffic cannot delay a publication or use
 * the embedding job's caps. It has no public route: the Pages reader calls it through a Durable
 * Object binding, and the Worker reads only its `/status`.
 */
export class SearchQueryGate implements DurableObject {
  private readonly gate: SemanticQueryGate;

  constructor(ctx: DurableObjectState, private readonly env: Env) {
    this.gate = createSearchQueryGate({
      storage: {
        get: (key) => ctx.storage.get(key),
        put: (key, value) => ctx.storage.put(key, value),
        delete: async (keys) => { await ctx.storage.delete([...keys]); },
        list: (options) => ctx.storage.list(options),
      },
      flag: env.SEARCH_EMBEDDING,
      gatewayId: env.SEARCH_GATEWAY_ID,
      digestGatewayId: env.DIGEST_GATEWAY_ID,
      ai: env.AI as EmbeddingAiBinding | undefined,
      index: env.SEARCH_VECTORS,
      now: () => new Date(),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") return json(await this.gate.health());
    if (request.method === "GET" && url.pathname === "/month") {
      // Spec 026 Behavior 4: the month's index queries, for the cost guard's Vectorize estimate.
      const month = url.searchParams.get("month") ?? "";
      if (!/^\d{4}-\d{2}$/u.test(month)) return json({ ok: false, error: "month must be YYYY-MM" }, { status: 400 });
      return json({ month, indexQueries: await this.gate.monthIndexQueries(month) });
    }
    if (request.method === "POST" && url.pathname === "/query") {
      // Spec 026 Behavior 9: refused, the answer is over-budget and nothing is counted or called.
      if ((await costGuardDecisionFor(this.env)).refuse) return json({ status: "over-budget", retryAfterMs: COST_GUARD_RETRY_AFTER_MS });
      const body = await request.json().catch(() => undefined);
      return json(await this.gate.query(body as Parameters<SemanticQueryGate["query"]>[0]));
    }
    return new Response("Not found", { status: 404 });
  }
}

/**
 * Spec 026: the account-wide cost guard. Its own object, so a per-query decision never waits on a
 * running publication; one storage key, no R2 operation. Runs only when `/check` is called (the
 * publication tick or the manual route); it has no alarm.
 */
export class CostGuard implements DurableObject {
  private readonly runner: CostGuardRunner;

  constructor(ctx: DurableObjectState, env: Env) {
    this.runner = new CostGuardRunner({
      storage: { get: (key) => ctx.storage.get(key), put: (key, value) => ctx.storage.put(key, value) },
      flag: env.COST_GUARD,
      token: env.CF_ANALYTICS_TOKEN,
      accountId: env.CF_ACCOUNT_ID,
      fetch: (url, init) => fetch(url, init),
      now: () => new Date(),
      inApp: inAppSources(env, () => new Date()),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") return json(await this.runner.health());
    if (request.method === "GET" && url.pathname === "/decision") return json(await this.runner.decision());
    if (request.method === "POST" && url.pathname === "/check") return json(await this.runner.check({ dryRun: url.searchParams.get("dryRun") === "1" }));
    if (request.method === "POST" && url.pathname === "/reset") return json(await this.runner.reset());
    return new Response("Not found", { status: 404 });
  }
}
