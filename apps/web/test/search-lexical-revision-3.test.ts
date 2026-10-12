import { describe, expect, test } from "bun:test";

import { searchIdentifierProfiles } from "@oss-knowledge-base/reference-pipeline/search-profiles";
import {
  buildLexicalIndex,
  CODE_TEXT_LEXICAL_REVISION,
  facetLexicalIndexByProject,
  lexicalQueryTerms,
  lexicalSearchConfigFor,
  parseSearchGoldenFixtureV2,
  searchLexicalIndex,
  THREAD_PHRASE_LEXICAL_REVISION,
} from "@oss-knowledge-base/search";
import {
  buildR2SearchProjection,
  SEARCH_CURRENT_KEY,
  searchTermsKey,
  type ProjectionObject,
  type SearchLexicalShardV2,
  type SearchReleaseManifestV3,
} from "@oss-knowledge-base/serving-contract";

import { onRequestGet as searchHandler } from "../functions/api/search";
import { readSearchDetailProjection, searchR2Projection } from "../functions/_shared/search-projection";
import { buildGoldenV2SearchPublication } from "../scripts/build-search-fixture";
import { legacyV2SearchObjects } from "./legacy-search-release";
import { testPlanRows } from "./search-lexical-revision-3.cases";

const goldenV2Path = new URL("../../../packages/search/test/fixtures/golden-queries.v2.json", import.meta.url).pathname;
const RELEASE_MANAGER = "kafka:mail:dev:release-manager-4-4-0";

class MemoryBucket {
  readonly reads: string[] = [];
  private readonly values: Map<string, string>;

  constructor(objects: readonly { readonly key: string; readonly body: string }[]) {
    this.values = new Map(objects.map((object) => [object.key, object.body]));
  }

  get = async (key: string) => {
    this.reads.push(key);
    const body = this.values.get(key);
    return body === undefined ? null : { json: async <T>() => JSON.parse(body) as T };
  };

