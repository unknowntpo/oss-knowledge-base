import { describe, expect, test } from "bun:test";

import { parseSearchGoldenFixture, tokenizeLexical } from "@oss-knowledge-base/search";
import {
  buildR2SearchProjection,
  createSearchDetailRef,
  parseSearchDetailRef,
  SEARCH_CURRENT_KEY,
  SEARCH_DETAIL_POOL,
  searchTermsKey,
  sha256Digest,
  type ProjectionObject,
  type SearchLexicalShardV2,
  type SearchPublicationV1,
  type SearchReleaseManifestV3,
  type SearchResponseV1,
} from "@oss-knowledge-base/serving-contract";

import { readSearchDetailProjection, searchR2Projection } from "../functions/_shared/search-projection";
import { buildGoldenSearchPublication } from "../scripts/build-search-fixture";
import { legacyV2SearchObjects } from "./legacy-search-release";
import { parseFilters, testPlanRows } from "./search-parity.cases";

const fixturePath = new URL("../../../packages/search/test/fixtures/golden-queries.v1.json", import.meta.url).pathname;

class CountingBucket {
  readonly reads: string[] = [];
  inFlight = 0;
  peakInFlight = 0;
  private readonly values: Map<string, string>;

  constructor(objects: readonly { readonly key: string; readonly body: string }[]) {
    this.values = new Map(objects.map((object) => [object.key, object.body]));
  }

  get = async (key: string) => {
    this.reads.push(key);
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.inFlight -= 1;
    const body = this.values.get(key);
    return body === undefined ? null : { json: async <T>() => JSON.parse(body) as T };
  };

