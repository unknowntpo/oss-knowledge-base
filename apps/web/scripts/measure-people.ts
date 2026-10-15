/**
 * Spec 019 W18 / W29 (`bun run measure:people`): one profile request against a review store the
 * size of Dev's on 2026-10-15, for the heaviest reviewer of each project.
 *
 * Volumes (constructed, deterministic): Dev's backfill holds about 14,000 Kafka and 12,900
 * DataFusion review rows for 12 months (Spec 022 slice 2). The person's rows are the upstream
 * oracle of the Spec 019 Example: chia7712 2,248 reviews given and 11 received; alamb 1,639 given
 * (received: 600, an upper guess). `--scale 2` doubles every volume. Reports the bytes read from
 * R2, the R2 reads, the response size, wall and CPU time cold and warm, and the heap retained by
 * the isolate cache, and a person search (slice 3, W44) cold and warm. Bun's JSC stands in for workerd's V8: times are indicative, sizes exact.
 *
 * Slice 2b: the store also holds a full 12-month activity log (the worst case, a year after the
 * first append): per month, Kafka 1,950 and DataFusion 5,650 rows (Dev's 35-day record counts of
 * 2026-10-13, 2,248 and 6,586, per 30 days), about 0.45 threads per row, 300 identities. The
 * person writes 150 (chia7712) or 600 (alamb, a guess) rows a month. `--no-activity` measures 2a.
 */
import {
  encodeActivityMonth,
  PEOPLE_ACTIVITY_SCHEMA,
  PEOPLE_ACTIVITY_STATE_SCHEMA,
  peopleActivityMonthKey,
  peopleActivityStateKey,
  type ActivityRowV1,
  type ActivityThreadV1,
  encodeReviewMonth,
  GITHUB_REVIEWS_STATE_SCHEMA,
  githubReviewsMonthKey,
  githubReviewsStateKey,
  type ReviewRow,
} from "@oss-knowledge-base/reference-pipeline";
import { readPersonProfile, PEOPLE_INDEX_TTL_MS } from "@oss-knowledge-base/reference-pipeline/people";
import { searchPeople } from "@oss-knowledge-base/reference-pipeline/people/search";
import { heapSize } from "bun:jsc";

const scale = Number(Bun.argv[Bun.argv.indexOf("--scale") + 1] ?? 1) || 1;
const withActivity = !Bun.argv.includes("--no-activity");
/** `--months N`: how many months the activity log holds (its age), newest last; default 12. */
const activityMonths = Bun.argv.includes("--months") ? Number(Bun.argv[Bun.argv.indexOf("--months") + 1]) : 12;
/** W18: a cold profile request parses at most this much; the run exits 1 above it unless `--report-only`. */
const W18_PARSE_BUDGET_BYTES = 16 * 1024 * 1024;
const reportOnly = Bun.argv.includes("--report-only");
const NOW = Date.parse("2026-10-15T12:00:00Z");
const MONTHS = ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];

/** A small deterministic generator, so every run measures the same bytes. */
function random(seed: number): () => number {
  let state = seed;
  return () => ((state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
}

function buildStore(projectId: string, input: { total: number; person: string; given: number; received: number; activityRows: number; personRows: number }) {
  const next = random(projectId.length * 7919);
  const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!;
  const reviewers = Array.from({ length: 300 }, (_, index) => `reviewer-${index}`);
  const authors = Array.from({ length: 250 }, (_, index) => `author-${index}`);
  const states = ["APPROVED", "COMMENTED", "COMMENTED", "CHANGES_REQUESTED"] as const;
  const rows: ReviewRow[] = [];
  let reviewId = 5_000_000_000;
  const row = (prAuthor: string, reviewer: string, index: number, isBot = false): ReviewRow => {
    const month = MONTHS[index % MONTHS.length]!;
    const day = String(1 + Math.floor(next() * 27)).padStart(2, "0");
    return {
      reviewId: reviewId++, pr: 10_000 + Math.floor(next() * 14_000), prAuthor, reviewer, isBot, state: pick(states),
      submittedAt: `${month}-${day}T${String(Math.floor(next() * 24)).padStart(2, "0")}:13:07Z`,
      commit: Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(next() * 16)]).join(""),
      inlineComments: Math.floor(next() * 4),
    };
  };
  const total = Math.round(input.total * scale);
  for (let index = 0; index < Math.round(input.given * scale); index += 1) rows.push(row(pick(authors), input.person, index));
  for (let index = 0; index < Math.round(input.received * scale); index += 1) rows.push(row(input.person, pick(reviewers), index));
  for (let index = rows.length; index < total; index += 1) {
    // About 1 in 10 rows is a self-reply and 1 in 20 a bot, as Dev's daily runs show.
    const author = pick(authors);
    const kind = next();
    rows.push(row(author, kind < 0.1 ? author : kind < 0.15 ? "copilot-pull-request-reviewer" : pick(reviewers), index, kind >= 0.1 && kind < 0.15));
  }
  const objects = new Map<string, string>([[githubReviewsStateKey(projectId), JSON.stringify({ schema: GITHUB_REVIEWS_STATE_SCHEMA, updatedAt: "2026-10-14T22:02:21Z", coverageFrom: "2025-10-14T00:00:00.000Z" })]]);
  for (const month of MONTHS) objects.set(githubReviewsMonthKey(projectId, month), encodeReviewMonth(projectId, month, rows.filter((item) => item.submittedAt.startsWith(month))));
  if (withActivity) addActivity(objects, projectId, input, next);
  return objects;
}

