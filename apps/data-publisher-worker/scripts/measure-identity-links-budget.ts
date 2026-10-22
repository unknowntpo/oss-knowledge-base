/**
 * Spec 019 amendment (7), W86: the identity-link job's R2 budget and memory at Dev's size.
 *
 *   bun run measure:identity-links -- --budget
 *   bun apps/data-publisher-worker/scripts/measure-identity-links-budget.ts [--months 12] [--rows 4200] [--seed 7]
 *
 * Builds, in an in-memory bucket, an activity log of Dev's size (a `state.json` listing 12 months
 * and 12 month objects of about 4k rows each: GitHub pull requests naming `KAFKA-n` and their
 * comments, Jira issues with reporter and assignee and their comments, dev@ messages with KIP
 * discussions), an ASF roster and a previous table, then runs `runIdentityLinks` twice: a first run
 * whose inputs changed (the table is written) and an unchanged rerun. Reports Class B reads, Class A
 * writes, bytes written, peak heap (sampled at every bucket call, under Bun/JSC) and duration;
 * fails unless every run stays within 15 Class B and 2 Class A. A run with only the DataFusion
 * profile (no `corroboration`) must touch no project object.
 */
import { parseArgs } from "node:util";

import {
  DATAFUSION_IDENTITY_PROFILE,
  encodeActivityMonth,
  KAFKA_IDENTITY_PROFILE,
  PEOPLE_ACTIVITY_SCHEMA,
  PEOPLE_ACTIVITY_STATE_SCHEMA,
  PEOPLE_IDENTITY_PROFILES,
  peopleActivityMonthKey,
  peopleActivityStateKey,
  type ActivityMonthV1,
  type ActivityRowV1,
  type ActivityThreadV1,
  type PeopleIdentityProfile,
  type Roster,
} from "@oss-knowledge-base/reference-pipeline";
import { PEOPLE_PROJECTS, PEOPLE_SUPPRESSED, suppressionDigest } from "@oss-knowledge-base/reference-pipeline/people";

import { runIdentityLinks, type IdentityLinksBucket, type IdentityLinksRecord } from "../src/identity-links/run";
import { rosterKey } from "../src/review-queue/store";

const LIMIT_CLASS_B = 15;
const LIMIT_CLASS_A = 2;
const KAFKA = "apache-kafka";

const { values } = parseArgs({
  options: {
    months: { type: "string", default: "12" },
    rows: { type: "string", default: "4200" },
    seed: { type: "string", default: "7" },
  },
});

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const WORDS = ["consumer", "producer", "broker", "partition", "offset", "rebalance", "coordinator", "fetch", "transaction", "replica",
  "leader", "metadata", "controller", "quorum", "share", "group", "tiered", "storage", "streams", "connect", "mirror", "config"];
const PEOPLE = 900;
const login = (person: number) => `dev-${person}`;
const accountKey = (person: number) => (person % 3 === 0 ? `user${person}` : `JIRAUSER${300_000 + person}`);
const displayName = (person: number) => `Given${person} Family${person % 97}`;

/**
 * One month of Dev's shape: about 9% pull requests, 43% pull-request comments, 17% Jira issues,
 * 12% Jira comments, 19% dev@ messages (W86 sizes the job by the newest 12 such months).
 */
