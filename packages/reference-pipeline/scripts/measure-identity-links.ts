/**
 * Spec 019 amendment (7), the identity-link job's committed measurements.
 *
 * Precision check (W89), read-only, public upstream data only:
 *
 *   bun run measure:identity-links -- --from 2026-09-15 --to 2026-10-21 [--blind] [--record <file>] [--json]
 *   bun run measure:identity-links -- --replay <file> [--blind] [--json]
 *
 * reads apache/kafka pull requests created in the window whose title names a `KAFKA-n` (GitHub
 * search, through `gh api` unless `GITHUB_TOKEN` is set), the KAFKA Jira issues those titles name
 * plus the issues updated in the window whose summary names a KIP (ASF Jira REST, anonymous), and
 * the dev@ messages of the window whose subject names a KIP (Pony Mail, anonymous). It converts them
 * into activity months exactly as the activity log does (`activityMonthsFromEvents`), runs
 * `computeIdentityLinks` with the Kafka profile and no roster, and classifies the corroborated links
 * against the committers page (`classifyPrecision`). `--record` also writes the months as a fixture;
 * `--replay` runs the same computation from such a fixture without any request.
 *
 * Budget (W86): `bun run measure:identity-links -- --budget` runs the worker job against an
 * in-memory bucket of Dev's size (apps/data-publisher-worker/scripts/measure-identity-links-budget.ts).
 * `-- --backfill` (Spec 019 amendment (8), W129) runs it with 11 finished backfill months and
 * `IDENTITY_LINKS_BACKFILL=read`.
 *
 * Kept per record: GitHub number, title, URL, author login, bot flag, creation and merge time; Jira
 * key, summary, update time and the reporter's and assignee's key and display name; dev@ mid, time,
 * subject and the sender's display name (`mailAuthor`). Never an address, a Jira `name`, a time zone
 * or an avatar.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import type { DomainEventV1 } from "@oss-knowledge-base/domain";

import { canonicalJson, sha256 } from "../src/canonical";
import type { GitHubEventDataV1 } from "../src/event-data";
import { jiraEventsFrom, mailEventFrom } from "../src/kafka-events";
import { extractKeys, mailAuthor, threadTitle } from "../src/kafka-rules";
import { PEOPLE_ACTIVITY_SCHEMA, type ActivityMonthV1 } from "../src/people/activity";
import { activityMonthsFromEvents } from "../src/people/activity-log";
import { classifyPrecision, computeIdentityLinks, IdentityFacts, type IdentityLinkCounts, type IdentityLinksTableV1, type PrecisionReport } from "../src/people/identity-links";
import { KAFKA_IDENTITY_PROFILE } from "../src/people/identity-profile";
import { KAFKA_COMMITTERS_CAPTURE } from "../src/people/kafka-committers.capture";
import { PEOPLE_PROJECTS } from "../src/people";

const PROJECT_ID = "apache-kafka";
const GITHUB_SEARCH = "https://api.github.com/search/issues";
const JIRA_SEARCH = "https://issues.apache.org/jira/rest/api/2/search";
const PONY_STATS = "https://lists.apache.org/api/stats.lua";
const UPSTREAM_SCHEMA = "osskb.identity-links-upstream.v1";

/** The minimal upstream records the conversion needs. */
export interface UpstreamPull {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly login: string;
  readonly isBot: boolean;
  readonly createdAt: string;
  readonly mergedAt: string | null;
}
export interface UpstreamAccount {
  readonly key: string;
  readonly displayName: string;
}
export interface UpstreamIssue {
  readonly key: string;
  readonly summary: string;
  /** Jira's `updated` (`2026-09-29T20:24:00.702+0000`). */
  readonly updated: string;
  readonly reporter: UpstreamAccount | null;
  readonly assignee: UpstreamAccount | null;
}
export interface UpstreamMessage {
  readonly mid: string;
  readonly epoch: number;
  readonly subject: string;
  /** `mailAuthor` of the `From` value: the display name only. */
  readonly author: string;
}