/** Slice 2b: twelve full activity months (see the header), written as the publisher encodes them. */
function addActivity(objects: Map<string, string>, projectId: string, input: { person: string; activityRows: number; personRows: number }, next: () => number) {
  const prefix = projectId === "apache-kafka" ? "KAFKA" : "DATAFUSION";
  const people = Array.from({ length: 300 }, (_, index) => `github:author-${index}`);
  const sources = projectId === "apache-kafka" ? (["github", "jira", "mail"] as const) : (["github"] as const);
  let id = 0;
  for (const month of MONTHS.slice(MONTHS.length - activityMonths)) {
    const rows: ActivityRowV1[] = [];
    const threads: Record<string, ActivityThreadV1> = {};
    const total = Math.round(input.activityRows * scale);
    for (let index = 0; index < total; index += 1) {
      const person = index < Math.round(input.personRows * scale) ? `github:${input.person}` : people[Math.floor(next() * people.length)]!;
      const source = person.startsWith(`github:${input.person}`) ? "github" : sources[Math.floor(next() * sources.length)]!;
      const number = 10_000 + Math.floor(next() * total * 0.45);
      const thread = source === "jira" ? `KAFKA-${number}` : source === "mail" ? `KAFKA-MAIL-${number.toString(16).padStart(8, "0")}` : `${prefix}-PR-${number}`;
      threads[thread] ??= {
        source, kind: source === "mail" ? "mail-thread" : source === "jira" ? "issue" : "pull-request",
        title: `Constructed thread ${number}: a title of about the usual length for this source`, url: `https://example.invalid/${thread}`,
        author: people[number % people.length]!, labels: source === "github" ? ["clients", "small"] : [], kips: number % 7 === 0 ? [`KIP-${number % 2000}`] : [],
      };
      const day = String(1 + Math.floor(next() * 27)).padStart(2, "0");
      rows.push({
        id: `${projectId}:${source}:${thread}:record:${id += 1}`, source, kind: source === "mail" ? "message" : next() < 0.15 ? "pull-request" : "comment",
        person: source === "github" ? person : `${source}:${person.slice(7)}`, at: `${month}-${day}T10:00:00Z`, thread,
      });
    }
    const names = Object.fromEntries([...new Set(rows.map((row) => row.person))].map((person) => [person, person.split(":")[1]!]));
    objects.set(peopleActivityMonthKey(projectId, month), encodeActivityMonth({ schema: PEOPLE_ACTIVITY_SCHEMA, projectId, month, people: names, threads, rows }));
  }
  objects.set(peopleActivityStateKey(projectId), JSON.stringify({
    schema: PEOPLE_ACTIVITY_STATE_SCHEMA, firstAppendAt: "2025-11-01T00:00:00.000Z", coverageFrom: "2025-09-27T00:00:00.000Z", updatedAt: "2026-10-14T22:07:43.000Z", months: MONTHS,
  }));
}

/** Kept alive so one project's cached months are not collected while the next is measured. */
const keep: unknown[] = [];
const dumpIndex = Bun.argv.indexOf("--dump");
/** `--dump <dir>` also writes the store as files (`<dir>/<key>`), to seed a local `wrangler pages dev` and time it in workerd. */
const dump = dumpIndex < 0 ? undefined : Bun.argv[dumpIndex + 1];

