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
 */
import {
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
const NOW = Date.parse("2026-10-15T12:00:00Z");
const MONTHS = ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];

/** A small deterministic generator, so every run measures the same bytes. */
function random(seed: number): () => number {
  let state = seed;
  return () => ((state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
}

function buildStore(projectId: string, input: { total: number; person: string; given: number; received: number }) {
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
  return objects;
}

/** Kept alive so one project's cached months are not collected while the next is measured. */
const keep: unknown[] = [];
const dumpIndex = Bun.argv.indexOf("--dump");
/** `--dump <dir>` also writes the store as files (`<dir>/<key>`), to seed a local `wrangler pages dev` and time it in workerd. */
const dump = dumpIndex < 0 ? undefined : Bun.argv[dumpIndex + 1];

async function measure(project: string, projectId: string, input: { total: number; person: string; given: number; received: number }) {
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
    cold: { ...cold, r2Reads: coldReads, r2BytesParsed: coldBytes },
    warm: { ...warm, r2Reads: warmReads },
    afterTtl: { wallMs: afterTtl.wallMs, r2Reads: reads.length - coldReads - warmReads },
    personSearch: { cold: { ...searchCold, r2Reads: searchColdReads }, warmPrefix: { ...searchWarm, r2Reads: searchReads.length - searchColdReads } },
    responseGzipBytes: gzipBytes,
    heapRetainedBytes: heapRetained,
  };
}

const results = [
  await measure("kafka", "apache-kafka", { total: 14_000, person: "chia7712", given: 2_248, received: 11 }),
  await measure("datafusion", "apache-datafusion", { total: 12_900, person: "alamb", given: 1_639, received: 600 }),
];
const round = (value: number) => Math.round(value * 10) / 10;
for (const result of results) {
  console.log(JSON.stringify(result, (_key, value) => (typeof value === "number" && !Number.isInteger(value) ? round(value) : value)));
}
