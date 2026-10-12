/**
 * Spec 017: the real-corpus snapshot and its measurements, from a Search release on disk.
 *
 *   bun run --cwd packages/search real-corpus -- --release <dir>              # ranks at @2 and @3
 *   bun run --cwd packages/search real-corpus -- --release <dir> --write      # rewrites the snapshot
 *   bun run --cwd packages/search real-corpus -- --release <dir> --check      # snapshot == release
 *   bun run --cwd packages/search real-corpus -- --release <dir> --ablation   # one change at a time
 *   bun run --cwd packages/search real-corpus -- --release <dir> --latency    # ranking time per query
 *
 * `<dir>` holds one `search-release.v3` of `bm25-reference@2` or `@3`: `manifest.json`,
 * `terms.json`, and its lexical shards, either under their bucket keys or flat by file name.
 * This script reads no network. The committed snapshot was taken from the Dev bucket with
 *
 *   wrangler r2 object get oss-knowledge-base-dev/public/search/v1/current.json --remote --file current.json
 *   wrangler r2 object get oss-knowledge-base-dev/<releaseManifestKey> --remote --file manifest.json
 *   … and the same for `terms.json` and every `shards[].key` of the manifest.
 *
 * The snapshot keeps, for every case query, the threads that rank in the first 30 of the whole
 * release at `@2` or at `@3`, plus every judged thread, with all their chunks as the release
 * stores them, and the release's own statistics. Tests then rank it offline exactly as the
 * release ranks (`--check` proves it for the first 20).
 */
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  CODE_TEXT_LEXICAL_REVISION,
  EVALUATION_DEPTH,
  codeTextLexicalSearchConfig,
  evaluateGoldenFixture,
  formatEvaluationTable,
  lexicalSearchConfigFor,
  rankLexicalShard,
  selectLexicalResults,
  threadPhraseLexicalSearchConfig,
  THREAD_PHRASE_LEXICAL_REVISION,
  type EvaluationConfigurationV1,
  type LexicalCorpusStatsV1,
  type LexicalSearchConfigV1,
  type LexicalSearchResultV1,
  type LexicalShardV1,
} from "../src";
import { PLAYGROUND_THREAD, RELEASE_MANAGER_THREAD, testPlanRows } from "../test/real-corpus.cases";
import { loadGoldenV2 } from "../test/support/golden-v2";
import {
  REAL_CORPUS_SNAPSHOT_SCHEMA,
  SNAPSHOT_DEPTH,
  SNAPSHOT_REVISIONS,
  evaluateRealCorpus,
  parseRealCorpus,
  realCorpusQueryTerms,
  realCorpusSnapshotPath,
  type RealCorpusSnapshotV1,
} from "../test/support/real-corpus";

const { values } = parseArgs({
  options: {
    release: { type: "string" },
    write: { type: "boolean", default: false },
    check: { type: "boolean", default: false },
    ablation: { type: "boolean", default: false },
    latency: { type: "boolean", default: false },
    "captured-at": { type: "string" },
  },
});
if (values.release === undefined) throw new Error("--release <directory of one search-release.v3> is required");
const directory = resolve(values.release);

async function readObject<T>(key: string): Promise<T> {
  for (const path of [join(directory, key), join(directory, basename(key))]) {
    const file = Bun.file(path);
    if (await file.exists()) return await file.json() as T;
  }
  throw new Error(`The release directory has no ${key}`);
}

interface Manifest {
  readonly indexRevision: string;
  readonly lexicalRevision: string;
  readonly generatedAt: string;
  readonly chunkCount: number;
  readonly totalChunkLength: number;
  readonly groupCount: number;
  readonly shards: readonly { readonly key: string }[];
}

const manifest = await readObject<Manifest>("manifest.json");
if (!SNAPSHOT_REVISIONS.includes(manifest.lexicalRevision as (typeof SNAPSHOT_REVISIONS)[number])) {
  throw new Error(`The release is ${manifest.lexicalRevision}; its postings must be ${SNAPSHOT_REVISIONS.join(" or ")}`);
}
const terms = (await readObject<{ readonly terms: Readonly<Record<string, readonly number[]>> }>("terms.json")).terms;
const shards: LexicalShardV1[] = [];
for (const shard of manifest.shards) shards.push(await readObject<LexicalShardV1>(shard.key));
const { identifierProfiles } = await loadGoldenV2();
const statistics: LexicalCorpusStatsV1 = {
  chunkCount: manifest.chunkCount,
  totalChunkLength: manifest.totalChunkLength,
  documentFrequency: (term) => Object.hasOwn(terms, term) ? terms[term]![0]! : 0,
};

