import {
  CODE_TEXT_LEXICAL_REVISION,
  evaluateGoldenFixture,
  lexicalQueryTerms,
  lexicalSearchConfigFor,
  lexicalShardPostings,
  parseSearchGoldenFixtureV2,
  rankLexicalShard,
  selectLexicalResults,
  THREAD_PHRASE_LEXICAL_REVISION,
  type EvaluationConfigurationV1,
  type GoldenEvaluationReportV1,
  type IdentifierProfilesV1,
  type LexicalCorpusStatsV1,
  type LexicalSearchConfigV1,
  type SearchGoldenFixtureV2,
  type SourceRecordChunkV1,
} from "../../src";
import { testPlanRows } from "../real-corpus.cases";
import { loadGoldenV2 } from "./golden-v2";

export const REAL_CORPUS_SNAPSHOT_SCHEMA = "osskb.search-corpus-snapshot.v1" as const;
export const realCorpusSnapshotPath = new URL("../fixtures/real-corpus-snapshot.v1.json", import.meta.url);
export const realCorpusReportPath = new URL("../fixtures/real-corpus-evaluation.v1.json", import.meta.url);
/** Each query's first this-many threads of the whole release, at each revision, are in the snapshot. */
export const SNAPSHOT_DEPTH = 30;
/** The revisions the snapshot is exact for: they share tokens, postings, and statistics. */
export const SNAPSHOT_REVISIONS = [CODE_TEXT_LEXICAL_REVISION, THREAD_PHRASE_LEXICAL_REVISION] as const;

export type RealCorpusCase = (typeof testPlanRows)[number];

export interface RealCorpusSnapshotV1 {
  readonly schema: typeof REAL_CORPUS_SNAPSHOT_SCHEMA;
  readonly provenance: {
    readonly note: string;
    readonly source: string;
    readonly indexRevision: string;
    readonly generatedAt: string;
    readonly capturedAt: string;
    readonly lexicalRevision: string;
    readonly groupCount: number;
    readonly depth: number;
  };
  /** Statistics of the whole release, not of the snapshot. */
  readonly corpus: {
    readonly chunkCount: number;
    readonly totalChunkLength: number;
    /** Every term a case query selects postings with -> the release's document frequency. */
    readonly documentFrequency: Readonly<Record<string, number>>;
  };
  readonly chunks: readonly SourceRecordChunkV1[];
}

const ids = (cell: string | null): readonly string[] => cell === null ? [] : cell.split(" ");

/** The case rows as golden v2 queries, so the Spec 016 parser and grader apply unchanged. */
export function realCorpusQueries(rows: readonly RealCorpusCase[] = testPlanRows): readonly unknown[] {
  return rows.map((row) => ({
    id: row.query,
    category: row.case,
    requires: "lexical",
    request: { query: row.query },
    judgments: [
      ...ids(row.expected).map((groupRootRecordId) => ({ groupRootRecordId, grade: 2 })),
      ...ids(row.acceptable).map((groupRootRecordId) => ({ groupRootRecordId, grade: 1 })),
    ],
    negativeGroupRootRecordIds: ids(row.notInTop3),
    requiredEvidenceRecordIds: [],
    requiredWithin: row.within,
    negativeWithin: 3,
    ordered: row.labels === "owner",
    note: `${row.labels}-labelled. ${row.why}`,
  }));
}

/**
 * The terms whose release-wide document frequency a case query is scored with. The words of its
 * phrase pairs are among them: every word of a query is also one of its terms.
 */
export function realCorpusQueryTerms(config: LexicalSearchConfigV1, rows: readonly RealCorpusCase[] = testPlanRows): readonly string[] {
  return [...new Set(rows.flatMap((row) => lexicalQueryTerms(row.query, config)))].sort();
}

export interface RealCorpus {
  readonly snapshot: RealCorpusSnapshotV1;
  readonly fixture: SearchGoldenFixtureV2;
  readonly identifierProfiles: IdentifierProfilesV1;
}

/**
 * Parses a snapshot with the case rows as its queries. The community identifier profiles are
 * golden v2's (a test keeps those equal to the search profiles), so the patterns are not
 * written a third time.
 */
