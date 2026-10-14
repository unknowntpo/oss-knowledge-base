// GITHUB_TOKEN=… bun run measure:github-reviews [-- --days 1]
// Spec 022 RV21, RV23: one first run of the review ingestion against the live GitHub API, reading
// the last N days (1 to 35), with an in-memory bucket. Read-only: GET listings and GraphQL queries
// of public repositories; nothing is written anywhere. Prints requests, GraphQL cost, rows and the
// size of the month objects the run would store.
import { runGithubReviews } from "../src/github-reviews/run";
import type { GithubReviewsBucket } from "../src/github-reviews/store";
import { githubReviewsProjects } from "../src/github-reviews/projects";

class MemoryBucket implements GithubReviewsBucket {
  readonly objects = new Map<string, string>();
  gets = 0;
  puts = 0;
  async get(key: string) {
    this.gets += 1;
    const body = this.objects.get(key);
    return body === undefined ? undefined : { body, etag: String(body.length) };
  }
  async putIfMatch(key: string, body: string): Promise<boolean> {
    this.puts += 1;
    this.objects.set(key, body);
    return true;
  }
  async put(key: string, body: string): Promise<void> {
    this.puts += 1;
    this.objects.set(key, body);
  }
}

if (import.meta.main) {
  const flag = process.argv.indexOf("--days");
  const days = flag < 0 ? 1 : Number(process.argv[flag + 1]);
  if (!Number.isInteger(days) || days < 1 || days > 35) throw new Error("--days must be a whole number from 1 to 35");
  const token = process.env.GITHUB_TOKEN?.trim() ?? "";
  if (token === "") throw new Error("Set GITHUB_TOKEN (any token that can read public repositories)");
  const bucket = new MemoryBucket();
  const run = await runGithubReviews({
    flag: "metadata@1",
    bucket,
    projects: githubReviewsProjects,
    githubToken: token,
    githubFetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    firstRunLookbackMs: days * 86_400_000,
  });
  console.log(`measured at ${run.startedAt}; window ${days} day(s); run ${run.ok ? "ok" : `failed (${run.failureKind})`}; ${run.durationMs} ms; R2 ${bucket.gets} reads, ${bucket.puts} writes`);
  for (const [projectId, project] of Object.entries(run.projects)) {
    const months = [...bucket.objects].filter(([key]) => key.includes(`/${projectId}/`) && /\d{4}-\d{2}\.json$/u.test(key));
    const bytes = months.reduce((sum, [, body]) => sum + new TextEncoder().encode(body).length, 0);
    console.log(
      `${projectId}: ${project.ok ? "ok" : `failed ${project.failureKind}: ${project.error}`}; listed ${project.listed}, pull requests ${project.pulls}${project.truncated ? " (truncated)" : ""}; ` +
      `reviews ${project.reviews} (bot ${project.botReviews}, by the author ${project.selfReviews}); ` +
      `requests ${project.restRequests} REST + ${project.graphqlRequests} GraphQL (cost ${project.graphqlCost}); response ${project.bytes} chars; ` +
      `${months.length} month object(s), ${bytes} bytes${project.reviews === 0 ? "" : `, ${(bytes / project.reviews).toFixed(0)} bytes a row`}; ${project.durationMs} ms`,
    );
  }
}