/** The whole release ranked as the Pages reader ranks it: per shard, then merged. */
function rankRelease(query: string, config: LexicalSearchConfigV1, limit: number): readonly LexicalSearchResultV1[] {
  const groups = shards.flatMap((shard) => rankLexicalShard(shard, statistics, { query }, config));
  return selectLexicalResults(groups, { limit }).results;
}

const releaseConfiguration = (id: string, config: LexicalSearchConfigV1): EvaluationConfigurationV1 => ({
  id,
  semantic: false,
  search: async (query, depth) => rankRelease(query.request.query, config, depth).map((result) => ({
    groupRootRecordId: result.groupRootRecordId,
    evidenceRecordIds: result.matches.map((match) => match.recordId),
  })),
});

function buildSnapshot(capturedAt: string): RealCorpusSnapshotV1 {
  const config = lexicalSearchConfigFor(CODE_TEXT_LEXICAL_REVISION, identifierProfiles);
  const kept = new Set<string>();
  for (const row of testPlanRows) {
    for (const cell of [row.expected, row.acceptable, row.notInTop3]) for (const id of cell?.split(" ") ?? []) kept.add(id);
    for (const revision of SNAPSHOT_REVISIONS) {
      for (const result of rankRelease(row.query, lexicalSearchConfigFor(revision, identifierProfiles), SNAPSHOT_DEPTH)) {
        kept.add(result.groupRootRecordId);
      }
    }
  }
  const chunks = shards.flatMap((shard) => shard.chunks.filter((chunk) => kept.has(chunk.groupRootRecordId)))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return {
    schema: REAL_CORPUS_SNAPSHOT_SCHEMA,
    provenance: {
      note: "Public Apache Kafka and Apache DataFusion records (GitHub, Jira, dev@ mail) exactly as the Dev Search release stores them: titles, clipped excerpts, authors, links. Selection and statistics: packages/search/scripts/real-corpus.ts.",
      source: "https://oss-knowledge-base-dev.pages.dev (R2 bucket oss-knowledge-base-dev)",
      indexRevision: manifest.indexRevision,
      generatedAt: manifest.generatedAt,
      capturedAt,
      lexicalRevision: manifest.lexicalRevision,
      groupCount: manifest.groupCount,
      depth: SNAPSHOT_DEPTH,
    },
    corpus: {
      chunkCount: manifest.chunkCount,
      totalChunkLength: manifest.totalChunkLength,
      documentFrequency: Object.fromEntries(realCorpusQueryTerms(config).map((term) => [term, statistics.documentFrequency(term)])),
    },
    chunks,
  };
}

/** One chunk per line, so a refreshed snapshot diffs by record. */
function serialize(snapshot: RealCorpusSnapshotV1): string {
  const { chunks, ...head } = snapshot;
  return `${JSON.stringify(head, null, 2).slice(0, -2)},\n  "chunks": [\n${chunks.map((chunk) => `    ${JSON.stringify(chunk)}`).join(",\n")}\n  ]\n}\n`;
}

const committed = Bun.file(realCorpusSnapshotPath);
const capturedAt = values["captured-at"] ??
  (await committed.exists() ? (await committed.json() as RealCorpusSnapshotV1).provenance.capturedAt : new Date().toISOString().slice(0, 10));

if (values.write) {
  const snapshot = buildSnapshot(capturedAt);
  await Bun.write(realCorpusSnapshotPath, serialize(snapshot));
  console.log(`Wrote ${snapshot.chunks.length} chunks of ${new Set(snapshot.chunks.map((chunk) => chunk.groupRootRecordId)).size} threads to ${realCorpusSnapshotPath.pathname}`);
}

if (values.check) {
  const expected = serialize(buildSnapshot(capturedAt));
  if (await committed.text() !== expected) throw new Error("The committed snapshot differs from what this release gives; run with --write");
  const corpus = await parseRealCorpus(JSON.parse(expected));
  const report = await evaluateRealCorpus(corpus);
  const whole = await evaluateGoldenFixture(corpus.fixture, SNAPSHOT_REVISIONS.map((revision, index) =>
    releaseConfiguration(report.configurations[index]!.id, lexicalSearchConfigFor(revision, identifierProfiles))));
  if (JSON.stringify(whole) !== JSON.stringify(report)) throw new Error("The snapshot does not evaluate like the whole release");
  for (const row of testPlanRows) {
    for (const revision of SNAPSHOT_REVISIONS) {
      const config = lexicalSearchConfigFor(revision, identifierProfiles);
      const inRelease = rankRelease(row.query, config, EVALUATION_DEPTH).map((result) => [result.groupRootRecordId, result.score]);
      const snapshotShard = { chunks: corpus.fixture.chunks, ...(await import("../src")).lexicalShardPostings(corpus.fixture.chunks, config) };
      const inSnapshot = selectLexicalResults(rankLexicalShard(snapshotShard, statistics, { query: row.query }, config), { limit: EVALUATION_DEPTH })
        .results.map((result) => [result.groupRootRecordId, result.score]);
      if (JSON.stringify(inRelease) !== JSON.stringify(inSnapshot)) throw new Error(`${row.query} at ${revision}: the snapshot's first ${EVALUATION_DEPTH} differ from the release's`);
    }
  }
  console.log(`snapshot ok: ${testPlanRows.length} queries rank and score like release ${manifest.indexRevision} (${manifest.chunkCount} chunks) in the first ${EVALUATION_DEPTH}, at ${SNAPSHOT_REVISIONS.join(" and ")}`);
}

