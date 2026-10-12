/**
 * Spec 017: the real-corpus snapshot and its measurements.
 *
 *   bun run --cwd packages/search real-corpus                                 # ranks at @2 and @3
 *   bun run --cwd packages/search real-corpus -- --ablation                   # one change at a time
 *   bun run --cwd packages/search real-corpus -- --latency                    # ranking time per query
 *   bun run --cwd packages/search real-corpus -- --release <dir> --check      # snapshot == release
 *   bun run --cwd packages/search real-corpus -- --release <dir> --write      # rewrites the snapshot
 *
 * Without `--release` everything is measured on the committed snapshot with the release
 * statistics it records, offline. The snapshot is exact for each case query's first 20 threads
 * at `@2` and `@3` only: ranks beyond 20, the other ablation variants, and the guard rows are
 * what the snapshot's 343 threads give. With `--release <dir>` the same commands measure the
 * whole release instead; `--check` and `--write` need it.
 *
 * `<dir>` holds one `search-release.v3` of `bm25-reference@2` or `@3`: `manifest.json`,
 * `terms.json`, and its lexical shards, either under their bucket keys or flat by file name.
 * This script reads no network.
 *
 * Provenance of the committed snapshot (2026-10-12): the implementing agent read the release's
 * objects from the Dev R2 bucket with the local wrangler login, read-only. That went beyond
 * what was authorised (GETs of the public API). Do not repeat it: a future snapshot is taken
 * from the public API or from an export the owner explicitly authorises. The public API cannot
 * supply the release statistics (total chunk length, document frequencies), so a snapshot built
 * from it alone cannot be scored as the release scores.
 *
 * The snapshot keeps, for every case query, the threads that rank in the first 30 of the whole
 * release at `@2` or at `@3`, plus every judged thread, with all their chunks as the release
 * stores them, and the release's own statistics.
 */
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  CODE_TEXT_LEXICAL_REVISION,
  EVALUATION_DEPTH,
  codeTextLexicalSearchConfig,
  compareLexicalResults,
  evaluateGoldenFixture,
  formatEvaluationTable,
  lexicalQueryTerms,
  lexicalSearchConfigFor,
  lexicalShardPostings,
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
import { testPlanRows as guardRows } from "../test/real-corpus-guards.cases";
import { PLAYGROUND_THREAD, RELEASE_MANAGER_THREAD, testPlanRows } from "../test/real-corpus.cases";
import { loadGoldenV2 } from "../test/support/golden-v2";
import {
  REAL_CORPUS_SNAPSHOT_SCHEMA,
  SNAPSHOT_DEPTH,
  SNAPSHOT_PROVENANCE_NOTE,
  SNAPSHOT_REVISIONS,
  evaluateRealCorpus,
  parseRealCorpus,
  realCorpusQueryTerms,
  realCorpusSnapshotPath,
  releaseStatistics,
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
if (values.release === undefined && (values.write || values.check)) {
  throw new Error("--write and --check need --release <directory of one search-release.v3>");
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

/** What is ranked: the whole release on disk, or the committed snapshot. */
interface Corpus {
  readonly label: string;
  readonly shards: (config: LexicalSearchConfigV1) => readonly LexicalShardV1[];
  readonly statistics: LexicalCorpusStatsV1;
  readonly manifest?: Manifest;
}

const { identifierProfiles } = await loadGoldenV2();
const committed = Bun.file(realCorpusSnapshotPath);

async function releaseCorpus(directory: string): Promise<Corpus> {
  const readObject = async <T>(key: string): Promise<T> => {
    for (const path of [join(directory, key), join(directory, basename(key))]) {
      const file = Bun.file(path);
      if (await file.exists()) return await file.json() as T;
    }
    throw new Error(`The release directory has no ${key}`);
  };
  const manifest = await readObject<Manifest>("manifest.json");
  if (!SNAPSHOT_REVISIONS.includes(manifest.lexicalRevision as (typeof SNAPSHOT_REVISIONS)[number])) {
    throw new Error(`The release is ${manifest.lexicalRevision}; its postings must be ${SNAPSHOT_REVISIONS.join(" or ")}`);
  }
  const terms = (await readObject<{ readonly terms: Readonly<Record<string, readonly number[]>> }>("terms.json")).terms;
  const shards: LexicalShardV1[] = [];
  for (const shard of manifest.shards) shards.push(await readObject<LexicalShardV1>(shard.key));
  return {
    label: `release ${manifest.indexRevision} (${manifest.chunkCount} chunks)`,
    shards: () => shards,
    statistics: {
      chunkCount: manifest.chunkCount,
      totalChunkLength: manifest.totalChunkLength,
      documentFrequency: (term) => Object.hasOwn(terms, term) ? terms[term]![0]! : 0,
    },
    manifest,
  };
}

async function snapshotCorpus(): Promise<Corpus> {
  const { snapshot, fixture } = await parseRealCorpus(await committed.json());
  const stored = new Map<string, LexicalShardV1>();
  return {
    label: `the committed snapshot of ${snapshot.provenance.indexRevision} (${fixture.chunks.length} of ${snapshot.corpus.chunkCount} chunks)`,
    // Postings do not depend on the ranking fields, only on the tokens; one shard per revision.
    shards: (config) => {
      const shard = stored.get(config.revision) ?? { chunks: fixture.chunks, ...lexicalShardPostings(fixture.chunks, config) };
      stored.set(config.revision, shard);
      return [shard];
    },
    statistics: releaseStatistics(snapshot),
  };
}

const corpus = values.release === undefined ? await snapshotCorpus() : await releaseCorpus(resolve(values.release));

/** Every matching thread, ranked per shard as the Pages reader ranks it. */
function rankGroups(query: string, config: LexicalSearchConfigV1): readonly LexicalSearchResultV1[] {
  return corpus.shards(config).flatMap((shard) => rankLexicalShard(shard, corpus.statistics, { query }, config));
}

function rank(query: string, config: LexicalSearchConfigV1, limit: number): readonly LexicalSearchResultV1[] {
  return selectLexicalResults(rankGroups(query, config), { limit }).results;
}

const evaluated = (id: string, search: (query: string, depth: number) => readonly LexicalSearchResultV1[]): EvaluationConfigurationV1 => ({
  id,
  semantic: false,
  search: async (query, depth) => search(query.request.query, depth).map((result) => ({
    groupRootRecordId: result.groupRootRecordId,
    evidenceRecordIds: result.matches.map((match) => match.recordId),
  })),
});
const configuration = (id: string, config: LexicalSearchConfigV1) => evaluated(id, (query, depth) => rank(query, config, depth));

/**
 * Evaluation only, not a production ranking (Spec 017 Decision 4): every chunk's score is
 * multiplied by the IDF-weighted share of the query's terms it matches, then threads are scored
 * as `config` scores them. Terms no chunk of the release holds are left out of the share.
 */
function coverageConfiguration(id: string, base: LexicalSearchConfigV1): EvaluationConfigurationV1 {
  const config = { ...base, maxEvidenceMatches: 1_000_000 };
  const idf = (term: string) => {
    const frequency = corpus.statistics.documentFrequency(term);
    return Math.log(1 + (corpus.statistics.chunkCount - frequency + 0.5) / (frequency + 0.5));
  };
  return evaluated(id, (query, depth) => {
    const held = lexicalQueryTerms(query, config).filter((term) => corpus.statistics.documentFrequency(term) > 0);
    const total = held.reduce((sum, term) => sum + idf(term), 0);
    const groups = rankGroups(query, config).map((group) => {
      const scores = group.matches.map((match) => {
        const boost = match.exactMatch ? config.exactBoost : 0;
        const share = total === 0 ? 1 : match.matchedTerms.filter((term) => held.includes(term)).reduce((sum, term) => sum + idf(term), 0) / total;
        return { exact: match.exactMatch, score: (match.score - boost) * share + boost, chunkId: match.chunkId };
      }).sort((left, right) => Number(right.exact) - Number(left.exact) || right.score - left.score || left.chunkId.localeCompare(right.chunkId));
      const score = config.furtherChunkWeighting === "geometric"
        ? scores.reduce((sum, chunk, index) => sum + chunk.score * config.additionalGroupMatchWeight ** index, 0)
        : scores[0]!.score + scores.slice(1).reduce((sum, chunk) => sum + chunk.score, 0) * config.additionalGroupMatchWeight;
      return { ...group, score };
    });
    return groups.sort(compareLexicalResults).slice(0, depth);
  });
}

function buildSnapshot(manifest: Manifest, capturedAt: string): RealCorpusSnapshotV1 {
  const config = lexicalSearchConfigFor(CODE_TEXT_LEXICAL_REVISION, identifierProfiles);
  const kept = new Set<string>();
  for (const row of testPlanRows) {
    for (const cell of [row.expected, row.acceptable, row.notInTop3]) for (const id of cell?.split(" ") ?? []) kept.add(id);
    for (const revision of SNAPSHOT_REVISIONS) {
      for (const result of rank(row.query, lexicalSearchConfigFor(revision, identifierProfiles), SNAPSHOT_DEPTH)) {
        kept.add(result.groupRootRecordId);
      }
    }
  }
  const chunks = corpus.shards(config).flatMap((shard) => shard.chunks.filter((chunk) => kept.has(chunk.groupRootRecordId)))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return {
    schema: REAL_CORPUS_SNAPSHOT_SCHEMA,
    provenance: {
      note: SNAPSHOT_PROVENANCE_NOTE,
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
      documentFrequency: Object.fromEntries(realCorpusQueryTerms(config).map((term) => [term, corpus.statistics.documentFrequency(term)])),
    },
    chunks,
  };
}

/** One chunk per line, so a refreshed snapshot diffs by record. */
function serialize(snapshot: RealCorpusSnapshotV1): string {
  const { chunks, ...head } = snapshot;
  return `${JSON.stringify(head, null, 2).slice(0, -2)},\n  "chunks": [\n${chunks.map((chunk) => `    ${JSON.stringify(chunk)}`).join(",\n")}\n  ]\n}\n`;
}

if (corpus.manifest !== undefined && (values.write || values.check)) {
  const capturedAt = values["captured-at"] ??
    (await committed.exists() ? (await committed.json() as RealCorpusSnapshotV1).provenance.capturedAt : new Date().toISOString().slice(0, 10));
  const snapshot = buildSnapshot(corpus.manifest, capturedAt);
  if (values.write) {
    await Bun.write(realCorpusSnapshotPath, serialize(snapshot));
    console.log(`Wrote ${snapshot.chunks.length} chunks of ${new Set(snapshot.chunks.map((chunk) => chunk.groupRootRecordId)).size} threads to ${realCorpusSnapshotPath.pathname}`);
  }
  if (values.check) {
    if (await committed.text() !== serialize(snapshot)) throw new Error("The committed snapshot differs from what this release gives; run with --write");
    const real = await parseRealCorpus(await committed.json());
    const report = await evaluateRealCorpus(real);
    const whole = await evaluateGoldenFixture(real.fixture, SNAPSHOT_REVISIONS.map((revision, index) =>
      configuration(report.configurations[index]!.id, lexicalSearchConfigFor(revision, identifierProfiles))));
    if (JSON.stringify(whole) !== JSON.stringify(report)) throw new Error("The snapshot does not evaluate like the whole release");
    for (const row of testPlanRows) {
      for (const revision of SNAPSHOT_REVISIONS) {
        const config = lexicalSearchConfigFor(revision, identifierProfiles);
        const inRelease = rank(row.query, config, EVALUATION_DEPTH).map((result) => [result.groupRootRecordId, result.score]);
        const snapshotShard = { chunks: real.fixture.chunks, ...lexicalShardPostings(real.fixture.chunks, config) };
        const inSnapshot = selectLexicalResults(rankLexicalShard(snapshotShard, corpus.statistics, { query: row.query }, config), { limit: EVALUATION_DEPTH })
          .results.map((result) => [result.groupRootRecordId, result.score]);
        if (JSON.stringify(inRelease) !== JSON.stringify(inSnapshot)) throw new Error(`${row.query} at ${revision}: the snapshot's first ${EVALUATION_DEPTH} differ from the release's`);
      }
    }
    console.log(`snapshot ok: ${testPlanRows.length} queries rank and score like ${corpus.label} in the first ${EVALUATION_DEPTH}, at ${SNAPSHOT_REVISIONS.join(" and ")}`);
  }
}

const real = await parseRealCorpus(await committed.json());
console.log(`Measured on ${corpus.label}.`);

if (values.ablation) {
  const at2 = { ...codeTextLexicalSearchConfig, identifiers: identifierProfiles };
  const at3 = { ...threadPhraseLexicalSearchConfig, identifiers: identifierProfiles };
  const only = { ...at2, revision: THREAD_PHRASE_LEXICAL_REVISION };
  const report = await evaluateGoldenFixture(real.fixture, [
    configuration("@2", at2),
    configuration("@2, best chunk only (weight 0)", { ...at2, additionalGroupMatchWeight: 0 }),
    configuration("geometric thread score only", { ...only, furtherChunkWeighting: "geometric" }),
    configuration("geometric, ratio 0.5", { ...only, furtherChunkWeighting: "geometric", additionalGroupMatchWeight: 0.5 }),
    configuration("phrase bonus only", { ...only, phraseWeight: 1 }),
    configuration("best chunk only + phrase", { ...only, additionalGroupMatchWeight: 0, phraseWeight: 1 }),
    configuration("geometric + phrase 0.5", { ...at3, phraseWeight: 0.5 }),
    configuration("@3 = geometric + phrase 1", at3),
    configuration("geometric + phrase 2", { ...at3, phraseWeight: 2 }),
    coverageConfiguration("@2 x coverage (evaluation only)", at2),
    coverageConfiguration("@3 x coverage (evaluation only)", at3),
  ]);
  console.log(formatEvaluationTable(report).split("\n\n")[1]!.split("\n").filter((line) => line.startsWith("configuration") || line.includes("  all ")).join("\n"));
}

if (values.latency) {
  const queries = [...testPlanRows.map((row) => row.query), "issue pull request", "the"];
  const rows = [];
  for (const query of queries) {
    const timed = SNAPSHOT_REVISIONS.map((revision) => {
      const config = lexicalSearchConfigFor(revision, identifierProfiles);
      // A term the snapshot has no release statistic for cannot be scored; `the` and `issue` are such terms.
      try {
        rank(query, config, 20);
      } catch {
        return undefined;
      }
      const samples: number[] = [];
      for (let iteration = 0; iteration < 15; iteration += 1) {
        const startedAt = performance.now();
        rank(query, config, 20);
        samples.push(performance.now() - startedAt);
      }
      return samples.sort((left, right) => left - right)[7]!;
    });
    if (timed.some((value) => value === undefined)) continue;
    rows.push({ query, "@2 p50 ms": Number(timed[0]!.toFixed(2)), "@3 p50 ms": Number(timed[1]!.toFixed(2)) });
  }
  console.table(rows);
}

if (!values.ablation && !values.latency) {
  const position = (ranked: readonly LexicalSearchResultV1[], id: string) => {
    const index = ranked.findIndex((result) => result.groupRootRecordId === id);
    return index < 0 ? ">100" : String(index + 1);
  };
  const table = (rows: readonly { readonly query: string; readonly expected: string; readonly notInTop3?: string | null }[]) => rows.map((row) => {
    const [before, after] = SNAPSHOT_REVISIONS.map((revision) => rank(row.query, lexicalSearchConfigFor(revision, identifierProfiles), 100));
    const long = [RELEASE_MANAGER_THREAD, PLAYGROUND_THREAD].find((id) => id === row.notInTop3) ?? RELEASE_MANAGER_THREAD;
    return {
      query: row.query,
      "expected @2": row.expected.split(" ").map((id) => position(before!, id)).join(" "),
      "expected @3": row.expected.split(" ").map((id) => position(after!, id)).join(" "),
      "long thread @2": position(before!, long),
      "long thread @3": position(after!, long),
    };
  });
  console.table(table(testPlanRows));
  console.log("Guard rows (Spec 017 N18):");
  console.table(table(guardRows));
  process.stdout.write(formatEvaluationTable(await evaluateRealCorpus(real)));
}
