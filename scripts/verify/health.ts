// bun run verify:health -- --target dev
// Compares the publisher's /health with the generatedAt the page reads from /api/feed.
// Read-only: GET only; it never calls the publisher's POST /run.
import { STALE_AFTER_MS } from "../../apps/web/src/freshness";
import { getWithAccess, readAccessHeaders, type AccessHeaders } from "./access";
import { formatHealth, judgeHealth, parseHealthArgs, reviewQueueLine, targets, UsageError, type HealthReport } from "./args";

// The Access token goes only to the Dev Pages origin (scripts/verify/access.ts), never to the publisher.
async function getJson(url: string, access: AccessHeaders | undefined): Promise<unknown> {
  const response = await getWithAccess(url, access);
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return response.json();
}

async function main(): Promise<void> {
  const { target } = parseHealthArgs(process.argv.slice(2));
  const { pages, publisher } = targets[target];
  const access = readAccessHeaders(process.env);
  const feed = (await getJson(`${pages}/api/feed`, access)) as {
    metadata?: { stale?: boolean; manifest?: { generatedAt?: string; releaseId?: string } };
  };
  let publisherReport: HealthReport["publisher"];
  let reviewQueue: unknown;
  if (publisher) {
    const health = (await getJson(`${publisher}/health`, access)) as {
      running?: boolean;
      phase?: unknown;
      lastRun?: { ok?: boolean; completedAt?: string; feedReleaseId?: string };
      reviewQueue?: unknown;
    };
    reviewQueue = health.reviewQueue ?? null;
    publisherReport = {
      url: publisher,
      running: health.running,
      phase: health.phase,
      lastRunOk: health.lastRun?.ok,
      completedAt: health.lastRun?.completedAt,
      feedReleaseId: health.lastRun?.feedReleaseId,
    };
  }
  const report: HealthReport = {
    target,
    now: new Date().toISOString(),
    ...(publisherReport ? { publisher: publisherReport } : {}),
    feed: {
      url: pages,
      generatedAt: feed.metadata?.manifest?.generatedAt,
      releaseId: feed.metadata?.manifest?.releaseId,
      stale: feed.metadata?.stale,
    },
  };
  const verdict = judgeHealth(report, STALE_AFTER_MS);
  console.log(formatHealth(report, verdict));
  if (publisher) console.log(reviewQueueLine(reviewQueue, report.now));
  if (verdict.consistent === false) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof UsageError ? `usage: ${error.message}` : error instanceof Error ? error.message : error);
  process.exit(error instanceof UsageError ? 2 : 1);
});