const corpus = await parseRealCorpus(await committed.json());

if (values.ablation) {
  const at2 = { ...codeTextLexicalSearchConfig, identifiers: identifierProfiles };
  const at3 = { ...threadPhraseLexicalSearchConfig, identifiers: identifierProfiles };
  const only = { ...at2, revision: THREAD_PHRASE_LEXICAL_REVISION };
  const variants: readonly (readonly [string, LexicalSearchConfigV1])[] = [
    ["@2", at2],
    ["@2, best chunk only (weight 0)", { ...at2, additionalGroupMatchWeight: 0 }],
    ["geometric thread score only", { ...only, furtherChunkWeighting: "geometric" }],
    ["geometric, ratio 0.5", { ...only, furtherChunkWeighting: "geometric", additionalGroupMatchWeight: 0.5 }],
    ["phrase bonus only", { ...only, phraseWeight: 1 }],
    ["best chunk only + phrase", { ...only, additionalGroupMatchWeight: 0, phraseWeight: 1 }],
    ["geometric + phrase 0.5", { ...at3, phraseWeight: 0.5 }],
    ["@3 = geometric + phrase 1", at3],
    ["geometric + phrase 2", { ...at3, phraseWeight: 2 }],
  ];
  const report = await evaluateGoldenFixture(corpus.fixture, variants.map(([id, config]) => releaseConfiguration(id, config)));
  console.log(formatEvaluationTable(report).split("\n\n")[1]!.split("\n").filter((line) => line.startsWith("configuration") || line.includes("  all ")).join("\n"));
}

if (values.latency) {
  const queries = [...testPlanRows.map((row) => row.query), "issue pull request", "the"];
  const rows = [];
  for (const query of queries) {
    const timed = SNAPSHOT_REVISIONS.map((revision) => {
      const config = lexicalSearchConfigFor(revision, identifierProfiles);
      rankRelease(query, config, 20);
      const samples: number[] = [];
      for (let iteration = 0; iteration < 15; iteration += 1) {
        const startedAt = performance.now();
        rankRelease(query, config, 20);
        samples.push(performance.now() - startedAt);
      }
      return samples.sort((left, right) => left - right)[7]!;
    });
    const chunks = shards.reduce((total, shard) => total + new Set(rankLexicalShard(shard, statistics, { query }, lexicalSearchConfigFor(CODE_TEXT_LEXICAL_REVISION, identifierProfiles))
      .flatMap((group) => group.matches.map((match) => match.chunkId))).size, 0);
    rows.push({ query, "threads' shown chunks": chunks, "@2 p50 ms": Number(timed[0]!.toFixed(2)), "@3 p50 ms": Number(timed[1]!.toFixed(2)) });
  }
  console.table(rows);
}

if (!values.ablation && !values.latency) {
  const rank = (ranked: readonly LexicalSearchResultV1[], id: string) => {
    const index = ranked.findIndex((result) => result.groupRootRecordId === id);
    return index < 0 ? ">100" : String(index + 1);
  };
  const rows = testPlanRows.map((row) => {
    const [before, after] = SNAPSHOT_REVISIONS.map((revision) => rankRelease(row.query, lexicalSearchConfigFor(revision, identifierProfiles), 100));
    const negative = [RELEASE_MANAGER_THREAD, PLAYGROUND_THREAD].find((id) => id === row.notInTop3) ?? RELEASE_MANAGER_THREAD;
    return {
      query: row.query,
      "expected @2": row.expected.split(" ").map((id) => rank(before!, id)).join(" "),
      "expected @3": row.expected.split(" ").map((id) => rank(after!, id)).join(" "),
      [`long thread @2`]: rank(before!, negative),
      [`long thread @3`]: rank(after!, negative),
    };
  });
  console.table(rows);
  process.stdout.write(formatEvaluationTable(await evaluateRealCorpus(corpus)));
}