/** The records as events built by the connectors' own builders, then the activity log's conversion. */
export function upstreamActivityMonths(input: {
  readonly pulls: readonly UpstreamPull[];
  readonly issues: readonly UpstreamIssue[];
  readonly messages: readonly UpstreamMessage[];
}): readonly ActivityMonthV1[] {
  const events: DomainEventV1[] = [];
  for (const pull of input.pulls) {
    const entityId = `kafka:github:pull:${pull.number}`;
    const data: GitHubEventDataV1 = {
      contract: "github-record@1", recordKind: "pull-request", externalNumber: pull.number, title: pull.title,
      excerpt: "", author: pull.login, authorRole: "NONE", occurredAt: pull.createdAt, createdAt: pull.createdAt,
      updatedAt: pull.createdAt, labels: [], isBot: pull.isBot, ...(pull.mergedAt === null ? {} : { mergedAt: pull.mergedAt }),
    };
    events.push({
      schemaVersion: 1,
      id: `sha256:${sha256(canonicalJson({ projectId: PROJECT_ID, sourceInstanceId: "kafka:github", entityId, sourceCursor: pull.createdAt }))}`,
      projectId: PROJECT_ID, sourceType: "github", sourceInstanceId: "kafka:github", entityType: "artifact", entityId,
      eventType: "updated", sourceCursor: pull.createdAt, sourceTimestamp: pull.createdAt, observedAt: pull.createdAt,
      canonicalUrl: pull.url, payloadRef: `content-addressed://sha256/${sha256(canonicalJson(data))}`,
      sourceConnectorVersion: "github@1", communityProfileVersion: "measure", data,
    } as unknown as DomainEventV1);
  }
  for (const issue of input.issues) {
    const parsed = jiraEventsFrom({
      key: issue.key,
      fields: { summary: issue.summary, updated: issue.updated, reporter: issue.reporter, assignee: issue.assignee },
    }, new Date().toISOString());
    if (parsed.kind === "events") events.push(...parsed.events);
  }
  for (const message of input.messages) {
    // The message's own time as the observation time: the connector's 30-day window does not apply here.
    const observedAt = new Date(message.epoch * 1000).toISOString();
    const parsed = mailEventFrom({ mid: message.mid, epoch: message.epoch, subject: message.subject, from: message.author }, observedAt);
    if (parsed.kind === "event") events.push(parsed.event);
  }
  return activityMonthsFromEvents(events, "");
}

