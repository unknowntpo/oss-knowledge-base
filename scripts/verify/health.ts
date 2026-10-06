// bun run verify:health -- --target dev
// Compares the publisher's /health with the generatedAt the page reads from /api/feed.
// Read-only: GET only; it never calls the publisher's POST /run.
import { STALE_AFTER_MS } from "../../apps/web/src/freshness";
import { formatHealth, judgeHealth, parseHealthArgs, targets, UsageError, type HealthReport } from "./args";

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return response.json();
}

async function main(): Promise<void> {
  const { target } = parseHealthArgs(process.argv.slice(2));
  const { pages, publisher } = targets[target];
  const feed = (await getJson(`${pages}/api/feed`)) as {
    metadata?: { stale?: boolean; manifest?: { generatedAt?: string; releaseId?: string } };
  };
  let publisherReport: HealthReport["publisher"];
  if (publisher) {
    const health = (await getJson(`${publisher}/health`)) as {
      running?: boolean;
      phase?: unknown;
      lastRun?: { ok?: boolean; completedAt?: string; feedReleaseId?: string };
    };
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
  if (verdict.consistent === false) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof UsageError ? `usage: ${error.message}` : error instanceof Error ? error.message : error);
  process.exit(error instanceof UsageError ? 2 : 1);
});
