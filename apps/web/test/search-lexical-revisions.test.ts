import { describe, expect, test } from "bun:test";

import { searchIdentifierProfiles } from "@oss-knowledge-base/reference-pipeline/search-profiles";
import {
  buildLexicalIndex,
  CODE_TEXT_LEXICAL_REVISION,
  DEFAULT_LEXICAL_REVISION,
  lexicalQueryTerms,
  lexicalSearchConfigFor,
  parseSearchGoldenFixtureV2,
  searchLexicalIndex,
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
import { testPlanRows } from "./search-lexical-revisions.cases";

const goldenV2Path = new URL("../../../packages/search/test/fixtures/golden-queries.v2.json", import.meta.url).pathname;

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

const roots = (response: Awaited<ReturnType<typeof searchR2Projection>>) =>
  response.results.map((result) => result.entry.sourceTitleRecordId);
const exactRoots = (response: Awaited<ReturnType<typeof searchR2Projection>>) =>
  response.results.filter((result) => result.matches.some((match) => match.signals.exactIdentifier))
    .map((result) => result.entry.sourceTitleRecordId);

function searchRequest(url: string, bucket: R2Bucket) {
  return searchHandler({ request: new Request(url), env: { OSS_KB_BUCKET: bucket } } as unknown as Parameters<typeof searchHandler>[0]);
}

describe("Spec 016 Pages reader at bm25-reference@1 and @2", () => {
  test.each([...testPlanRows])("$id: $case ($query at $revision)", async (row) => {
    const objects = await release(row.revision);
    const bucket = new MemoryBucket(objects);
    const filters = row.projects === null ? undefined : { projectIds: row.projects.split(" ") };
    const response = await searchR2Projection(bucket.asR2(), { query: row.query, limit: 20, ...(filters === undefined ? {} : { filters }) });

    expect(response.retrieval.lexicalRevision).toBe(row.revision);
    expect(exactRoots(response).join(" ")).toBe(row.exact ?? "");
    expect(roots(response).slice(0, exactRoots(response).length)).toEqual(exactRoots(response));
    for (const required of (row.includes ?? "").split(" ").filter(Boolean)) expect(roots(response)).toContain(required);
    expect(response.results).toHaveLength(row.results);

    // The whole-corpus index of the same revision and profiles is the oracle.
    const golden = parseSearchGoldenFixtureV2(await Bun.file(goldenV2Path).json());
    const config = lexicalSearchConfigFor(row.revision, searchIdentifierProfiles);
    const oracle = searchLexicalIndex(buildLexicalIndex({ indexRevision: "oracle", chunks: golden.chunks, config }), {
      query: row.query,
      limit: 20,
      ...(filters === undefined ? {} : { filters }),
    });
    expect(roots(response)).toEqual(oracle.map((result) => result.groupRootRecordId));
    expect(response.results.map((result) => result.matches.map((match) => [match.chunkId, match.matchedTerms, match.excerpt])))
      .toEqual(oracle.map((result) => result.matches.map((match) => [match.chunkId, match.matchedTerms, match.excerpt])));

    // Only shards holding one of the release's query terms are read.
    const manifest = manifestOf(objects);
    const terms = new Set(lexicalQueryTerms(row.query, config));
    const holding = manifest.shards.filter((shard) => {
      const body = JSON.parse(objects.find((object) => object.key === shard.key)!.body) as SearchLexicalShardV2;
      return Object.keys(body.postings).some((term) => terms.has(term));
    });
    expect(manifest.shards.length).toBeGreaterThan(5);
    expect(bucket.reads).toEqual([
      SEARCH_CURRENT_KEY,
      `public/search/v1/releases/${manifest.indexRevision}/manifest.json`,
      searchTermsKey(manifest.indexRevision),
      ...holding.map((shard) => shard.key),
    ]);
    if (row.results > 0) expect(holding.length).toBeGreaterThan(0);
  });

  test("H25: @1, then @2, then @1 again (Worker rollback) in one bucket each answer with their own tokens", async () => {
    const first = await release(DEFAULT_LEXICAL_REVISION, "release-a");
    const second = await release(CODE_TEXT_LEXICAL_REVISION, "release-b");
    const rollback = await release(DEFAULT_LEXICAL_REVISION, "release-c");
    const immutable = (objects: readonly ProjectionObject[]) => objects.filter((object) => object.key !== SEARCH_CURRENT_KEY);
    const current = (objects: readonly ProjectionObject[]) => objects.find((object) => object.key === SEARCH_CURRENT_KEY)!;

    const refs: string[] = [];
    const seen: string[] = [];
    for (const objects of [first, second, rollback]) {
      const bucket = new MemoryBucket([...immutable(first), ...immutable(second), ...immutable(rollback), current(objects)]).asR2();
      const fragment = await searchR2Projection(bucket, { query: "RequestManager", limit: 20 });
      const identifier = await searchR2Projection(bucket, { query: "KIP770", limit: 20 });
      const canonical = await searchR2Projection(bucket, { query: "KIP-770", limit: 20 });
      seen.push(`${fragment.retrieval.lexicalRevision} ${fragment.results.length} ${identifier.results.length} ${exactRoots(canonical).length}`);
      refs.push(canonical.results[0]!.detailRef);
      // A detailRef issued for an earlier release of either revision still resolves.
      for (const ref of refs) {
        expect((await readSearchDetailProjection(bucket, ref))?.entry.sourceTitleRecordId).toBe("kafka:github:pull:22458");
      }
    }
    expect(seen).toEqual(["bm25-reference@1 0 0 2", "bm25-reference@2 8 7 2", "bm25-reference@1 0 0 2"]);
  });

  test("H25: an @1 release is answered as before, whatever identifier profiles the reader carries", async () => {
    const objects = await release(DEFAULT_LEXICAL_REVISION);
    // Written without profiles: the bytes are the same, so `@1` ignores them on both sides.
    const plain = await buildR2SearchProjection(await buildGoldenV2SearchPublication(goldenV2Path, "release-1", DEFAULT_LEXICAL_REVISION), { maxShardChunks: 2 });
    expect(objects).toEqual(plain);
    const response = await searchR2Projection(new MemoryBucket(objects).asR2(), { query: "#770 KIP770", limit: 20 });
    expect([...new Set(response.results.flatMap((result) => result.matches.flatMap((match) => match.matchedTerms)))]).toEqual(["770"]);
    // Positive control: the same query at `@2` is rewritten and matches.
    const after = await searchR2Projection(new MemoryBucket(await release(CODE_TEXT_LEXICAL_REVISION)).asR2(), { query: "#770 KIP770", limit: 20 });
    expect(new Set(after.results.flatMap((result) => result.matches.flatMap((match) => match.matchedTerms)))).toContain("kip-770");
  });

  test("H25: a whole-release (search-release.v2) layout of an @2 index answers like its shards", async () => {
    const sharded = await release(CODE_TEXT_LEXICAL_REVISION);
    const whole = await legacyV2SearchObjects(await release(CODE_TEXT_LEXICAL_REVISION, "release-2", 1_000));
    for (const query of ["KIP770", "770", "RequestManager"]) {
      const expected = await searchR2Projection(new MemoryBucket(sharded).asR2(), { query, limit: 20 });
      const actual = await searchR2Projection(new MemoryBucket(whole).asR2(), { query, limit: 20 });
      expect(expected.results.length).toBeGreaterThan(0);
      expect(roots(actual)).toEqual(roots(expected));
      expect(exactRoots(actual)).toEqual(exactRoots(expected));
    }
  });

  test("H34: /api/search serves an @2 release with the unchanged response schema", async () => {
    const bucket = new MemoryBucket(await release(CODE_TEXT_LEXICAL_REVISION)).asR2();
    const response = await searchRequest("https://dev.example/api/search?q=KIP770&limit=8", bucket);
    expect(response.status).toBe(200);
    const body = await response.json() as Awaited<ReturnType<typeof searchR2Projection>>;
    expect(body.schema).toBe("osskb.search-response.v1");
    expect(Object.keys(body).sort()).toEqual(["facets", "query", "results", "retrieval", "schema"]);
    expect(Object.keys(body.retrieval).sort()).toEqual(["generatedAt", "indexRevision", "lexicalRevision", "stale"]);
    expect(body.retrieval.lexicalRevision).toBe("bm25-reference@2");
    expect(body.query).toBe("KIP770");
    expect(Object.keys(body.results[0]!.matches[0]!.signals).sort()).toEqual(["exactIdentifier", "fusedRank", "lexicalRank"]);
    expect(body.results[0]!.matches[0]!.signals.exactIdentifier).toBe(true);
  });

  test.each(["bm25-reference@3", "bm25-reference", "bm25:v1"])("H37: a release declaring %s fails closed with HTTP 503", async (revision) => {
    const withRevision = (objects: readonly ProjectionObject[], value: string) => objects.map((object) =>
      object.key.endsWith("/manifest.json") ? { ...object, body: JSON.stringify({ ...JSON.parse(object.body), lexicalRevision: value }) } : object);
    const sharded = await release(CODE_TEXT_LEXICAL_REVISION);
    const whole = await legacyV2SearchObjects(await release(CODE_TEXT_LEXICAL_REVISION, "release-2", 1_000));
    for (const objects of [sharded, whole]) {
      // Positive control: the same objects answer while they declare a supported revision.
      const intact = await searchRequest("https://dev.example/api/search?q=KIP-770", new MemoryBucket(objects).asR2());
      expect(intact.status).toBe(200);
      expect((await intact.json() as { results: unknown[] }).results.length).toBeGreaterThan(0);

      const bucket = new MemoryBucket(withRevision(objects, revision));
      await expect(searchR2Projection(bucket.asR2(), { query: "KIP-770", limit: 5 }))
        .rejects.toThrow(`unsupported lexical revision ${revision}`);
      // Nothing after the manifest is read for a release the reader does not understand.
      expect(bucket.reads.filter((key) => key.includes("/lexical/") || key.endsWith("/terms.json"))).toEqual([]);
      const response = await searchRequest("https://dev.example/api/search?q=KIP-770", bucket.asR2());
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining(`unsupported lexical revision ${revision}`) });
    }
  });
});
