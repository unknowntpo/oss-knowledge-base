// bun run measure:daily-volume [-- --hours 24]
// Spec 018 T13: how many issues each source updated in the last N hours, against the per-run
// caps of the publisher (200 issues per GitHub repository, 200 Jira issues). Three public GETs
// (GitHub search, ASF Jira); `GITHUB_TOKEN`, when set, is sent to api.github.com only.
import { githubProjectProfiles } from "../packages/reference-pipeline/src/config";
import { JIRA_SEARCH_URL, SOURCE_USER_AGENT } from "../packages/reference-pipeline/src/kafka-connectors";

/** `MAX_ISSUES_PER_SOURCE` (apps/data-publisher-worker/src/index.ts) and the `JiraConnector` default. */
export const PER_RUN_CAP = 200;

export function volumeLine(source: string, updated: number, hours: number, cap = PER_RUN_CAP): string {
  const runs = Math.max(1, Math.ceil(updated / cap));
  return `${source}: ${updated} updated in ${hours} h; cap ${cap} per run; ${updated <= cap ? "fits one run" : `needs ${runs} runs (${runs - 1} catch-up)`}`;
}

async function count(url: string, headers: Record<string, string>, field: "total_count" | "total"): Promise<number> {
  const response = await fetch(url, { headers: { "User-Agent": SOURCE_USER_AGENT, Accept: "application/json", ...headers } });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  const value = (await response.json() as Record<string, unknown>)[field];
  if (typeof value !== "number") throw new Error(`GET ${url}: no ${field}`);
  return value;
}

if (import.meta.main) {
  const flag = process.argv.indexOf("--hours");
  const hours = flag < 0 ? 24 : Number(process.argv[flag + 1]);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new Error("--hours must be a whole number from 1 to 720");
  const since = new Date(Date.now() - hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/u, "Z");
  const token = process.env.GITHUB_TOKEN?.trim() ?? "";
  console.log(`measured at ${new Date().toISOString()}`);
  for (const profile of githubProjectProfiles) {
    const query = encodeURIComponent(`repo:${profile.owner}/${profile.repo} updated:>=${since}`);
    const updated = await count(`https://api.github.com/search/issues?q=${query}&per_page=1`, token === "" ? {} : { Authorization: `Bearer ${token}` }, "total_count");
    console.log(volumeLine(profile.sourceInstanceId, updated, hours));
  }
  const jql = new URLSearchParams({ jql: `project = KAFKA AND updated >= "-${hours * 60}m"`, maxResults: "0" });
  console.log(volumeLine("kafka:jira", await count(`${JIRA_SEARCH_URL}?${jql.toString()}`, {}, "total"), hours));
}
