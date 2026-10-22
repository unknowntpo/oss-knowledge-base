/** Steps 0–1 of B26: the flag (B25) and the firings of this environment (B27, B28). */
import type { CiRelease, CiRun, Env, Firing, Health, Mode, RuleEntry } from "./types";

export function parseFlag(value: string | undefined): { mode: Mode; reason?: "invalid-flag" } {
  if (value === "dry" || value === "live") return { mode: value };
  if (value === undefined || value === "off") return { mode: "off" };
  return { mode: "off", reason: "invalid-flag" };
}

/** B28: incident types 1–4 of v1; any other rule id is recorded `notDiagnosed: "out-of-scope"`. */
export const V1_RULES: Readonly<Record<string, 1 | 2 | 3 | 4>> = {
  "job.missed": 1,
  "publication.freshness": 1,
  "digest.freshness": 1,
  "job.failures": 2,
  "source.success": 2,
  tripped: 3,
  "job.r2ClassA": 3,
  "r2.classAInvariant": 3,
  "ci.release": 4,
};

export const COST_GUARD_JOB = "cost-guard";
export const CI_JOB = "ci.release";

/**
 * B27: Spec 028 `firing` entries, a tripped cost guard (`since` = `breaker.trippedAt`) and a failed
 * `ci.release`. `warn` and `unknown` start nothing; without `signals` only the other two can fire.
 */
export function collectFirings(env: Env, health: Health, ci: CiRelease): { firings: Firing[]; signals: "available" | "unavailable" } {
  const firings: Firing[] = [];
  const signals = health.signals as { rules?: unknown } | null | undefined;
  const rules = signals !== null && typeof signals === "object" && Array.isArray(signals.rules) ? (signals.rules as RuleEntry[]) : undefined;
  for (const entry of rules ?? []) {
    if (entry.status !== "firing" || typeof entry.since !== "string") continue;
    firings.push({ env, job: entry.job, ruleId: entry.id, since: entry.since, runId: entry.runId ?? null, entry });
  }
  const costGuard = health.costGuard as { status?: unknown; breaker?: { trippedAt?: unknown } } | null | undefined;
  if (costGuard?.status === "tripped" && typeof costGuard.breaker?.trippedAt === "string") {
    firings.push({ env, job: COST_GUARD_JOB, ruleId: "tripped", since: costGuard.breaker.trippedAt, runId: null, entry: costGuard.breaker });
  }
  if (ci.status === "firing" && ci.run !== undefined) {
    firings.push({ env, job: CI_JOB, ruleId: CI_JOB, since: ci.run.createdAt, runId: String(ci.run.id), entry: ci.run });
  }
  return { firings, signals: rules === undefined ? "unavailable" : "available" };
}

export const GITHUB_REPO = "https://api.github.com/repos/unknowntpo/oss-knowledge-base";
export const CI_TIMEOUT_MS = 20_000;

/** One GET to the public GitHub API: no `Authorization`, a timeout, JSON or a thrown reason. */
export async function githubGet(fetchFn: typeof fetch, path: string, timeoutMs = CI_TIMEOUT_MS): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(`${GITHUB_REPO}${path}`, {
      method: "GET",
      headers: { accept: "application/vnd.github+json", "user-agent": "oss-knowledge-base-sre-agent" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "network error");
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

interface GithubRun { id: number; head_branch: string; conclusion: string | null; created_at: string; html_url: string }

/** Numeric parts of a `v<major>.<minor>…` tag; `undefined` for any other tag. */
function version(tag: string): number[] | undefined {
  if (!/^v\d/u.test(tag)) return undefined;
  return tag.slice(1).split(/[.-]/u).map((part) => Number.parseInt(part, 10)).map((part) => (Number.isNaN(part) ? -1 : part));
}

function newer(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** The highest `v*` tag by version (the matching-refs API lists refs alphabetically). */
async function newestTag(fetchFn: typeof fetch, timeoutMs: number | undefined): Promise<string | undefined> {
  const refs = await githubGet(fetchFn, "/git/matching-refs/tags/v", timeoutMs) as { ref?: string }[];
  let best: { tag: string; parts: number[] } | undefined;
  for (const { ref } of Array.isArray(refs) ? refs : []) {
    const tag = ref?.replace(/^refs\/tags\//u, "") ?? "";
    const parts = version(tag);
    if (parts !== undefined && (best === undefined || newer(parts, best.parts))) best = { tag, parts };
  }
  return best?.tag;
}

/**
 * B27 `ci.release`: Dev reads the newest completed `ci.yml` run on `main`; Prod finds the newest `v*`
 * tag, then the newest completed run on that tag. `failure` fires; an HTTP error, rate limit,
 * timeout, or a missing tag or run is `unknown`. Dev ≤ 2 GETs, Prod ≤ 3 (the tag lookup).
 */
export async function readCiRelease(env: Env, fetchFn: typeof fetch, options: { timeoutMs?: number } = {}): Promise<CiRelease> {
  try {
    const branch = env === "dev" ? "main" : await newestTag(fetchFn, options.timeoutMs);
    if (branch === undefined) return { status: "unknown", reason: "no tag" };
    const query = `?branch=${encodeURIComponent(branch)}&event=push&status=completed&per_page=1`;
    const body = await githubGet(fetchFn, `/actions/workflows/ci.yml/runs${query}`, options.timeoutMs) as { workflow_runs?: GithubRun[] };
    const newest = (body.workflow_runs ?? []).find((run) => run.head_branch === branch);
    if (newest === undefined) return { status: "unknown", reason: "no run" };
    const run: CiRun = { id: newest.id, conclusion: newest.conclusion, headBranch: newest.head_branch, createdAt: newest.created_at, htmlUrl: newest.html_url };
    if (run.conclusion !== "failure") return { status: "ok", run };
    const jobs = await githubGet(fetchFn, `/actions/runs/${run.id}/jobs`, options.timeoutMs).catch(() => undefined) as { jobs?: { name: string; conclusion: string | null }[] } | undefined;
    const failedJob = jobs?.jobs?.find((job) => job.conclusion === "failure")?.name;
    return { status: "firing", run, ...(failedJob === undefined ? {} : { failedJob }) };
  } catch (error) {
    return { status: "unknown", reason: (error as Error).message };
  }
}