function generateMonth(month: string, index: number, rowsPerMonth: number, seed: number): ActivityMonthV1 {
  const next = random(seed * 7919 + index);
  const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]!;
  const someone = () => Math.floor(Math.pow(next(), 2) * PEOPLE);
  const start = Date.parse(`${month}-01T00:00:00Z`);
  const at = () => new Date(start + Math.floor(next() * 28 * 86_400_000)).toISOString();
  const text = (words: number) => Array.from({ length: words }, () => pick(WORDS)).join(" ");
  const threads: Record<string, ActivityThreadV1> = {};
  const people: Record<string, string> = {};
  const rows: ActivityRowV1[] = [];
  const row = (value: ActivityRowV1, display: string) => {
    rows.push(value);
    people[value.person] = display;
  };

  const issues = Math.round(rowsPerMonth * 0.17);
  const firstKey = 19_000 + index * Math.round(issues * 0.7);
  const owners = new Map<number, number>();
  for (let issue = 0; issue < issues; issue += 1) {
    const key = `KAFKA-${firstKey + issue}`;
    const reporter = someone();
    const assignee = next() < 0.85 ? someone() : undefined;
    if (assignee !== undefined) owners.set(firstKey + issue, assignee);
    threads[key] = {
      source: "jira", kind: "issue", title: `${key}: ${next() < 0.06 ? `KIP-${1200 + Math.floor(next() * 200)} ` : ""}${text(7)}`,
      url: `https://issues.apache.org/jira/browse/${key}`, author: `jira:${displayName(reporter).toLowerCase()}`, labels: [], kips: [],
      reporter: { key: accountKey(reporter), display: displayName(reporter) },
      assignee: assignee === undefined ? null : { key: accountKey(assignee), display: displayName(assignee) },
    };
    row({ id: `kafka:jira:issue:${key}`, source: "jira", kind: "issue", person: `jira:${displayName(reporter).toLowerCase()}`, at: at(), thread: key }, displayName(reporter));
  }
  for (let comment = 0; comment < Math.round(rowsPerMonth * 0.12); comment += 1) {
    const key = `KAFKA-${firstKey + Math.floor(next() * issues)}`;
    const author = someone();
    row({ id: `kafka:jira:issue:${key}:comment:${index}${comment}`, source: "jira", kind: "comment", person: `jira:${displayName(author).toLowerCase()}`, at: at(), thread: key }, displayName(author));
  }

  const pulls = Math.round(rowsPerMonth * 0.09);
  const firstPull = 20_000 + index * pulls;
  for (let pull = 0; pull < pulls; pull += 1) {
    const number = firstPull + pull;
    const issue = firstKey + Math.floor(next() * issues);
    // Most pull requests are written by the issue's assignee, as on KAFKA.
    const author = owners.has(issue) && next() < 0.8 ? owners.get(issue)! : someone();
    const thread = `KAFKA-PR-${number}`;
    threads[thread] = {
      source: "github", kind: "pull-request", title: `${next() < 0.85 ? `KAFKA-${issue}: ` : "MINOR: "}${text(8)}`,
      url: `https://github.com/apache/kafka/pull/${number}`, author: `github:${login(author)}`, labels: [], kips: [],
    };
    const created = at();
    row({ id: `kafka:github:pull:${number}`, source: "github", kind: "pull-request", person: `github:${login(author)}`, at: created, thread,
      ...(next() < 0.6 ? { merged: created } : {}) }, login(author));
  }
  for (let comment = 0; comment < Math.round(rowsPerMonth * 0.43); comment += 1) {
    const number = firstPull + Math.floor(next() * pulls);
    const author = someone();
    row({ id: `kafka:github:pull:${number}:comment:${index}${comment}`, source: "github", kind: "comment", person: `github:${login(author)}`, at: at(), thread: `KAFKA-PR-${number}` }, login(author));
  }

  const messages = Math.round(rowsPerMonth * 0.19);
  let thread = "";
  for (let message = 0; message < messages; message += 1) {
    const author = someone();
    const opens = message === 0 || next() < 1 / 3.5;
    if (opens) {
      thread = `KAFKA-MAIL-${(index * 100_000 + message).toString(16).padStart(8, "0")}`;
      const kip = `KIP-${1200 + Math.floor(next() * 200)}`;
      threads[thread] = {
        source: "mail", kind: "mail-thread", title: next() < 0.25 ? `[DISCUSS] ${kip}: ${text(4)}` : text(6),
        url: `https://lists.apache.org/thread/m${index}x${message}`, author: `mail:${displayName(author).toLowerCase()}`, labels: [], kips: [],
      };
    }
    row({ id: `kafka:mail:dev:message:m${index}x${message}`, source: "mail", kind: "message", person: `mail:${displayName(author).toLowerCase()}`, at: at(), thread,
      ...(opens ? { opens: true as const } : {}) }, displayName(author));
  }
  return { schema: PEOPLE_ACTIVITY_SCHEMA, projectId: KAFKA, month, people, threads, rows };
}

class MeasuredBucket implements IdentityLinksBucket {
  readonly objects = new Map<string, string>();
  classA = 0;
  classB = 0;
  bytesWritten = 0;
  peakHeap = 0;
  readonly touched = new Set<string>();
  sample(): void {
    this.peakHeap = Math.max(this.peakHeap, process.memoryUsage().heapUsed);
  }
  reset(): void {
    this.classA = 0;
    this.classB = 0;
    this.bytesWritten = 0;
    this.touched.clear();
    Bun.gc(true);
    this.peakHeap = 0;
    this.sample();
  }
  async get(key: string): Promise<string | undefined> {
    this.sample();
    this.classB += 1;
    this.touched.add(key);
    return this.objects.get(key);
  }
  async put(key: string, body: string): Promise<void> {
    this.sample();
    this.classA += 1;
    this.bytesWritten += Buffer.byteLength(body);
    this.touched.add(key);
    this.objects.set(key, body);
  }
}