  asR2(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

async function golden(revision?: string): Promise<SearchPublicationV1> {
  return buildGoldenSearchPublication(fixturePath, revision);
}

function withoutDetailRefs(response: SearchResponseV1) {
  return { ...response, results: response.results.map(({ detailRef: _ref, ...result }) => result) };
}

function manifestOf(objects: readonly ProjectionObject[]): SearchReleaseManifestV3 {
  return JSON.parse(objects.find((object) => object.key.endsWith("/manifest.json"))!.body) as SearchReleaseManifestV3;
}

describe("Spec 013 sharded Search reader", () => {
  test.each(testPlanRows)("$id: $query equals the whole-release response (filters $filters, limit $limit)", async (row) => {
    const publication = await golden();
    const sharded = await buildR2SearchProjection(publication, { maxShardChunks: 2 });
    const whole = await legacyV2SearchObjects(await buildR2SearchProjection(publication));
    const filters = parseFilters(row.filters);
    const request = { query: row.query, limit: row.limit, ...(filters === undefined ? {} : { filters }) };

    const bucket = new CountingBucket(sharded);
    const actual = await searchR2Projection(bucket.asR2(), request);
    const expected = await searchR2Projection(new CountingBucket(whole).asR2(), request);
    expect(withoutDetailRefs(actual)).toEqual(withoutDetailRefs(expected));
    // The production shard size takes the same path with one shard per project.
    expect(withoutDetailRefs(await searchR2Projection(new CountingBucket(await buildR2SearchProjection(publication)).asR2(), request)))
      .toEqual(withoutDetailRefs(expected));

    const manifest = manifestOf(sharded);
    expect(manifest.shards).toHaveLength(5);
    const terms = new Set(tokenizeLexical(row.query));
    const holding = manifest.shards.filter((shard) => {
      const body = JSON.parse(sharded.find((object) => object.key === shard.key)!.body) as SearchLexicalShardV2;
      return Object.keys(body.postings).some((term) => terms.has(term));
    });
    expect(holding.length).toBe(row.shardsRead);
    expect(bucket.reads).toEqual([
      SEARCH_CURRENT_KEY,
      `public/search/v1/releases/${publication.indexRevision}/manifest.json`,
      searchTermsKey(publication.indexRevision),
      ...holding.map((shard) => shard.key),
    ]);
    if (row.id === "L3") {
      expect(actual.results).toEqual([]);
      expect(actual.facets.projects.every((facet) => facet.count === 0)).toBe(true);
    } else {
      expect(actual.results.length).toBeGreaterThan(0);
    }
  });

  test("L2: the golden queries keep their Phase 1 grades through the sharded R2 path", async () => {
    const fixture = parseSearchGoldenFixture(await Bun.file(fixturePath).json());
    const bucket = new CountingBucket(await buildR2SearchProjection(await golden(), { maxShardChunks: 2 })).asR2();
    for (const query of fixture.queries.filter((candidate) => candidate.minimumPhase === 1)) {
      const response = await searchR2Projection(bucket, { ...query.request, limit: query.expectation.topK });
      const roots = response.results.map((result) => result.entry.sourceTitleRecordId);
      const evidence = new Set(response.results.flatMap((result) => result.matches.map((match) => match.recordId)));
      for (const required of query.expectation.requiredGroupRootRecordIds) expect(roots, query.id).toContain(required);
      for (const forbidden of query.expectation.forbiddenGroupRootRecordIds) expect(roots, query.id).not.toContain(forbidden);
      for (const required of query.expectation.requiredEvidenceRecordIds) expect(evidence.has(required), query.id).toBe(true);
    }
  });

  test("L4: a v3 detailRef hydrates the whole-release detail with three reads", async () => {
    const publication = await golden();
    const sharded = await buildR2SearchProjection(publication, { maxShardChunks: 2 });
    const whole = new CountingBucket(await legacyV2SearchObjects(await buildR2SearchProjection(publication))).asR2();
    const response = await searchR2Projection(new CountingBucket(sharded).asR2(), { query: "storage broker", limit: 10 });
    expect(response.results.length).toBeGreaterThan(2);

    for (const result of response.results) {
      const reference = parseSearchDetailRef(result.detailRef);
      expect(reference.shard).toBeNumber();
      const bucket = new CountingBucket(sharded);
      const detail = await readSearchDetailProjection(bucket.asR2(), result.detailRef);
      expect(detail).toEqual(await readSearchDetailProjection(whole, result.detailRef));
      expect(detail?.entry.reason).toMatchObject({ kind: "search-match", query: "storage broker" });
      expect(bucket.reads).toHaveLength(3);
      expect(bucket.reads[1]).toBe(manifestOf(sharded).shards[reference.shard!]!.key);
      expect(bucket.reads[2]).toStartWith(SEARCH_DETAIL_POOL);
    }
  });

  test("L7: mixed releases — v2, then v3, then v2 again (Worker rollback) — all serve and keep detailRefs", async () => {
    const v2 = await legacyV2SearchObjects(await buildR2SearchProjection(await golden("release-v2")));
    const v3 = await buildR2SearchProjection(await golden("release-v3"), { maxShardChunks: 2 });
    const rollback = await legacyV2SearchObjects(await buildR2SearchProjection(await golden("release-rollback")));
    const immutable = (objects: readonly ProjectionObject[]) => objects.filter((object) => object.key !== SEARCH_CURRENT_KEY);
    const current = (objects: readonly ProjectionObject[]) => objects.find((object) => object.key === SEARCH_CURRENT_KEY)!;
    const request = { query: "KIP-405", limit: 3 };

    const refs: string[] = [];
    let expected: unknown;
    for (const release of [v2, v3, rollback]) {
      const bucket = new CountingBucket([...immutable(v2), ...immutable(v3), ...immutable(rollback), current(release)]).asR2();
      const response = await searchR2Projection(bucket, request);
      expect(response.results.length).toBeGreaterThan(0);
      const { retrieval: _retrieval, ...comparable } = withoutDetailRefs(response);
      expected ??= comparable;
      expect(comparable).toEqual(expected as typeof comparable);
      refs.push(response.results[0]!.detailRef);
      for (const ref of refs) {
        expect((await readSearchDetailProjection(bucket, ref))?.entry.sourceTitleRecordId).toBe("kafka:wiki:kip-405");
      }
    }
    expect(parseSearchDetailRef(refs[1]!).shard).toBeNumber();
    expect(parseSearchDetailRef(refs[2]!).shard).toBeUndefined();
  });

  const breakages: readonly [string, (objects: ProjectionObject[], manifest: SearchReleaseManifestV3) => ProjectionObject[], string][] = [
    ["a selected shard is missing", (objects, manifest) => objects.filter((object) => object.key !== manifest.shards[4]!.key), "shard 4 is missing or invalid"],
    ["a shard names another shard number", (objects, manifest) => editShard(objects, manifest.shards[4]!.key, (shard) => ({ ...shard, shard: 3 })), "shard 4 is missing or invalid"],
    ["a shard belongs to another project", (objects, manifest) => editShard(objects, manifest.shards[4]!.key, (shard) => ({ ...shard, projectId: "apache-datafusion" })), "shard 4 is missing or invalid"],
    ["the terms object is missing", (objects) => objects.filter((object) => !object.key.endsWith("/terms.json")), "terms object is missing or invalid"],
    ["a shard's lengths do not match its chunks", (objects, manifest) => editShard(objects, manifest.shards[4]!.key, (shard) => ({ ...shard, lengths: shard.lengths.slice(1) })), "shard 4 is missing or invalid"],
    ["a terms entry has no shard", (objects) => editTerms(objects, (terms) => ({ ...terms, terms: { ...terms.terms, "kip-405": [1] } })), "terms entry is invalid for kip-405"],
    ["a terms entry is negative", (objects) => editTerms(objects, (terms) => ({ ...terms, terms: { ...terms.terms, "kip-405": [-1, 4] } })), "terms entry is invalid for kip-405"],
    ["a terms entry is fractional", (objects) => editTerms(objects, (terms) => ({ ...terms, terms: { ...terms.terms, "kip-405": [1, 3.5] } })), "terms entry is invalid for kip-405"],
    ["a terms entry is not an array", (objects) => editTerms(objects, (terms) => ({ ...terms, terms: { ...terms.terms, "kip-405": "40" } })), "terms entry is invalid for kip-405"],
    ["the terms object has another revision", (objects) => editTerms(objects, (terms) => ({ ...terms, indexRevision: "other" })), "terms object is missing or invalid"],
    ["a term names an undeclared shard", (objects) => editTerms(objects, (terms) => ({ ...terms, terms: { ...terms.terms, "kip-405": [1, 9] } })), "undeclared shard 9"],
  ];

  test.each(breakages)("L8: %s fails the query instead of returning partial results", async (_label, breakage, message) => {
    const objects = [...await buildR2SearchProjection(await golden(), { maxShardChunks: 2 })];
    // Positive control: the intact release answers the same query from shard 4.
    const intact = await searchR2Projection(new CountingBucket(objects).asR2(), { query: "KIP-405", limit: 3 });
    expect(intact.results[0]?.entry.sourceTitleRecordId).toBe("kafka:wiki:kip-405");

    const broken = new CountingBucket(breakage(objects, manifestOf(objects))).asR2();
    await expect(searchR2Projection(broken, { query: "KIP-405", limit: 3 })).rejects.toThrow(message);
  });

  test("L3: a query reads at most four shards at once, and does read them concurrently", async () => {
    const bucket = new CountingBucket(await buildR2SearchProjection(await golden(), { maxShardChunks: 1 }));
    const response = await searchR2Projection(bucket.asR2(), { query: "the", limit: 5 });
    expect(response.results.length).toBeGreaterThan(0);
    expect(bucket.reads.length).toBeGreaterThan(3 + 4);
    expect(bucket.peakInFlight).toBe(4);
  });

  test.each([-1, 1.5, "1"])("L9: a detailRef shard of %p is invalid", async (shard) => {
    const valid = { indexRevision: "r", projectId: "apache-kafka", groupRootRecordId: "g", query: "q", matchedRecordIds: ["g"] };
    expect(parseSearchDetailRef(createSearchDetailRef({ ...valid, shard: 2 })).shard).toBe(2);
    expect(() => createSearchDetailRef({ ...valid, shard: shard as number })).toThrow("Search detailRef shard is invalid");
    const forged = `sdr1.${btoa(JSON.stringify({ schema: "osskb.search-detail-ref.v1", ...valid, shard }))
      .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
    expect(() => parseSearchDetailRef(forged)).toThrow("Search detailRef is invalid");
  });

  test("L9: a v3 detailRef with a wrong, foreign, or missing shard is not found", async () => {
    const publication = await golden();
    const objects = await buildR2SearchProjection(publication, { maxShardChunks: 2 });
    const bucket = new CountingBucket(objects).asR2();
    const response = await searchR2Projection(bucket, { query: "KIP-405", limit: 1 });
    const reference = parseSearchDetailRef(response.results[0]!.detailRef);
    const { schema: _schema, shard, ...rest } = reference;
    expect(await readSearchDetailProjection(bucket, response.results[0]!.detailRef)).toBeDefined();

    const variants = [
      createSearchDetailRef({ ...rest, shard: 5 }),
      createSearchDetailRef({ ...rest, shard: 0 }),
      createSearchDetailRef({ ...rest, shard: shard! - 1 }),
      createSearchDetailRef(rest),
      createSearchDetailRef({ ...rest, projectId: "apache-datafusion", shard: shard! }),
    ];
    for (const variant of variants) expect(await readSearchDetailProjection(bucket, variant)).toBeUndefined();
  });

  test("L12: Object.prototype member names are ordinary terms in the terms object and shards", async () => {
    const publication = await golden();
    const absent = new CountingBucket(await buildR2SearchProjection(publication, { maxShardChunks: 2 }));
    const none = await searchR2Projection(absent.asR2(), { query: "constructor __proto__", limit: 5 });
    expect(none.results).toEqual([]);
    expect(absent.reads).toHaveLength(3);

    // Positive control: once a chunk contains the terms, the same query finds it.
    const withTerms: SearchPublicationV1 = {
      ...publication,
      shards: publication.shards.map((shard) => ({
        ...shard,
        chunks: shard.chunks.map((chunk) => chunk.groupRootRecordId === "kafka:wiki:kip-1150"
          ? { ...chunk, text: `${chunk.text} constructor __proto__` }
          : chunk),
      })),
    };
    const present = await searchR2Projection(
      new CountingBucket(await buildR2SearchProjection(withTerms, { maxShardChunks: 2 })).asR2(),
      { query: "constructor __proto__", limit: 5 },
    );
    expect(present.results.map((result) => result.entry.sourceTitleRecordId)).toEqual(["kafka:wiki:kip-1150"]);
  });

  test("L11: a project without groups has no shard and no facet; an empty release returns nothing", async () => {
    const publication = await golden();
    const withEmptyProject: SearchPublicationV1 = {
      ...publication,
      shards: [...publication.shards, { ...publication.shards[0]!, projectId: "apache-flink", chunks: [], groups: [] }],
    };
    const objects = await buildR2SearchProjection(withEmptyProject, { maxShardChunks: 2 });
    expect(manifestOf(objects).shards.map((shard) => shard.projectId)).not.toContain("apache-flink");
    const response = await searchR2Projection(new CountingBucket(objects).asR2(), { query: "storage", limit: 5 });
    expect(response.facets.projects.map((facet) => facet.projectId)).toEqual(["apache-datafusion", "apache-kafka"]);

    const empty = await buildR2SearchProjection({ ...publication, shards: [], details: [] });
    const bucket = new CountingBucket(empty);
    const nothing = await searchR2Projection(bucket.asR2(), { query: "storage", limit: 5 });
    expect(nothing.results).toEqual([]);
    expect(nothing.facets.projects).toEqual([]);
    expect(bucket.reads).toHaveLength(3);
  });
});

function editShard(
  objects: readonly ProjectionObject[],
  key: string,
  edit: (shard: SearchLexicalShardV2) => unknown,
): ProjectionObject[] {
  return objects.map((object) => object.key === key
    ? { ...object, body: JSON.stringify(edit(JSON.parse(object.body) as SearchLexicalShardV2)) }
    : object);
}

function editTerms(
  objects: readonly ProjectionObject[],
  edit: (terms: { indexRevision: string; terms: Record<string, number[]> }) => unknown,
): ProjectionObject[] {
  return objects.map((object) => object.key.endsWith("/terms.json")
    ? { ...object, body: JSON.stringify(edit(JSON.parse(object.body))) }
    : object);
}