interface Requests {
  github: { requests: number; bytes: number };
  jira: { requests: number; bytes: number };
  mail: { requests: number; bytes: number };
  urls: string[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function githubSearch(query: string, page: number, requests: Requests): Promise<{ total_count: number; incomplete_results: boolean; items: unknown[] }> {
  const params = new URLSearchParams({ q: query, per_page: "100", page: String(page) });
  requests.urls.push(`${GITHUB_SEARCH}?${params}`);
  requests.github.requests += 1;
  let text: string;
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) {
    const response = await fetch(`${GITHUB_SEARCH}?${params}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "osskb-measure-identity-links" },
    });
    if (!response.ok) throw new Error(`GitHub search page ${page}: ${response.status}`);
    text = await response.text();
  } else {
    const child = Bun.spawn(["gh", "api", "-X", "GET", "search/issues", "-f", `q=${query}`, "-F", "per_page=100", "-F", `page=${page}`], { stdout: "pipe", stderr: "pipe" });
    text = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) throw new Error(`gh api search page ${page} failed: ${(await new Response(child.stderr).text()).trim()}`);
  }
  requests.github.bytes += Buffer.byteLength(text);
  return JSON.parse(text);
}

async function jiraSearch(jql: string, fields: string, startAt: number, requests: Requests): Promise<{ total: number; issues: unknown[] }> {
  const params = new URLSearchParams({ jql, fields, validateQuery: "warn", maxResults: "100", startAt: String(startAt) });
  const url = `${JIRA_SEARCH}?${params}`;
  requests.urls.push(url);
  requests.jira.requests += 1;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const text = await response.text();
  requests.jira.bytes += Buffer.byteLength(text);
  if (!response.ok) throw new Error(`Jira search: ${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function account(user: unknown): UpstreamAccount | null {
  const value = user as { key?: unknown; displayName?: unknown } | null | undefined;
  if (typeof value?.key !== "string" || value.key.trim() === "") return null;
  return { key: value.key.trim(), displayName: typeof value.displayName === "string" ? value.displayName.trim() : "unknown" };
}

function issueOf(raw: unknown): UpstreamIssue | undefined {
  const issue = raw as { key?: unknown; fields?: { summary?: unknown; updated?: unknown; reporter?: unknown; assignee?: unknown } };
  if (typeof issue.key !== "string" || typeof issue.fields?.summary !== "string" || typeof issue.fields.updated !== "string") return undefined;
  return { key: issue.key, summary: issue.fields.summary, updated: issue.fields.updated, reporter: account(issue.fields.reporter), assignee: account(issue.fields.assignee) };
}

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** The upstream reads of the precision check, minimal records only. */
async function readUpstream(from: string, to: string, requests: Requests) {
  // 1. GitHub: pull requests created in the window whose title names KAFKA (at most 1,000 results).
  const query = `repo:apache/kafka is:pr created:${from}..${to} KAFKA in:title`;
  const pulls: UpstreamPull[] = [];
  let total = 0;
  for (let page = 1; page <= 10; page += 1) {
    if (page > 1) await sleep(2_100);
    const result = await githubSearch(query, page, requests);
    total = result.total_count;
    if (result.incomplete_results) console.error(`warning: GitHub search page ${page} reports incomplete results`);
    for (const raw of result.items) {
      const item = raw as { number: number; title: string; html_url: string; created_at: string; user: { login: string; type?: string } | null; pull_request?: { merged_at?: string | null } };
      const login = item.user?.login ?? "ghost";
      pulls.push({
        number: item.number, title: item.title, url: item.html_url, login,
        isBot: item.user?.type === "Bot" || login.endsWith("[bot]"),
        createdAt: new Date(item.created_at).toISOString(), mergedAt: item.pull_request?.merged_at ? new Date(item.pull_request.merged_at).toISOString() : null,
      });
    }
    if (result.items.length < 100 || page * 100 >= Math.min(total, 1_000)) break;
  }
  if (total > 1_000) console.error(`warning: GitHub search found ${total} pull requests; only the first 1,000 are read`);

  // 2. Jira: every key the titles name (read with the job's own identifier rule), then the KIP issues.
  const keyFacts = new IdentityFacts(PROJECT_ID, KAFKA_IDENTITY_PROFILE.corroboration!.issueKey, []);
  for (const month of upstreamActivityMonths({ pulls, issues: [], messages: [] })) keyFacts.add(month);
  const keys = [...keyFacts.snapshot().pulls.keys()].sort();
  const issues = new Map<string, UpstreamIssue>();
  for (let index = 0; index < keys.length; index += 100) {
    await sleep(1_000);
    const result = await jiraSearch(`key in (${keys.slice(index, index + 100).join(",")})`, "summary,assignee,reporter,updated", 0, requests);
    for (const raw of result.issues) {
      const issue = issueOf(raw);
      if (issue !== undefined) issues.set(issue.key, issue);
    }
  }
  const kipJql = `project = KAFKA AND updated >= "${from}" AND updated < "${nextDay(to)}" AND summary ~ "KIP*" ORDER BY key ASC`;
  for (let startAt = 0; ; startAt += 100) {
    await sleep(1_000);
    const result = await jiraSearch(kipJql, "summary,assignee,reporter,updated", startAt, requests);
    for (const raw of result.issues) {
      const issue = issueOf(raw);
      // `summary ~ "KIP*"` is a text match (`"KIP"` alone matches nothing): keep only summaries that name a KIP number.
      if (issue !== undefined && extractKeys(issue.summary).kips.length > 0) issues.set(issue.key, issue);
    }
    if (result.issues.length < 100 || startAt + 100 >= result.total || startAt >= 900) break;
  }

  // 3. dev@: one Pony Mail request for the window; only messages whose thread title names a KIP.
  const ponyUrl = `${PONY_STATS}?list=dev&domain=kafka.apache.org&d=${encodeURIComponent(`dfr=${from}|dto=${to}`)}&emailsOnly`;
  requests.urls.push(ponyUrl);
  requests.mail.requests += 1;
  const response = await fetch(ponyUrl, { headers: { accept: "application/json" } });
  const text = await response.text();
  requests.mail.bytes += Buffer.byteLength(text);
  if (!response.ok) throw new Error(`Pony Mail: ${response.status}`);
  const pony = JSON.parse(text) as { hits?: number; emails: { mid?: string; id?: string; epoch?: number; subject?: string; from?: string }[] };
  if (typeof pony.hits === "number" && pony.emails.length < pony.hits) throw new Error(`Pony Mail returned ${pony.emails.length} of ${pony.hits} emails`);
  const start = Date.parse(`${from}T00:00:00Z`) / 1000;
  const end = Date.parse(`${nextDay(to)}T00:00:00Z`) / 1000;
  const messages: UpstreamMessage[] = pony.emails
    .filter((email) => typeof email.epoch === "number" && email.epoch >= start && email.epoch < end && typeof email.subject === "string" &&
      extractKeys(threadTitle(email.subject)).kips.length > 0)
    .map((email) => ({ mid: String(email.mid ?? email.id), epoch: email.epoch!, subject: email.subject!, author: mailAuthor(email.from ?? "") }))
    .sort((a, b) => a.epoch - b.epoch || (a.mid < b.mid ? -1 : 1));

  return { pulls, total, issues: [...issues.values()].sort((a, b) => Number(a.key.slice(6)) - Number(b.key.slice(6))), messages, mailRead: pony.emails.length };
}

interface Measurement {
  readonly window: { readonly from: string; readonly to: string };
  readonly blind: boolean;
  readonly requests?: Omit<Requests, "urls">;
  readonly input: {
    readonly pullRequests: number;
    readonly keys: number;
    readonly assignedKeys: number;
    readonly logins: number;
    /** Logins that wrote a pull request naming an assigned key (the pairs' logins). */
    readonly pairedLogins: number;
    readonly accounts: number;
    readonly pairs: number;
    readonly pairsAtMinIssues: number;
    readonly jiraIssues: number;
    readonly devMessages: number;
    readonly kipStarters: number;
  };
  readonly counts: IdentityLinkCounts;
  readonly precision: PrecisionReport;
  readonly links: readonly { readonly a: string; readonly aDisplay?: string; readonly b: string; readonly bDisplay?: string; readonly edge: "A" | "B"; readonly evidence: number; readonly ids: readonly string[] }[];
}

function measure(months: readonly ActivityMonthV1[], window: Measurement["window"], blind: boolean, pullRequests: number): Omit<Measurement, "requests"> {
  const config = KAFKA_IDENTITY_PROFILE.corroboration!;
  const bots = PEOPLE_PROJECTS.find((project) => project.projectId === PROJECT_ID)?.bots ?? [];
  const facts = new IdentityFacts(PROJECT_ID, config.issueKey, bots);
  for (const month of months) facts.add(month);
  const { pulls, jira } = facts.snapshot();
  const pairs = new Map<string, Set<string>>();
  const logins = new Set<string>();
  const accounts = new Set<string>();
  let assignedKeys = 0;
  for (const [issue, authors] of pulls) {
    for (const github of authors.keys()) logins.add(github);
    const assignee = jira.get(issue)?.assignee;
    if (assignee === null || assignee === undefined) continue;
    assignedKeys += 1;
    accounts.add(assignee.key);
    for (const github of authors.keys()) {
      const key = `${github}\u0000${assignee.key}`;
      (pairs.get(key) ?? pairs.set(key, new Set()).get(key)!).add(issue);
    }
  }
  const months12 = months.map((month) => month.month);
  const updatedAt = months.flatMap((month) => month.rows.map((row) => row.at)).sort().at(-1) ?? `${window.to}T00:00:00.000Z`;
  const result = computeIdentityLinks({
    projectId: PROJECT_ID, config, facts, roster: null, identityLinks: KAFKA_IDENTITY_PROFILE.identityLinks, blind,
    inputs: { coverageFrom: `${window.from}T00:00:00.000Z`, months: months12, activityUpdatedAt: updatedAt, rosterAt: null },
    ...(KAFKA_IDENTITY_PROFILE.committersAt === undefined ? {} : { committersAt: KAFKA_IDENTITY_PROFILE.committersAt }),
  });
  const precision = classifyPrecision(result.table, KAFKA_COMMITTERS_CAPTURE.committers, facts.pullAuthors());
  return {
    window, blind,
    input: {
      pullRequests, keys: pulls.size, assignedKeys, logins: logins.size,
      pairedLogins: new Set([...pairs.keys()].map((key) => key.slice(0, key.indexOf("\u0000")))).size, accounts: accounts.size, pairs: pairs.size,
      pairsAtMinIssues: [...pairs.values()].filter((keys) => keys.size >= config.minIssues).length,
      jiraIssues: jira.size,
      devMessages: months.reduce((sum, month) => sum + month.rows.filter((row) => row.source === "mail").length, 0),
      kipStarters: result.starters.length,
    },
    counts: result.counts,
    precision,
    links: corroboratedLinks(result.table),
  };
}

function corroboratedLinks(table: IdentityLinksTableV1): Measurement["links"] {
  return table.people.flatMap((person) => {
    const display = new Map(person.members.map((member) => [member.id, member.display]));
    return person.links.filter((link) => link.basis === "corroborated").map((link) => ({
      a: link.a, ...(display.get(link.a) === undefined ? {} : { aDisplay: display.get(link.a)! }),
      b: link.b, ...(display.get(link.b) === undefined ? {} : { bDisplay: display.get(link.b)! }),
      edge: link.evidence.some((evidence) => evidence.id.startsWith("KIP-")) ? "B" as const : "A" as const,
      evidence: link.evidence.length,
      ids: link.evidence.map((evidence) => evidence.id),
    }));
  });
}

function print(result: Measurement): void {
  const { input, counts, precision } = result;
  console.log(`Identity links corroborated@1, window ${result.window.from}..${result.window.to}${result.blind ? " (blind: committers-page entries left out)" : ""}`);
  if (result.requests !== undefined) {
    const { github, jira, mail } = result.requests;
    console.log(`Requests: GitHub ${github.requests} (${Math.round(github.bytes / 1024)} KB), Jira ${jira.requests} (${Math.round(jira.bytes / 1024)} KB), Pony Mail ${mail.requests} (${Math.round(mail.bytes / 1024)} KB)`);
  }
  console.log(`Input: ${input.pullRequests} PRs, ${input.keys} distinct keys (${input.assignedKeys} assigned), ${input.logins} logins (${input.pairedLogins} on assigned keys), ${input.accounts} accounts, ` +
    `${input.pairs} pairs (${input.pairsAtMinIssues} reach ${KAFKA_IDENTITY_PROFILE.corroboration!.minIssues} keys); ${input.jiraIssues} Jira issues, ` +
    `${input.devMessages} KIP dev@ messages, ${input.kipStarters} KIP starters`);
  console.log(`Links: ${counts.links.corroborated} corroborated, ${counts.links.declared} declared, ${counts.links.roster} roster; rejected ` +
    `${counts.rejected.minimum} below minimum, ${counts.rejected.dominance} by dominance, ${counts.rejected.competitor} by competitor, ${counts.rejected.conflict} conflict, ` +
    `${counts.rejected.contradiction} contradiction, ${counts.rejected.removed} removed`);
  console.log(`Precision: ${precision.corroboratedLinks} corroborated links; ${precision.committersTouched} committers touched; ${precision.agree} agree; ` +
    `${precision.contradict} contradict; ${precision.committerUnlabelled} committer unlabelled; ${precision.toLabel} links to label; ` +
    `recall ${precision.recall.linked}/${precision.recall.withEvidence} committer logins with evidence; gate ${precision.pass ? "PASS" : "FAIL"}`);
  for (const component of precision.components.filter((entry) => entry.verdict !== "to-label")) {
    console.log(`  ${component.verdict}: ${component.members.join(" ↔ ")} (committer ${component.committers.join(", ")})`);
  }
  console.log("Corroborated links:");
  for (const link of result.links) {
    const side = (id: string, display?: string) => (display === undefined ? id : `${id} (${display})`);
    console.log(`  [${link.edge}] ${side(link.a, link.aDisplay)} ↔ ${side(link.b, link.bDisplay)}: ${link.evidence} ${link.edge === "A" ? "keys" : "KIPs"}`);
  }
}

const { values } = parseArgs({
  options: {
    from: { type: "string", default: "2026-09-15" },
    to: { type: "string", default: "2026-10-21" },
    blind: { type: "boolean", default: false },
    record: { type: "string" },
    replay: { type: "string" },
    json: { type: "boolean", default: false },
    budget: { type: "boolean", default: false },
    backfill: { type: "boolean", default: false },
  },
});

if (values.budget || values.backfill) {
  // Spec 019 amendment (8), W129: `--backfill` measures the job reading 11 backfill months and the log's 2.
  const script = join(import.meta.dir, "../../../apps/data-publisher-worker/scripts/measure-identity-links-budget.ts");
  const child = Bun.spawnSync(["bun", script, ...(values.backfill ? ["--backfill"] : [])], { stdout: "inherit", stderr: "inherit" });
  process.exit(child.exitCode ?? 1);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
if (values.replay !== undefined) {
  const fixture = JSON.parse(readFileSync(values.replay, "utf8")) as { schema: string; window: Measurement["window"]; requests: Requests; months: ActivityMonthV1[] };
  if (fixture.schema !== UPSTREAM_SCHEMA) throw new Error(`${values.replay} is not a ${UPSTREAM_SCHEMA} fixture`);
  const pullRequests = fixture.months.reduce((sum, month) => sum + Object.values(month.threads).filter((thread) => thread.kind === "pull-request").length, 0);
  const result = measure(fixture.months, fixture.window, values.blind, pullRequests);
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else print(result);
} else {
  if (!DAY.test(values.from) || !DAY.test(values.to) || values.from > values.to) throw new Error("--from and --to must be YYYY-MM-DD, from <= to");
  const requests: Requests = { github: { requests: 0, bytes: 0 }, jira: { requests: 0, bytes: 0 }, mail: { requests: 0, bytes: 0 }, urls: [] };
  const capturedAt = new Date().toISOString();
  const upstream = await readUpstream(values.from, values.to, requests);
  const months = upstreamActivityMonths(upstream);
  const window = { from: values.from, to: values.to };
  const { urls, ...counts } = requests;
  const result: Measurement = { ...measure(months, window, values.blind, upstream.total), requests: counts };
  if (values.record !== undefined) {
    writeFileSync(values.record, `${JSON.stringify({
      schema: UPSTREAM_SCHEMA,
      window,
      capturedAt,
      source: "Public upstream reads by `bun run measure:identity-links -- --record`: GitHub search, ASF Jira REST, Pony Mail stats.lua (anonymous). Activity-log months only; no address, Jira name, time zone or avatar.",
      requests: { ...counts, urls },
      totals: { pullRequests: upstream.total, jiraIssues: upstream.issues.length, devMessagesRead: upstream.mailRead, kipMessages: upstream.messages.length },
      months: months.map((month) => ({ ...month, schema: PEOPLE_ACTIVITY_SCHEMA })),
    }, null, 1)}\n`);
    console.error(`Recorded ${months.length} months to ${values.record}`);
  }
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else print(result);
}
