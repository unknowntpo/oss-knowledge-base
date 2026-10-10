import {
  codeTextLexicalSearchConfig,
  defaultLexicalSearchConfig,
  evaluateGoldenFixture,
  hybridEvaluationConfiguration,
  lexicalEvaluationConfiguration,
  parseSearchGoldenFixtureV2,
  type GoldenEvaluationReportV1,
  type LexicalSearchConfigV1,
  type SearchGoldenFixtureV2,
} from "../../src";
import { fakeSemanticRetriever } from "./fake-embedder";

export const goldenV2Path = new URL("../fixtures/golden-queries.v2.json", import.meta.url);
export const goldenV2ReportPath = new URL("../fixtures/golden-evaluation.v2.json", import.meta.url);

export async function loadGoldenV2(): Promise<SearchGoldenFixtureV2> {
  return parseSearchGoldenFixtureV2(await Bun.file(goldenV2Path).json());
}

/** `bm25-reference@2` with the fixture's community identifier profiles. */
export function codeTextConfig(fixture: SearchGoldenFixtureV2): LexicalSearchConfigV1 {
  return { ...codeTextLexicalSearchConfig, identifiers: fixture.identifierProfiles };
}

export const LEXICAL_BEFORE = "lexical bm25-reference@1";
export const LEXICAL_AFTER = "lexical bm25-reference@2";
export const HYBRID_FAKE = "hybrid bm25-reference@2 + fake semantic";

/** The three configurations the committed report compares. */
export async function evaluateGoldenV2(fixture: SearchGoldenFixtureV2): Promise<GoldenEvaluationReportV1> {
  return evaluateGoldenFixture(fixture, [
    lexicalEvaluationConfiguration(LEXICAL_BEFORE, fixture.chunks, defaultLexicalSearchConfig),
    lexicalEvaluationConfiguration(LEXICAL_AFTER, fixture.chunks, codeTextConfig(fixture)),
    hybridEvaluationConfiguration(HYBRID_FAKE, fixture.chunks, codeTextConfig(fixture), fakeSemanticRetriever(fixture.chunks)),
  ]);
}