export async function parseRealCorpus(value: unknown, rows: readonly RealCorpusCase[] = testPlanRows): Promise<RealCorpus> {
  const snapshot = value as RealCorpusSnapshotV1;
  if (typeof value !== "object" || value === null || snapshot.schema !== REAL_CORPUS_SNAPSHOT_SCHEMA) {
    throw new Error(`Invalid real-corpus snapshot: expected ${REAL_CORPUS_SNAPSHOT_SCHEMA}`);
  }
  const { identifierProfiles } = await loadGoldenV2();
  const fixture = parseSearchGoldenFixtureV2({
    schema: "osskb.search-golden-fixture.v2",
    revision: `real-corpus-${snapshot.provenance.indexRevision}`,
    indexRevision: snapshot.provenance.indexRevision,
    provenance: { syntheticRecordIds: [] },
    identifierProfiles,
    chunks: snapshot.chunks,
    queries: realCorpusQueries(rows),
  });
  const { chunkCount, totalChunkLength, documentFrequency } = snapshot.corpus;
  if (!Number.isSafeInteger(chunkCount) || chunkCount < fixture.chunks.length) {
    throw new Error("Invalid real-corpus snapshot: corpus.chunkCount is below the snapshot's own chunk count");
  }
  if (!Number.isSafeInteger(totalChunkLength) || totalChunkLength <= 0) {
    throw new Error("Invalid real-corpus snapshot: corpus.totalChunkLength must be a positive integer");
  }
  if (!SNAPSHOT_REVISIONS.includes(snapshot.provenance.lexicalRevision as (typeof SNAPSHOT_REVISIONS)[number])) {
    throw new Error(`Invalid real-corpus snapshot: statistics of ${snapshot.provenance.lexicalRevision} do not fit ${SNAPSHOT_REVISIONS.join(", ")}`);
  }
  // The release holds every snapshot chunk, so no term can be rarer there than here.
  const config = lexicalSearchConfigFor(snapshot.provenance.lexicalRevision, identifierProfiles);
  const { postings } = lexicalShardPostings(fixture.chunks, config);
  for (const term of realCorpusQueryTerms(config, rows)) {
    const recorded = Object.hasOwn(documentFrequency, term) ? documentFrequency[term] : undefined;
    if (recorded === undefined) throw new Error(`Invalid real-corpus snapshot: no document frequency for query term ${term}`);
    const held = Object.hasOwn(postings, term) ? postings[term]!.length / 2 : 0;
    if (!Number.isSafeInteger(recorded) || recorded < held || recorded > chunkCount) {
      throw new Error(`Invalid real-corpus snapshot: document frequency ${recorded} of ${term} is outside ${held}..${chunkCount}`);
    }
  }
  return { snapshot, fixture, identifierProfiles };
}

export async function loadRealCorpus(): Promise<RealCorpus> {
  return parseRealCorpus(await Bun.file(realCorpusSnapshotPath).json());
}

/** The release's statistics; a term the snapshot did not record throws instead of counting as absent. */
export function releaseStatistics(snapshot: RealCorpusSnapshotV1): LexicalCorpusStatsV1 {
  return {
    chunkCount: snapshot.corpus.chunkCount,
    totalChunkLength: snapshot.corpus.totalChunkLength,
    documentFrequency: (term) => {
      if (!Object.hasOwn(snapshot.corpus.documentFrequency, term)) {
        throw new Error(`The real-corpus snapshot has no document frequency for ${term}`);
      }
      return snapshot.corpus.documentFrequency[term]!;
    },
  };
}

/**
 * Lexical search over chunks scored with the statistics of a larger release, through the
 * streaming reader's `rankLexicalShard`. A thread's score depends only on its own chunks and
 * those statistics, so a snapshot holding a query's first threads ranks them as the release does.
 */
export function releaseEvaluationConfiguration(
  id: string,
  chunks: readonly SourceRecordChunkV1[],
  config: LexicalSearchConfigV1,
  corpus: LexicalCorpusStatsV1,
): EvaluationConfigurationV1 {
  const shard = { chunks, ...lexicalShardPostings(chunks, config) };
  return {
    id,
    semantic: false,
    search: async (query, depth) =>
      selectLexicalResults(rankLexicalShard(shard, corpus, query.request, config), { limit: depth }).results.map((result) => ({
        groupRootRecordId: result.groupRootRecordId,
        evidenceRecordIds: result.matches.map((match) => match.recordId),
      })),
  };
}

export const realCorpusConfigurationId = (revision: string) => `lexical ${revision} on the Dev release`;

/** `@2` and `@3` over the snapshot with the release's statistics. */
export async function evaluateRealCorpus({ snapshot, fixture, identifierProfiles }: RealCorpus): Promise<GoldenEvaluationReportV1> {
  return evaluateGoldenFixture(fixture, SNAPSHOT_REVISIONS.map((revision) => releaseEvaluationConfiguration(
    realCorpusConfigurationId(revision),
    fixture.chunks,
    lexicalSearchConfigFor(revision, identifierProfiles),
    releaseStatistics(snapshot),
  )));
}