  asR2(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

/** Golden v2 as a search-release.v3 of `revision`, written with the community search profiles. */
async function release(revision: string, indexRevision = `release-${revision.slice(-1)}`, maxShardChunks = 2) {
  const publication = await buildGoldenV2SearchPublication(goldenV2Path, indexRevision, revision);
  return buildR2SearchProjection(publication, { maxShardChunks, identifiers: searchIdentifierProfiles });
}

function manifestOf(objects: readonly ProjectionObject[]): SearchReleaseManifestV3 {
  return JSON.parse(objects.find((object) => object.key.endsWith("/manifest.json"))!.body) as SearchReleaseManifestV3;
}

type Response = Awaited<ReturnType<typeof searchR2Projection>>;
const roots = (response: Response) => response.results.map((result) => result.entry.sourceTitleRecordId);
const exactRoots = (response: Response) =>
  response.results.filter((result) => result.matches.some((match) => match.signals.exactIdentifier))
    .map((result) => result.entry.sourceTitleRecordId);

function searchRequest(url: string, bucket: R2Bucket) {
  return searchHandler({ request: new Request(url), env: { OSS_KB_BUCKET: bucket } } as unknown as Parameters<typeof searchHandler>[0]);
}

describe("Spec 017 Pages reader at bm25-reference@3", () => {
  test.each([...testPlanRows])("$id: $case ($query)", async (row) => {
    const objects = await release(THREAD_PHRASE_LEXICAL_REVISION);
    const bucket = new MemoryBucket(objects);
    const filters = row.projects === null ? undefined : { projectIds: row.projects.split(" ") };
    const request = { query: row.query, limit: 20, ...(filters === undefined ? {} : { filters }) };
    const response = await searchR2Projection(bucket.asR2(), request);

    expect(response.retrieval.lexicalRevision).toBe("bm25-reference@3");
    expect(roots(response).slice(0, row.first.split(" ").length)).toEqual(row.first.split(" "));
    expect(exactRoots(response)).toEqual(roots(response).slice(0, row.exact));
    expect(response.results).toHaveLength(row.results);

    // The whole-corpus @3 index with the same profiles is the oracle.
    const golden = parseSearchGoldenFixtureV2(await Bun.file(goldenV2Path).json());
    const config = lexicalSearchConfigFor("bm25-reference@3", searchIdentifierProfiles);
    const index = buildLexicalIndex({ indexRevision: "oracle", chunks: golden.chunks, config });
    const oracle = searchLexicalIndex(index, request);
    expect(roots(response)).toEqual(oracle.map((result) => result.groupRootRecordId));
    expect(response.results.map((result) => result.matches.map((match) => [match.chunkId, match.matchedTerms, match.excerpt])))
      .toEqual(oracle.map((result) => result.matches.map((match) => [match.chunkId, match.matchedTerms, match.excerpt])));
    expect(Object.fromEntries(response.facets.projects.filter((facet) => facet.count > 0).map((facet) => [facet.projectId, facet.count])))
      .toEqual(facetLexicalIndexByProject(index, { query: row.query }));

    // The same release written at @2 holds the same threads; the first one is the row's `firstAt2`.
    const before = await searchR2Projection(new MemoryBucket(await release(CODE_TEXT_LEXICAL_REVISION)).asR2(), request);
    expect(roots(before)[0]).toBe(row.firstAt2);
    expect([...roots(before)].sort()).toEqual([...roots(response)].sort());
    expect(before.facets).toEqual(response.facets);

    // Only shards holding one of the query's terms are read: the phrase bonus reads no other object.
    const manifest = manifestOf(objects);
    const terms = new Set(lexicalQueryTerms(row.query, config));
    const holding = manifest.shards.filter((shard) => {
      const body = JSON.parse(objects.find((object) => object.key === shard.key)!.body) as SearchLexicalShardV2;
      return Object.keys(body.postings).some((term) => terms.has(term));
    });
    expect(manifest.shards.length).toBeGreaterThan(5);
    expect(holding.length).toBeGreaterThan(0);
    expect(bucket.reads).toEqual([
      SEARCH_CURRENT_KEY,
      `public/search/v1/releases/${manifest.indexRevision}/manifest.json`,
      searchTermsKey(manifest.indexRevision),
      ...holding.map((shard) => shard.key),
    ]);
  });

  test("N5: an @3 release differs from the @2 release of the same publication only in its manifest's lexicalRevision", async () => {
    const at2 = await release(CODE_TEXT_LEXICAL_REVISION, "same-release");
    const at3 = await release(THREAD_PHRASE_LEXICAL_REVISION, "same-release");
    expect(at3.map((object) => object.key)).toEqual(at2.map((object) => object.key));
    const different = at3.filter((object, index) => object.body !== at2[index]!.body);
    expect(different.map((object) => object.key)).toEqual(["public/search/v1/releases/same-release/manifest.json"]);
    expect({ ...manifestOf(at3), lexicalRevision: "bm25-reference@2" }).toEqual(manifestOf(at2));
    expect(manifestOf(at3).lexicalRevision).toBe("bm25-reference@3");
  });

  test("N5: /api/search serves an @3 release with the unchanged response schema", async () => {
    const bucket = new MemoryBucket(await release(THREAD_PHRASE_LEXICAL_REVISION)).asR2();
    const response = await searchRequest("https://dev.example/api/search?q=request%20manager&limit=8", bucket);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=30, stale-while-revalidate=120");
    const body = await response.json() as Response;
    expect(body.schema).toBe("osskb.search-response.v1");
    expect(Object.keys(body).sort()).toEqual(["facets", "query", "results", "retrieval", "schema"]);
    expect(Object.keys(body.retrieval).sort()).toEqual(["generatedAt", "indexRevision", "lexicalRevision", "stale"]);
    expect(body.retrieval.lexicalRevision).toBe("bm25-reference@3");
    expect(Object.keys(body.results[0]!.matches[0]!).sort())
      .toEqual(["author", "canonicalUrl", "chunkId", "excerpt", "matchedTerms", "occurredAt", "recordId", "signals", "sourceVersion"]);
    expect(Object.keys(body.results[0]!.matches[0]!.signals).sort()).toEqual(["exactIdentifier", "fusedRank", "lexicalRank"]);
    expect(roots(body)[0]).toBe("kafka:jira:issue:KAFKA-19804");
    expect(body.results.map((result) => result.matches[0]!.signals.lexicalRank)).toEqual(body.results.map((_, index) => index + 1));
  });

  test("N5: a whole-release (search-release.v2) layout of an @3 index answers like its shards", async () => {
    const sharded = await release(THREAD_PHRASE_LEXICAL_REVISION);
    const whole = await legacyV2SearchObjects(await release(THREAD_PHRASE_LEXICAL_REVISION, "release-3", 1_000));
    for (const query of ["request manager", "consumer network thread request manager", "KIP770", "770"]) {
      const expected = await searchR2Projection(new MemoryBucket(sharded).asR2(), { query, limit: 20 });
      const actual = await searchR2Projection(new MemoryBucket(whole).asR2(), { query, limit: 20 });
      expect(expected.results.length).toBeGreaterThan(0);
      expect(actual.retrieval.lexicalRevision).toBe("bm25-reference@3");
      expect(roots(actual)).toEqual(roots(expected));
      expect(exactRoots(actual)).toEqual(exactRoots(expected));
    }
  });

  test("N11: @2, then @3, then @2 again (rollback) in one bucket each rank with their own revision", async () => {
    const first = await release(CODE_TEXT_LEXICAL_REVISION, "release-a");
    const second = await release(THREAD_PHRASE_LEXICAL_REVISION, "release-b");
    const rollback = await release(CODE_TEXT_LEXICAL_REVISION, "release-c");
    const immutable = (objects: readonly ProjectionObject[]) => objects.filter((object) => object.key !== SEARCH_CURRENT_KEY);
    const current = (objects: readonly ProjectionObject[]) => objects.find((object) => object.key === SEARCH_CURRENT_KEY)!;

    const refs: string[] = [];
    const seen: string[] = [];
    for (const objects of [first, second, rollback]) {
      const bucket = new MemoryBucket([...immutable(first), ...immutable(second), ...immutable(rollback), current(objects)]).asR2();
      const words = await searchR2Projection(bucket, { query: "request manager", limit: 20 });
      const identifier = await searchR2Projection(bucket, { query: "KIP770", limit: 20 });
      seen.push(`${words.retrieval.lexicalRevision} ${roots(words)[0]} ${words.results.length} ${exactRoots(identifier).length}`);
      refs.push(words.results[0]!.detailRef, identifier.results[0]!.detailRef);
      // A detailRef issued for an earlier release of either revision still resolves.
      for (const ref of refs) expect((await readSearchDetailProjection(bucket, ref))?.entry.sourceTitleRecordId).toBeDefined();
    }
    expect(seen).toEqual([
      `bm25-reference@2 ${RELEASE_MANAGER} 8 2`,
      "bm25-reference@3 kafka:jira:issue:KAFKA-19804 8 2",
      `bm25-reference@2 ${RELEASE_MANAGER} 8 2`,
    ]);
  });

  test.each(["bm25-reference@4", "bm25-reference@30", "bm25-reference@3 ", "bm25-reference"])(
    "N9: a release declaring %p fails closed with HTTP 503 and is not cached",
    async (revision) => {
      const withRevision = (objects: readonly ProjectionObject[], value: string) => objects.map((object) =>
        object.key.endsWith("/manifest.json") ? { ...object, body: JSON.stringify({ ...JSON.parse(object.body), lexicalRevision: value }) } : object);
      const sharded = await release(THREAD_PHRASE_LEXICAL_REVISION);
      const whole = await legacyV2SearchObjects(await release(THREAD_PHRASE_LEXICAL_REVISION, "release-3", 1_000));
      for (const objects of [sharded, whole]) {
        // Positive control: the same objects answer while they declare @3.
        const intact = await searchRequest("https://dev.example/api/search?q=request%20manager", new MemoryBucket(objects).asR2());
        expect(intact.status).toBe(200);
        expect((await intact.json() as { results: unknown[] }).results.length).toBeGreaterThan(0);

        const bucket = new MemoryBucket(withRevision(objects, revision));
        await expect(searchR2Projection(bucket.asR2(), { query: "request manager", limit: 5 }))
          .rejects.toThrow(`unsupported lexical revision ${revision}`);
        // Nothing after the manifest is read for a release the reader does not understand.
        expect(bucket.reads.filter((key) => key.includes("/lexical/") || key.endsWith("/terms.json"))).toEqual([]);
        const response = await searchRequest("https://dev.example/api/search?q=request%20manager", bucket.asR2());
        expect(response.status).toBe(503);
        expect([intact.headers.get("cache-control"), response.headers.get("cache-control")])
          .toEqual(["public, max-age=30, stale-while-revalidate=120", "no-store"]);
        expect(await response.json()).toMatchObject({ error: expect.stringContaining(`unsupported lexical revision ${revision}`) });
      }
    },
  );
});
