// GITHUB_TOKEN=… bun run measure:github-reviews [-- --days 1 | -- --backfill-from 2025-10-14]
// Spec 022 RV21, RV23: one first run of the review ingestion against the live GitHub API, reading
// the last N days (1 to 35), with an in-memory bucket. Read-only: GET listings and GraphQL queries
// of public repositories; nothing is written anywhere. Prints requests, GraphQL cost, rows and the
// size of the month objects the run would store. `--backfill-from` (Spec 022 RV35) instead seeds a
// daily cursor one day back and repeats the backfill call until every project is done, printing
// each call and the totals: calls, requests, R2 reads and writes, rows and month-object bytes.
import { resolveBackfillFrom } from "@oss-knowledge-base/reference-pipeline";
import { GITHUB_REVIEWS_STATE_SCHEMA, runGithubReviews, runGithubReviewsBackfill } from "../src/github-reviews/run";
import { githubReviewsStateKey, type GithubReviewsBucket } from "../src/github-reviews/store";
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

async function measureBackfill(token: string, value: string): Promise<void> {
  const from = resolveBackfillFrom(value, Date.now());
  if (!from.ok) throw new Error(from.error);
  const bucket = new MemoryBucket();
  const start = Date.now();
  for (const project of githubReviewsProjects) {
    bucket.objects.set(githubReviewsStateKey(project.projectId), JSON.stringify({ schema: GITHUB_REVIEWS_STATE_SCHEMA, updatedAt: new Date(start).toISOString(), coverageFrom: new Date(start - 86_400_000).toISOString() }));
  }
  const totals = { calls: 0, rest: 0, graphql: 0, cost: 0, maxCallMs: 0 };
  for (let call = 1; call <= 60; call += 1) {
    const run = await runGithubReviewsBackfill({
      flag: "metadata@1", bucket, projects: githubReviewsProjects, githubToken: token, githubFetch: (url, init) => fetch(url, init),
      now: () => Date.now(), delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), from: from.from,
    });
    totals.calls += 1;
    totals.maxCallMs = Math.max(totals.maxCallMs, run.durationMs);
    const projects = Object.entries(run.projects);
    for (const [, project] of projects) {
      totals.rest += project.restRequests;
      totals.graphql += project.graphqlRequests;
      totals.cost += project.graphqlCost;
    }
    console.log(`call ${call}: ${run.ok ? "ok" : `failed (${run.failureKind})`}; ${run.durationMs} ms; ` +
      projects.map(([id, project]) => `${id} ${project.done ? "done" : "more"} pulls ${project.pulls} rows +${project.added} months ${project.monthsWritten} requests ${project.restRequests}+${project.graphqlRequests} cursor ${project.cursor}`).join("; "));
    if (!run.ok || projects.every(([, project]) => project.done)) break;
  }
  console.log(`totals: ${totals.calls} calls; ${totals.rest} REST + ${totals.graphql} GraphQL requests (cost ${totals.cost}); longest call ${totals.maxCallMs} ms; R2 ${bucket.gets} reads, ${bucket.puts} writes`);
  for (const project of githubReviewsProjects) {
    const months = [...bucket.objects].filter(([key]) => key.includes(`/${project.projectId}/`) && /\d{4}-\d{2}\.json$/u.test(key));
    const rows = months.reduce((sum, [, body]) => sum + (JSON.parse(body) as { rows: unknown[] }).rows.length, 0);
    const sizes = months.map(([, body]) => new TextEncoder().encode(body).length);
    console.log(`${project.projectId}: ${months.length} month objects, ${rows} rows, ${sizes.reduce((a, b) => a + b, 0)} bytes, largest ${Math.max(0, ...sizes)} bytes`);
  }
}

if (import.meta.main) {
  const backfill = process.argv.indexOf("--backfill-from");
  if (backfill >= 0) {
    const token = process.env.GITHUB_TOKEN?.trim() ?? "";
    if (token === "") throw new Error("Set GITHUB_TOKEN (any token that can read public repositories)");
    await measureBackfill(token, process.argv[backfill + 1] ?? "");
    process.exit(0);
  }
  const flag = process.argv.indexOf("--days");
  const days = flag < 0 ? 1 : Number(process.argv[flag + 1]);
  if (!Number.isInteger(days) || days < 1 || days > 35) throw new Error("--days must be a whole number from 1 to 35");
  const token = process.env.GITHUB_TOKEN?.trim() ?? "";
  if (token === "") throw new Error("Set GITHUB_TOKEN (any token that can read public repositories)");
  // Spec 022 RV44: `--revision metadata@2` also reads labels, title KIPs and names, and reports what they add.
  const revisionAt = process.argv.indexOf("--revision");
  const revision = revisionAt < 0 ? "metadata@1" : process.argv[revisionAt + 1] ?? "";
  if (revision !== "metadata@1" && revision !== "metadata@2") throw new Error("--revision must be metadata@1 or metadata@2");
  const bucket = new MemoryBucket();
  const run = await runGithubReviews({
    flag: revision,
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
    const extraBytes = months.reduce((sum, [, body]) => {
      const object = JSON.parse(body) as { pulls?: unknown; people?: unknown };
      return sum + (object.pulls === undefined ? 0 : JSON.stringify(object.pulls).length + 9) + (object.people === undefined ? 0 : JSON.stringify(object.people).length + 10);
    }, 0);
    console.log(
      `${projectId}: ${project.ok ? "ok" : `failed ${project.failureKind}: ${project.error}`}; listed ${project.listed}, pull requests ${project.pulls}${project.truncated ? " (truncated)" : ""}; ` +
      `reviews ${project.reviews} (bot ${project.botReviews}, by the author ${project.selfReviews}); ` +
      `requests ${project.restRequests} REST + ${project.graphqlRequests} GraphQL (cost ${project.graphqlCost}); response ${project.bytes} chars; ` +
      `${months.length} month object(s), ${bytes} bytes${project.reviews === 0 ? "" : `, ${(bytes / project.reviews).toFixed(0)} bytes a row`}` +
      `${revision === "metadata@2" ? `; pulls and people ${extraBytes} bytes (${(extraBytes / Math.max(1, bytes - extraBytes) * 100).toFixed(1)}%), labels truncated ${project.labelsTruncated}` : ""}; ${project.durationMs} ms`,
    );
  }
}