const monthCount = Number(values.months);
const rowsPerMonth = Number(values.rows);
const seed = Number(values.seed);
const bucket = new MeasuredBucket();
const lastMonth = Date.UTC(2026, 9, 1);
const months = Array.from({ length: monthCount }, (_, index) => {
  const date = new Date(lastMonth);
  date.setUTCMonth(date.getUTCMonth() - (monthCount - 1 - index));
  return date.toISOString().slice(0, 7);
});
let rows = 0;
let largest = 0;
for (const [index, month] of months.entries()) {
  const object = generateMonth(month, index, rowsPerMonth, seed);
  rows += object.rows.length;
  const body = encodeActivityMonth(object);
  largest = Math.max(largest, body.length);
  bucket.objects.set(peopleActivityMonthKey(KAFKA, month), body);
}
const state = (updatedAt: string) => JSON.stringify({
  schema: PEOPLE_ACTIVITY_STATE_SCHEMA, firstAppendAt: `${months[0]}-01T00:00:00.000Z`, coverageFrom: `${months[0]}-01T00:00:00.000Z`, updatedAt, months,
});
const roster: Roster = {
  adapter: "asf", project: "kafka", fetchedAt: "2026-10-20T00:00:00.000Z",
  entries: Array.from({ length: 1_200 }, (_, index) => ({ id: `asf${index}`, name: index % 4 === 0 ? displayName(index) : `Roster Person ${index}`, roles: index < 60 ? ["pmc" as const] : ["committer" as const] })),
};
bucket.objects.set(rosterKey("asf", "kafka"), JSON.stringify(roster));
// DataFusion's activity state exists too: a profile without `corroboration` must not read it.
bucket.objects.set(peopleActivityStateKey("apache-datafusion"), state("2026-10-20T22:07:00.000Z"));

const bots = (projectId: string) => PEOPLE_PROJECTS.find((project) => project.projectId === projectId)?.bots ?? [];
const run = (profiles: readonly PeopleIdentityProfile[]) => runIdentityLinks({
  flag: "corroborated@1", bucket, profiles, bots, suppressed: PEOPLE_SUPPRESSED, digest: suppressionDigest, now: () => Date.now(),
});

// The previous table: yesterday's run (not measured).
bucket.objects.set(peopleActivityStateKey(KAFKA), state("2026-10-19T22:07:00.000Z"));
await run(PEOPLE_IDENTITY_PROFILES);
// Today's append changed the log: the first measured run writes the table, the rerun finds it unchanged.
bucket.objects.set(peopleActivityStateKey(KAFKA), state("2026-10-20T22:07:00.000Z"));

interface Measured {
  readonly name: string;
  readonly record: IdentityLinksRecord;
  readonly classA: number;
  readonly classB: number;
  readonly bytesWritten: number;
  readonly peakHeapMB: number;
  readonly baselineMB: number;
  readonly durationMs: number;
  readonly touched: readonly string[];
}

async function measured(name: string, profiles: readonly PeopleIdentityProfile[]): Promise<Measured> {
  bucket.reset();
  const baseline = bucket.peakHeap;
  const started = performance.now();
  const record = await run(profiles);
  const durationMs = Math.round(performance.now() - started);
  bucket.sample();
  return {
    name, record, classA: bucket.classA, classB: bucket.classB, bytesWritten: bucket.bytesWritten,
    peakHeapMB: Math.round(bucket.peakHeap / 104_857.6) / 10, baselineMB: Math.round(baseline / 104_857.6) / 10, durationMs, touched: [...bucket.touched].sort(),
  };
}

const results = [
  await measured("first run (inputs changed)", PEOPLE_IDENTITY_PROFILES),
  await measured("second run (unchanged)", PEOPLE_IDENTITY_PROFILES),
];
const datafusion = await measured("DataFusion profile only", [DATAFUSION_IDENTITY_PROFILE]);

console.log(`Activity log: ${months.length} months (${months[0]}..${months.at(-1)}), ${rows} rows (${Math.round(rows / months.length)}/month), ` +
  `largest month ${Math.round(largest / 1024)} KB; roster ${roster.entries.length} entries; profile ${KAFKA_IDENTITY_PROFILE.projectId} + DataFusion.`);
let failed = false;
for (const result of results) {
  const { lastRun } = result.record;
  const within = result.classB <= LIMIT_CLASS_B && result.classA <= LIMIT_CLASS_A && lastRun.ok;
  if (!within) failed = true;
  console.log(`${result.name}: status ${lastRun.status}, Class B ${result.classB} (limit ${LIMIT_CLASS_B}), Class A ${result.classA} (limit ${LIMIT_CLASS_A}), ` +
    `${Math.round(result.bytesWritten / 1024)} KB written (table ${Math.round(lastRun.bytesWritten / 1024)} KB), peak heap ${result.peakHeapMB} MB ` +
    `(baseline ${result.baselineMB} MB), ${result.durationMs} ms; links ${JSON.stringify(lastRun.links)}, ${lastRun.people} people, ` +
    `${lastRun.kipStarters} KIP starters, rejected ${JSON.stringify(lastRun.rejected)}${lastRun.error === undefined ? "" : `, error ${lastRun.error}`}: ${within ? "PASS" : "FAIL"}`);
}
if (results[0]!.record.lastRun.status !== "ok" || results[1]!.record.lastRun.status !== "unchanged") failed = true;
const projectKeys = datafusion.touched.filter((key) => key !== "internal/identity/v1/last-run.json");
if (projectKeys.length > 0) failed = true;
console.log(`${datafusion.name}: status ${datafusion.record.lastRun.status}, Class B ${datafusion.classB}, Class A ${datafusion.classA}, ` +
  `objects touched ${JSON.stringify(datafusion.touched)}; project objects read ${projectKeys.length}: ${projectKeys.length === 0 ? "PASS" : "FAIL"}`);
process.exit(failed ? 1 : 0);