async function measure(project: string, projectId: string, input: { total: number; person: string; given: number; received: number; activityRows: number; personRows: number }) {
  const objects = buildStore(projectId, input);
  if (dump !== undefined) for (const [key, body] of objects) await Bun.write(`${dump}/${key}`, body);
  const reads: string[] = [];
  let bytesRead = 0;
  const bucket = {
    async get(key: string) {
      reads.push(key);
      const body = objects.get(key);
      if (body !== undefined) bytesRead += body.length;
      return body === undefined ? null : { text: async () => body };
    },
  };
  keep.push(bucket);
  Bun.gc(true);
  const heapBefore = heapSize();
  const time = async (nowMs: number) => {
    const cpu = process.cpuUsage();
    const started = performance.now();
    const result = await readPersonProfile({ bucket, projectKey: project, personId: `github:${input.person}`, nowMs });
    const body = JSON.stringify(result.body);
    const used = process.cpuUsage(cpu);
    return { status: result.status, wallMs: performance.now() - started, cpuMs: (used.user + used.system) / 1000, responseBytes: body.length };
  };
  const cold = await time(NOW);
  const coldReads = reads.length;
  const coldBytes = bytesRead;
  Bun.gc(true);
  const heapRetained = heapSize() - heapBefore;
  const warm = await time(NOW + 1000);
  const gzipBytes = Bun.gzipSync(JSON.stringify((await readPersonProfile({ bucket, projectKey: project, personId: `github:${input.person}`, nowMs: NOW + 2000 })).body)).length;
  const warmReads = reads.length - coldReads;
  const afterTtl = await time(NOW + PEOPLE_INDEX_TTL_MS);
  // Spec 019 W44: a person search (slice 3) on a cold isolate (fresh bucket wrapper) and warm.
  const searchReads: string[] = [];
  const searchBucket = { get: async (key: string) => { searchReads.push(key); const body = objects.get(key); return body === undefined ? null : { text: async () => body }; } };
  keep.push(searchBucket);
  const timeSearch = async (query: string, nowMs: number) => {
    const started = performance.now();
    const result = await searchPeople({ bucket: searchBucket, projectKey: project, query, nowMs });
    return { wallMs: performance.now() - started, people: result.status === 200 ? result.body.people.length : -1 };
  };
  const searchCold = await timeSearch(input.person, NOW);
  const searchColdReads = searchReads.length;
  const searchWarm = await timeSearch(input.person.slice(0, 2), NOW + 1000);
  const totalRows = [...objects.values()].reduce((sum, body) => sum + ((JSON.parse(body) as { rows?: unknown[] }).rows?.length ?? 0), 0);
  return {
    project, person: input.person, scale, rows: totalRows,
    storeBytes: [...objects.values()].reduce((sum, body) => sum + body.length, 0),
    largestActivityMonthBytes: Math.max(0, ...[...objects].filter(([key]) => key.startsWith("internal/people/") && !key.endsWith("state.json")).map(([, body]) => body.length)),
    cold: { ...cold, r2Reads: coldReads, r2BytesParsed: coldBytes },
    warm: { ...warm, r2Reads: warmReads },
    afterTtl: { wallMs: afterTtl.wallMs, r2Reads: reads.length - coldReads - warmReads },
    personSearch: { cold: { ...searchCold, r2Reads: searchColdReads }, warmPrefix: { ...searchWarm, r2Reads: searchReads.length - searchColdReads } },
    responseGzipBytes: gzipBytes,
    heapRetainedBytes: heapRetained,
  };
}

const results = [
  await measure("kafka", "apache-kafka", { total: 14_000, person: "chia7712", given: 2_248, received: 11, activityRows: 1_950, personRows: 150 }),
  await measure("datafusion", "apache-datafusion", { total: 12_900, person: "alamb", given: 1_639, received: 600, activityRows: 5_650, personRows: 600 }),
];
const round = (value: number) => Math.round(value * 10) / 10;
for (const result of results) {
  console.log(JSON.stringify(result, (_key, value) => (typeof value === "number" && !Number.isInteger(value) ? round(value) : value)));
}
const over = results.filter((result) => result.cold.r2BytesParsed > W18_PARSE_BUDGET_BYTES);
for (const result of results) {
  const mb = round(result.cold.r2BytesParsed / 1024 / 1024);
  console.log(`W18 ${result.project}: ${mb} MiB parsed cold (budget 16 MiB, ${withActivity ? `${activityMonths} months of activity log` : "reviews only"}): ${result.cold.r2BytesParsed > W18_PARSE_BUDGET_BYTES ? "FAIL" : "PASS"}`);
}
if (over.length > 0 && !reportOnly) {
  console.error("W18 parse budget exceeded (Spec 019 G75); rerun with --report-only to report without failing.");
  process.exit(1);
}
