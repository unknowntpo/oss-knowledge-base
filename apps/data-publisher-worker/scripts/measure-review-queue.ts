/**
 * Spec 015 Q34–Q36, Q38: `bun run measure:review-queue [-- --feed <url> --warm --scale N --memory-only]`.
 *
 * Runs the real review-queue job (src/review-queue/run.ts) against live GitHub GraphQL, Pony Mail,
 * and the ASF roster, with an in-memory bucket seeded from the Feed index at `--feed` (default: the
 * Dev `/api/feed`). Requests are sequential and paced as in production. GitHub needs a token:
 * GITHUB_SOURCE_TOKEN, else the `gh` CLI login. The token is never printed. `--warm` runs a second
 * time to show the cached cost; `--scale N` measures heap growth parsing the Feed index with its
 * entries repeated N times; `--memory-only` skips the network job.
 */
import { heapStats } from "bun:jsc";
import { MANIFEST_KEY } from "@oss-knowledge-base/serving-contract";
import { asfRosterAdapter, KAFKA_REVIEW_PROFILE } from "@oss-knowledge-base/reference-pipeline";
import { runReviewQueue, type ReviewQueueLastRun } from "../src/review-queue/run";
import type { ReviewQueueBucket } from "../src/review-queue/store";

const DEV_FEED = "https://oss-knowledge-base-dev.pages.dev/api/feed";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

class CountingBucket implements ReviewQueueBucket {
  readonly objects = new Map<string, { body: string; etag: string }>();
  operations = 0;
  private version = 0;
  set(key: string, body: string): void {
    this.objects.set(key, { body, etag: `e${(this.version += 1)}` });
  }
  async getJson(key: string) {
    this.operations += 1;
    const object = this.objects.get(key);
    return object === undefined ? undefined : JSON.parse(object.body);
  }
  async getWithEtag(key: string) {
    this.operations += 1;
    const object = this.objects.get(key);
    return object === undefined ? undefined : { value: JSON.parse(object.body), etag: object.etag };
  }
  async putIfAbsent(key: string, body: string) {
    this.operations += 1;
    if (this.objects.has(key)) return false;
    this.set(key, body);
    return true;
  }
  async putPointerIfMatch(key: string, body: string, etag: string | null) {
    this.operations += 1;
    if ((this.objects.get(key)?.etag ?? null) !== etag) return false;
    this.set(key, body);
    return true;
  }
  async put(key: string, body: string) {
    this.operations += 1;
    this.set(key, body);
  }
}

async function githubToken(): Promise<string> {
  const fromEnv = process.env.GITHUB_SOURCE_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const child = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
  const token = (await new Response(child.stdout).text()).trim();
  if ((await child.exited) !== 0 || token === "") throw new Error("No GitHub token: set GITHUB_SOURCE_TOKEN or log in with gh");
  return token;
}

/** JSC heap size; Bun's `process.memoryUsage().heapUsed` does not move with JSON.parse. */
function heapMb(): number {
  Bun.gc(true);
  return heapStats().heapSize / 2 ** 20;
}

const retained: unknown[] = [];

/**
 * Heap growth of the parsed Feed index, as the job holds it after R2's `object.json()`; the text is
 * built before measuring, because the Worker parses from the response stream.
 */
function measureParse(source: string, scale: number): number {
  const text = scale === 1 ? source : (() => {
    const parsed = JSON.parse(source) as { entries: unknown[] };
    return JSON.stringify({ ...parsed, entries: Array.from({ length: scale }, () => parsed.entries).flat() });
  })();
  const before = heapMb();
  retained.push(JSON.parse(text));
  const growth = heapMb() - before;
  retained.length = 0;
  return growth;
}

function describeRun(label: string, run: ReviewQueueLastRun, bucketOps: number): string {
  const source = (name: string, value: { requests: number; bytes: number; durationMs: number; ok: boolean; failureKind?: string } | null) =>
    value === null ? `${name}: skipped` : `${name}: ${value.requests} requests, ${(value.bytes / 1024).toFixed(0)} KB, ${(value.durationMs / 1000).toFixed(1)} s, ok=${value.ok}${value.failureKind ? ` (${value.failureKind})` : ""}`;
  const requests = run.sources.github.requests + (run.sources.mail?.requests ?? 0) + run.sources.roster.requests;
  return [
    `${label}: ok=${run.ok} total ${(run.durationMs / 1000).toFixed(1)} s`,
    `  ${source("github", run.sources.github)}`,
    `  ${source("mail", run.sources.mail)}`,
    `  ${source("roster", run.sources.roster)}`,
    `  subrequests ≈ ${requests} upstream + ${bucketOps} R2 operations = ${requests + bucketOps} (limit 20,000)`,
    `  counts ${JSON.stringify(run.counts)}; unavailable ${run.unavailable}; droppedNodes ${run.droppedNodes}`,
  ].join("\n");
}

const feedUrl = flag("feed") ?? DEV_FEED;
const scale = Number(flag("scale") ?? "1");
const feedText = feedUrl.startsWith("http") ? await (await fetch(feedUrl)).text() : await Bun.file(feedUrl).text();
console.log(`feed ${feedUrl}: ${(feedText.length / 2 ** 20).toFixed(2)} MB`);
console.log(`heap growth parsing the Feed index at ${scale}x: ${measureParse(feedText, scale).toFixed(1)} MB (Q36 limit 80 MB at 2x)`);

if (!process.argv.includes("--memory-only")) {
  const feed = JSON.parse(feedText) as { entries: unknown[]; metadata?: { manifest?: { releaseId?: string; generatedAt?: string } } };
  const bucket = new CountingBucket();
  bucket.set(MANIFEST_KEY, JSON.stringify({
    schema: "osskb.feed-manifest.v3", releaseId: feed.metadata?.manifest?.releaseId ?? "measure", generatedAt: feed.metadata?.manifest?.generatedAt ?? new Date().toISOString(),
    feedIndexKey: "measure/feed.json", detailMapKey: "measure/details.json", entryCount: feed.entries.length,
  }));
  bucket.set("measure/feed.json", JSON.stringify({ entries: feed.entries }));
  const deps = {
    bucket, profile: KAFKA_REVIEW_PROFILE, githubToken: await githubToken(),
    githubFetch: (url: string, init: RequestInit) => fetch(url, init),
    apacheFetch: (url: string, init: RequestInit) => fetch(url, init),
    rosterAdapter: asfRosterAdapter, now: () => Date.now(),
    delay: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const before = bucket.operations;
  const cold = await runReviewQueue(deps);
  console.log(describeRun("cold run", cold.lastRun, bucket.operations - before));
  if (process.argv.includes("--warm")) {
    const middle = bucket.operations;
    const warm = await runReviewQueue(deps);
    console.log(describeRun("warm run", warm.lastRun, bucket.operations - middle));
  }
}
