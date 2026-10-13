import { describe, expect, test } from "bun:test";

import { searchIdentifierProfiles } from "@oss-knowledge-base/reference-pipeline/search-profiles";
import {
  buildLexicalIndex,
  createInMemorySemanticRetriever,
  defaultFusionConfig,
  hybridSearch,
  leadingFullMatchFusionConfig,
  lexicalQueryTerms,
  lexicalQueryWords,
  lexicalSearchConfigFor,
  parseSearchGoldenFixtureV2,
  searchLexicalIndex,
  type SearchFiltersV1,
} from "@oss-knowledge-base/search";
import { chunkFingerprint, type SemanticQueryAnswerV1, type SemanticQueryPort } from "@oss-knowledge-base/semantic-vectorize";
import { searchEmbeddingProfile, SemanticQueryGate } from "@oss-knowledge-base/semantic-vectorize";
import { FakeVectorIndex, hashingEmbed, MemoryGateStorage, storeChunkVectors, testChunk } from "@oss-knowledge-base/semantic-vectorize/testing";
import {
  buildR2SearchProjection,
  SEARCH_CURRENT_KEY,
  searchShardForGroupRoot,
  searchTermsKey,
  type ProjectionObject,
  type SearchResponseV1,
} from "@oss-knowledge-base/serving-contract";

import { FAKE_SEMANTIC_REVISION, fakeEmbed } from "../../../packages/search/test/support/fake-embedder";
import { onRequestGet as searchHandler } from "../functions/api/search";
import { HYBRID_LEXICAL_DEPTH, readSearchDetailProjection, searchR2Projection, type SemanticSearchOptions } from "../functions/_shared/search-projection";
import { durableObjectSemanticGate, semanticSearchOptions } from "../functions/_shared/semantic-gate";
import { testPlanRows as realCorpusGuardRows } from "../../../packages/search/test/real-corpus-guards.cases";
import { testPlanRows as realCorpusRows } from "../../../packages/search/test/real-corpus.cases";
import { searchPublicationFromChunks } from "../scripts/build-search-fixture";
import { DIGEST_REQUESTS, lexicalGoldenRelease, responseDigests } from "../scripts/search-response-digests";
import {
  chunksOf,
  fakeGate,
  fakeProfile,
  goldenRelease,
  goldenV2Path,
  manifestOf,
  matchFor,
  MemoryBucket,
  okAnswer,
  RecordingGate,
  shardsOf,
  untouchableGate,
} from "./hybrid-harness";
import { legacyV2SearchObjects } from "./legacy-search-release";
import { testPlanRows } from "./search-hybrid.cases";

type Row = (typeof testPlanRows)[number];
const roots = (response: SearchResponseV1) => response.results.map((result) => result.entry.sourceTitleRecordId);
const semanticOnly = (response: SearchResponseV1) =>
  response.results.filter((result) => result.matches.every((match) => match.signals.lexicalRank === undefined)).map((result) => result.entry.sourceTitleRecordId);
const ids = (cell: string | null) => (cell === null ? [] : cell.split(" "));
const facetCounts = (response: SearchResponseV1) => Object.fromEntries(response.facets.projects.map((facet) => [facet.projectId, facet.count]));
const never = () => new Promise<never>(() => undefined);
/** A query none of whose words is in golden v2, so every result comes from semantic retrieval. */
const NO_LEXICAL_MATCH = "zzzz qqqq";

/** The lexical response of the same request: what every fallback must equal. */
const lexical = (objects: readonly ProjectionObject[], request: Parameters<typeof searchR2Projection>[1]) =>
  searchR2Projection(new MemoryBucket(objects).asR2(), request);

/** A hybrid response without the three fields hybrid search adds to `retrieval`. */
function withoutSemantic(response: SearchResponseV1): SearchResponseV1 {
  const { fusionRevision: _fusion, semanticRevision: _revision, semantic: _semantic, ...retrieval } = response.retrieval;
  return { ...response, retrieval };
}

async function releaseFor(row: Row): Promise<readonly ProjectionObject[]> {
  if (row.release === "v2") return legacyV2SearchObjects(await goldenRelease({ maxShardChunks: 1_000 }));
  return goldenRelease({ shardRoots: row.release === "roots" });
}

async function gateFor(row: Row, objects: readonly ProjectionObject[]): Promise<{ readonly gate: SemanticQueryPort; readonly asked: () => number }> {
  if (row.gate === "answers") {
    const { gate } = await fakeGate(chunksOf(objects));
    return { gate, asked: () => gate.requests.length };
  }
  if (row.gate === "must not be asked") return { gate: untouchableGate, asked: () => 0 };
  const answers: Record<Exclude<Row["gate"], "answers" | "must not be asked">, () => Promise<SemanticQueryAnswerV1>> = {
    throws: async () => { throw new Error("gate exploded: Bearer secret-token"); },
    "never answers": never,
    "over budget": async () => ({ status: "over-budget", retryAfterMs: 60_000 }),
    disabled: async () => ({ status: "disabled" }),
  };
  const gate = new RecordingGate(answers[row.gate]);
  return { gate, asked: () => gate.requests.length };
}

describe("Spec 016 hybrid search through the Pages reader", () => {
  test.each([...testPlanRows])("$id: $case ($query)", async (row) => {
    const objects = await releaseFor(row);
    const { gate, asked } = await gateFor(row, objects);
    const filters = row.projects === null ? undefined : { projectIds: row.projects.split(" ") };
    const request = { query: row.query, limit: 20, ...(filters === undefined ? {} : { filters }) };
    const response = await searchR2Projection(new MemoryBucket(objects).asR2(), request, { gate, timeoutMs: 20 });

    expect(response.retrieval.semantic).toEqual({
      status: row.status,
      ...(row.reason === null ? {} : { reason: row.reason }),
      ...(row.status === "ok" ? { candidates: expect.any(Number), cached: false } : {}),
    });
    expect(response.retrieval.fusionRevision).toBe("rrf-group@1");
    expect(response.retrieval.semanticRevision).toBe(row.status === "ok" ? fakeProfile.semanticRevision : undefined);
    expect(roots(response)).toEqual(ids(row.results));
    expect(semanticOnly(response)).toEqual(ids(row.semanticOnly));
    expect(response.results.map((result) => result.matches[0]!.signals.fusedRank)).toEqual(response.results.map((_, index) => index + 1));
    expect(asked()).toBe(row.gate === "must not be asked" ? 0 : 1);
    if (row.status !== "ok") {
      // Every fallback is the lexical response, plus the status.
      expect(withoutSemantic(response)).toEqual(await lexical(objects, request));
      expect(Object.keys(response.retrieval).sort()).toEqual(["fusionRevision", "generatedAt", "indexRevision", "lexicalRevision", "semantic", "stale"]);
    }
  });

  test("H28: the response adds only `fusionRevision`, `semanticRevision`, `semantic`, `signals.semanticRank`, and `signals.semanticScore`", async () => {
    const objects = await goldenRelease();
    const { gate } = await fakeGate(chunksOf(objects));
    const response = await searchR2Projection(new MemoryBucket(objects).asR2(), { query: "txn", limit: 20 }, { gate });

    expect(Object.keys(response).sort()).toEqual(["facets", "query", "results", "retrieval", "schema"]);
    expect(response.schema).toBe("osskb.search-response.v1");
    expect(response.retrieval).toEqual({
      indexRevision: "release-hybrid",
      lexicalRevision: "bm25-reference@3",
      generatedAt: "2026-08-25T12:00:00Z",
      stale: false,
      fusionRevision: "rrf-group@1",
      semanticRevision: "fake-concepts@1:4:title-text@1",
      semantic: { status: "ok", candidates: 2, cached: false },
    });
    const [both, onlySemantic] = response.results;
    // KAFKA-20785 holds `EndTxn`: lexical rank 1, and the second-nearest passage.
    expect(both!.matches.map((match) => match.signals)).toEqual([{ exactIdentifier: false, lexicalRank: 1, semanticRank: 2, semanticScore: expect.any(Number), fusedRank: 1 }]);
    expect(both!.matches[0]!.matchedTerms).toEqual(["txn"]);
    expect(onlySemantic!.matches.map((match) => match.signals)).toEqual([{ exactIdentifier: false, semanticRank: 1, semanticScore: expect.any(Number), fusedRank: 2 }]);
    for (const result of response.results) {
      expect(Object.keys(result).sort()).toEqual(["detailRef", "entry", "matches"]);
      expect(Object.keys(result.matches[0]!).sort())
        .toEqual(["author", "canonicalUrl", "chunkId", "excerpt", "matchedTerms", "occurredAt", "recordId", "signals", "sourceVersion"]);
    }
    // A repeated query is answered from the gate's cache, and says so.
    const again = await searchR2Projection(new MemoryBucket(objects).asR2(), { query: "txn", limit: 20 }, { gate });
    expect(again.retrieval.semantic).toEqual({ status: "ok", candidates: 2, cached: true });
    expect({ ...again, retrieval: response.retrieval }).toEqual(response);
  });

  test("H28: golden v2's semantic queries pass through the reader with the gate and not without it", async () => {
    const golden = parseSearchGoldenFixtureV2(await Bun.file(goldenV2Path).json());
    const objects = await goldenRelease();
    const { gate } = await fakeGate(chunksOf(objects));
    const semanticQueries = golden.queries.filter((query) => query.requires === "semantic");
    expect(semanticQueries.map((query) => query.request.query)).toEqual(["move cold data off broker disks", "txn", "交易逾時"]);
    const passes = (response: SearchResponseV1, query: (typeof semanticQueries)[number]) =>
      query.judgments.filter((judgment) => judgment.grade === 2)
        .every((judgment) => roots(response).slice(0, query.requiredWithin).includes(judgment.groupRootRecordId));
    const withGate: boolean[] = [];
    const without: boolean[] = [];
    for (const query of semanticQueries) {
      const request = { query: query.request.query, limit: 20 };
      withGate.push(passes(await searchR2Projection(new MemoryBucket(objects).asR2(), request, { gate }), query));
      without.push(passes(await lexical(objects, request), query));
    }
    expect(withGate).toEqual([true, true, true]);
    // `move cold data off broker disks` already passes lexically; the other two need the gate.
    expect(without).toEqual([true, false, false]);
  });

  test("H28: every request ranks as `hybridSearch` over the whole corpus does, whatever the limit and the filters", async () => {
    const objects = await goldenRelease();
    const chunks = chunksOf(objects);
    const config = lexicalSearchConfigFor("bm25-reference@3", searchIdentifierProfiles);
    const index = buildLexicalIndex({ indexRevision: "oracle", chunks, config });
    const oracleRetriever = createInMemorySemanticRetriever({ revision: FAKE_SEMANTIC_REVISION, chunks, embed: fakeEmbed });
    const requests: { readonly query: string; readonly limit: number; readonly filters?: SearchFiltersV1 }[] = [
      ...["交易逾時", "txn", "cold data", "transaction timeout", "move cold data off broker disks", "tiered storage cold data", "request manager", "transaction offsets", "older log segments timeout"]
        .flatMap((query) => [{ query, limit: 20 }, { query, limit: 1 }, { query, limit: 3 }]),
      { query: "transaction timeout", limit: 20, filters: { projectIds: ["apache-kafka"] } },
      { query: "cold data", limit: 20, filters: { projectIds: ["apache-datafusion"] } },
      { query: "cold data", limit: 20, filters: { sourceInstanceIds: ["apache-kafka-wiki"] } },
      { query: "交易逾時", limit: 20, filters: { occurredAfter: "2026-01-01T00:00:00Z" } },
      { query: "交易逾時", limit: 20, filters: { occurredBefore: "2026-01-01T00:00:00Z" } },
      { query: "cold data", limit: 20, filters: { tags: ["storage"] } },
    ];
    let reordered = 0;
    for (const request of requests) {
      const { gate } = await fakeGate(chunks);
      const response = await searchR2Projection(new MemoryBucket(objects).asR2(), request, { gate });
      const oracle = await hybridSearch({
        query: request.query,
        ...(request.filters === undefined ? {} : { filters: request.filters }),
        lexical: searchLexicalIndex(index, { ...request, limit: HYBRID_LEXICAL_DEPTH }),
        semantic: oracleRetriever,
        limit: request.limit,
      });
      expect(oracle.retrieval.semantic).toBe("ok");
      expect(roots(response)).toEqual(oracle.results.map((result) => result.groupRootRecordId));
      expect(response.results.map((result) => {
        const { exactIdentifier: _exact, semanticScore: _score, ...signals } = result.matches[0]!.signals;
        return signals;
      })).toEqual(oracle.results.map((result) => result.signals));
      expect(response.results.map((result) => result.matches.map((match) => match.chunkId)))
        .toEqual(oracle.results.map((result) => (result.lexical?.matches ?? result.semanticMatches).map((match) => match.chunkId)));
      const lexicalOrder = roots(await lexical(objects, request));
      if (JSON.stringify(roots(response)) !== JSON.stringify(lexicalOrder)) reordered += 1;
    }
    // Positive control: the oracle comparison is not a comparison of two lexical rankings.
    expect(reordered).toBeGreaterThan(8);
  });

  test("H28: the lexical ranks fusion reads do not depend on the request's limit", async () => {
    const objects = await goldenRelease();
    const chunks = chunksOf(objects);
    expect(HYBRID_LEXICAL_DEPTH).toBe(50);
    const full = await searchR2Projection(new MemoryBucket(objects).asR2(), { query: "cold data", limit: 50 }, { gate: (await fakeGate(chunks)).gate });
    for (const limit of [1, 2, 4]) {
      const response = await searchR2Projection(new MemoryBucket(objects).asR2(), { query: "cold data", limit }, { gate: (await fakeGate(chunks)).gate });
      expect(response.results).toEqual(full.results.slice(0, limit));
      expect(response.facets).toEqual(full.facets);
    }
    // KIP-405 is 4th lexically: with a lexical depth of the limit it would have no lexical rank at limit 1.
    expect(full.results[0]!.matches[0]!.signals).toMatchObject({ lexicalRank: 4, semanticRank: 1, fusedRank: 1 });
  });
});

describe("Spec 016 hybrid search: flag off", () => {
  const throwingNamespace = {
    idFromName: () => { throw new Error("the gate binding must not be used"); },
    get: () => { throw new Error("the gate binding must not be used"); },
  };

  test("H28: with the flag unset or blank every response is byte-identical to origin/main, and nothing is asked", async () => {
    const committed = (await Bun.file(new URL("./fixtures/search-responses.lexical.json", import.meta.url)).json()) as { readonly digests: Readonly<Record<string, string>> };
    expect(Object.keys(committed.digests)).toEqual([...DIGEST_REQUESTS]);
    expect(DIGEST_REQUESTS.length).toBeGreaterThan(30);
    const releases = [await lexicalGoldenRelease(), await goldenRelease({ indexRevision: "release-digests" })];
    expect(manifestOf(releases[1]!).shards[0]!.firstGroupRootRecordId).toBeDefined();
    for (const objects of releases) {
      for (const env of [{}, { SEARCH_SEMANTIC: "" }, { SEARCH_SEMANTIC: "  " }, { SEARCH_QUERY_GATE: throwingNamespace }, { SEARCH_SEMANTIC: " ", SEARCH_QUERY_GATE: throwingNamespace }]) {
        expect(await responseDigests(objects, env)).toEqual(committed.digests);
      }
    }
    // Positive control: with the flag on, the same requests no longer hash the same.
    const { gate } = await fakeGate(chunksOf(releases[1]!));
    const on = await responseDigests(releases[1]!, { SEARCH_SEMANTIC: "rrf-group@1", SEARCH_QUERY_GATE: namespaceOf(gate) });
    expect(Object.values(on).filter((digest, index) => digest !== Object.values(committed.digests)[index]).length).toBeGreaterThan(25);
    // The two error responses do not change.
    expect(on["q="]).toBe(committed.digests["q="]!);
    expect(on["q=request+manager&limit=51"]).toBe(committed.digests["q=request+manager&limit=51"]!);
  });

  test("H28: without options the reader reads what it read before and returns no hybrid field", async () => {
    const objects = await goldenRelease();
    const bucket = new MemoryBucket(objects);
    const response = await searchR2Projection(bucket.asR2(), { query: "交易逾時", limit: 20 });
    expect(Object.keys(response.retrieval).sort()).toEqual(["generatedAt", "indexRevision", "lexicalRevision", "stale"]);
    expect(response.results).toEqual([]);
    expect(bucket.reads).toHaveLength(3);
  });
});

/** A Durable Object namespace whose one object is `gate`, as the Pages binding presents it. */
function namespaceOf(gate: SemanticQueryPort, seen: { names: string[]; urls: string[]; bodies: unknown[] } = { names: [], urls: [], bodies: [] }): DurableObjectNamespace {
  return {
    idFromName: (name: string) => {
      seen.names.push(name);
      return { name };
    },
    get: () => ({
      fetch: async (url: string, init: { readonly method: string; readonly body: string; readonly signal?: AbortSignal }) => {
        seen.urls.push(`${init.method} ${url}`);
        seen.bodies.push(JSON.parse(init.body));
        return Response.json(await gate.query(JSON.parse(init.body), init.signal));
      },
    }),
  } as unknown as DurableObjectNamespace;
}

function request(url: string, env: Readonly<Record<string, unknown>>) {
  return searchHandler({ request: new Request(url), env } as unknown as Parameters<typeof searchHandler>[0]);
}

describe("Spec 016 hybrid search: the flag, the binding, and `semantic=off`", () => {
  test("H66: `SEARCH_SEMANTIC=rrf-group@1` with the gate binding answers hybrid through the Durable Object", async () => {
    const objects = await goldenRelease();
    const { gate } = await fakeGate(chunksOf(objects));
    const seen = { names: [] as string[], urls: [] as string[], bodies: [] as unknown[] };
    const env = { OSS_KB_BUCKET: new MemoryBucket(objects).asR2(), SEARCH_SEMANTIC: " rrf-group@1 ", SEARCH_QUERY_GATE: namespaceOf(gate, seen) };
    const response = await request("https://dev.example/api/search?q=%E4%BA%A4%E6%98%93%E9%80%BE%E6%99%82", env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=30, stale-while-revalidate=120");
    const body = await response.json() as SearchResponseV1;
    expect(body.retrieval.semantic).toEqual({ status: "ok", candidates: 2, cached: false });
    expect(roots(body)).toEqual(["kafka:jira:issue:KAFKA-20785", "kafka:jira:issue:KAFKA-20734"]);
    expect(seen).toEqual({
      names: ["search-query-gate-v1"],
      urls: ["POST https://search-query.internal/query"],
      // Every project of the release is asked, whatever the request filters.
      bodies: [{ query: "交易逾時", projectIds: ["apache-datafusion", "apache-kafka"] }],
    });
  });

  test("H61: `semantic=off` on a hybrid deployment returns the lexical ranking and asks nothing", async () => {
    const objects = await goldenRelease();
    const { gate } = await fakeGate(chunksOf(objects));
    const env = { OSS_KB_BUCKET: new MemoryBucket(objects).asR2(), SEARCH_SEMANTIC: "rrf-group@1", SEARCH_QUERY_GATE: namespaceOf(gate) };
    const hybrid = await (await request("https://dev.example/api/search?q=txn", env)).json() as SearchResponseV1;
    const off = await (await request("https://dev.example/api/search?q=txn&semantic=off", env)).json() as SearchResponseV1;
    expect(roots(hybrid)).toEqual(["kafka:jira:issue:KAFKA-20785", "kafka:jira:issue:KAFKA-20734"]);
    expect(off.retrieval.semantic).toEqual({ status: "disabled" });
    expect(withoutSemantic(off)).toEqual(await lexical(objects, { query: "txn", limit: 20 }));
    expect(gate.requests).toHaveLength(1);
    // Only `off` means off.
    for (const value of ["on", "OFF", "", "0"]) {
      const other = await (await request(`https://dev.example/api/search?q=txn&semantic=${value}`, env)).json() as SearchResponseV1;
      expect(other.retrieval.semantic!.status).toBe("ok");
    }
  });

  test.each([
    ["an unknown flag value", { SEARCH_SEMANTIC: "rrf-group@3" }, true],
    ["a known revision in another spelling", { SEARCH_SEMANTIC: "RRF-GROUP@2" }, true],
    ["`true`", { SEARCH_SEMANTIC: "true" }, true],
    ["the flag without the binding", { SEARCH_SEMANTIC: "rrf-group@1" }, false],
  ])("H66: %s answers lexically with `failed` and asks nothing", async (_, flags, bound) => {
    const objects = await goldenRelease();
    // A gate that would answer, so a flag wrongly honoured would show as `ok`.
    const { gate } = await fakeGate(chunksOf(objects));
    const env = { OSS_KB_BUCKET: new MemoryBucket(objects).asR2(), ...flags, ...(bound ? { SEARCH_QUERY_GATE: namespaceOf(gate) } : {}) };
    const response = await request("https://dev.example/api/search?q=txn", env);
    expect(response.status).toBe(200);
    const body = await response.json() as SearchResponseV1;
    expect(body.retrieval.semantic).toEqual({ status: "failed" });
    expect(withoutSemantic(body)).toEqual(await lexical(objects, { query: "txn", limit: 20 }));
    expect(gate.requests).toEqual([]);
    expect(semanticSearchOptions(flags, new URL("https://dev.example/api/search?q=txn"))).toEqual({ unavailable: true });
  });

  test("H66: the gate's client fails on anything but a 200, and reads a malformed body as `failed`", async () => {
    const stub = (response: () => Response) => ({ idFromName: () => ({}), get: () => ({ fetch: async () => response() }) }) as unknown as DurableObjectNamespace;
    await expect(durableObjectSemanticGate(stub(() => new Response("Not found", { status: 404 }))).query({ query: "txn", projectIds: ["apache-kafka"] }))
      .rejects.toThrow("The semantic query gate answered 404");
    expect(await durableObjectSemanticGate(stub(() => Response.json({ status: "ok" }))).query({ query: "txn", projectIds: ["apache-kafka"] })).toEqual({ status: "failed" });
    expect(await durableObjectSemanticGate(stub(() => Response.json({ status: "over-budget", retryAfterMs: 9 }))).query({ query: "txn", projectIds: ["apache-kafka"] }))
      .toEqual({ status: "over-budget", retryAfterMs: 9 });
  });

  test("H66: the development Pages configuration sets the flag and binds the data Worker's gate; production and local do neither", async () => {
    const read = async (name: string) => JSON.parse(await Bun.file(new URL(`../${name}`, import.meta.url)).text()) as Record<string, unknown> & { readonly name: string };
    const development = await read("wrangler.development.jsonc");
    expect(Object.keys(development).sort()).toEqual(["$schema", "compatibility_date", "durable_objects", "name", "pages_build_output_dir", "r2_buckets", "vars"]);
    expect(development.vars).toEqual({ SEARCH_SEMANTIC: "rrf-group@2" });
    expect(development.durable_objects).toEqual({ bindings: [{ name: "SEARCH_QUERY_GATE", class_name: "SearchQueryGate", script_name: "oss-knowledge-base-data-dev" }] });
    // The binding names the Dev publisher, which exports and migrates that class.
    const worker = JSON.parse(await Bun.file(new URL("../../data-publisher-worker/wrangler.development.jsonc", import.meta.url)).text()) as {
      readonly name: string;
      readonly migrations: readonly { readonly new_sqlite_classes: readonly string[] }[];
    };
    expect(worker.name).toBe("oss-knowledge-base-data-dev");
    expect(worker.migrations.flatMap((migration) => migration.new_sqlite_classes)).toContain("SearchQueryGate");
    // What the handler makes of exactly these values: hybrid search through the bound gate.
    const options = semanticSearchOptions(
      { SEARCH_SEMANTIC: (development.vars as { SEARCH_SEMANTIC: string }).SEARCH_SEMANTIC, SEARCH_QUERY_GATE: namespaceOf(untouchableGate) },
      new URL("https://dev.example/api/search?q=txn"),
    );
    expect(options).toMatchObject({ off: false });
    expect(options !== undefined && "gate" in options).toBe(true);

    for (const name of ["wrangler.jsonc", "wrangler.production.jsonc"]) {
      const config = await read(name);
      expect(Object.keys(config).sort()).toEqual(["$schema", "compatibility_date", "name", "pages_build_output_dir", "r2_buckets"]);
      expect(JSON.stringify(config)).not.toMatch(/SEARCH_SEMANTIC|SEARCH_QUERY_GATE|SearchQueryGate/u);
    }
  });
});

describe("Spec 016 fusion revision: selected by the flag", () => {
  const at2 = leadingFullMatchFusionConfig;
  const QUERY = "request manager";
  /** A gate proposing, best first, the threads lexical search ranks 5th to 8th for `request manager`: none holds both words. */
  async function partialMatchesGate(objects: readonly ProjectionObject[]) {
    const chunks = chunksOf(objects);
    const lexicalRoots = roots(await lexical(objects, { query: QUERY, limit: 20 }));
    const proposed = lexicalRoots.slice(4, 8);
    const matches = await Promise.all(proposed.map((root, index) => matchFor(chunks.find((chunk) => chunk.groupRootRecordId === root)!, 0.9 - index / 10)));
    return { lexicalRoots, proposed, gate: new RecordingGate(async () => okAnswer(matches)) };
  }

  test("H77: `SEARCH_SEMANTIC=rrf-group@2` keeps the threads holding every query word first, where rrf-group@1 puts them behind threads found twice", async () => {
    const objects = await goldenRelease();
    const { lexicalRoots, proposed, gate } = await partialMatchesGate(objects);
    expect(lexicalRoots).toHaveLength(8);
    const ask = async (flag: string) => {
      const seen = { names: [] as string[], urls: [] as string[], bodies: [] as unknown[] };
      const response = await request(`https://dev.example/api/search?q=${encodeURIComponent(QUERY)}`, { OSS_KB_BUCKET: new MemoryBucket(objects).asR2(), SEARCH_SEMANTIC: flag, SEARCH_QUERY_GATE: namespaceOf(gate, seen) });
      expect(response.status).toBe(200);
      return { body: await response.json() as SearchResponseV1, seen };
    };
    const one = await ask("rrf-group@1");
    const two = await ask(" rrf-group@2 ");
    expect(one.body.retrieval.fusionRevision).toBe("rrf-group@1");
    expect(two.body.retrieval.fusionRevision).toBe("rrf-group@2");
    // The measured failure, through the reader: four threads found by both retrievers pass the four best lexical ones.
    expect(roots(one.body)).toEqual([...proposed, ...lexicalRoots.slice(0, 4)]);
    // rrf-group@2: the four leading threads hold `request` and `manager` in one passage and keep their places.
    expect(roots(two.body)).toEqual(lexicalRoots);
    expect(two.body.results.map((result) => result.matches[0]!.signals)).toEqual(lexicalRoots.map((_, index) => ({
      exactIdentifier: false,
      lexicalRank: index + 1,
      ...(index < 4 ? {} : { semanticRank: index - 3, semanticScore: 0.9 - (index - 4) / 10 }),
      fusedRank: index + 1,
    })));
    // Everything but the order and the revision's name is the same response, and the gate is asked the same thing:
    // its caches do not know the fusion revision, so switching costs no model call and no index query.
    expect(two.seen).toEqual(one.seen);
    expect(two.seen.bodies).toEqual([{ query: QUERY, projectIds: ["apache-datafusion", "apache-kafka"] }]);
    const sorted = (body: SearchResponseV1) => body.results.map((result) => ({ ...result, matches: result.matches.map(({ signals: _signals, ...match }) => match) }))
      .sort((left, right) => left.entry.sourceTitleRecordId.localeCompare(right.entry.sourceTitleRecordId));
    expect(sorted(two.body)).toEqual(sorted(one.body));
    expect(two.body.facets).toEqual(one.body.facets);
    expect({ ...two.body.retrieval, fusionRevision: "rrf-group@1" }).toEqual(one.body.retrieval);
    expect(semanticSearchOptions({ SEARCH_SEMANTIC: "rrf-group@2", SEARCH_QUERY_GATE: namespaceOf(gate) }, new URL("https://dev.example/api/search?q=txn"))).toMatchObject({ fusion: at2, off: false });
    expect(semanticSearchOptions({ SEARCH_SEMANTIC: "rrf-group@1", SEARCH_QUERY_GATE: namespaceOf(gate) }, new URL("https://dev.example/api/search?q=txn"))).toMatchObject({ fusion: defaultFusionConfig });
  });

  test("H77: at rrf-group@2 every request ranks as `hybridSearch` over the whole corpus does, whatever the limit and the filters", async () => {
    const objects = await goldenRelease();
    const chunks = chunksOf(objects);
    const config = lexicalSearchConfigFor("bm25-reference@3", searchIdentifierProfiles);
    const index = buildLexicalIndex({ indexRevision: "oracle", chunks, config });
    const { proposed, gate } = await partialMatchesGate(objects);
    const candidates = proposed.map((root, position) => {
      const chunk = chunks.find((item) => item.groupRootRecordId === root)!;
      return { chunkId: chunk.id, recordId: chunk.recordId, groupRootRecordId: root, projectId: chunk.projectId, score: 0.9 - position / 10 };
    });
    const requests: { readonly query: string; readonly limit: number; readonly filters?: SearchFiltersV1 }[] = [
      ...[QUERY, "manager request", "release manager", "request", "consumer network thread request manager", "RequestManager", "transaction timeout", "交易逾時"]
        .flatMap((query) => [{ query, limit: 20 }, { query, limit: 3 }, { query, limit: 1 }]),
      { query: QUERY, limit: 20, filters: { projectIds: ["apache-kafka"] } },
      { query: QUERY, limit: 20, filters: { projectIds: ["apache-datafusion"] } },
    ];
    let changed = 0;
    for (const item of requests) {
      const response = await searchR2Projection(new MemoryBucket(objects).asR2(), item, { gate, fusion: at2 });
      const input = {
        query: item.query,
        ...(item.filters === undefined ? {} : { filters: item.filters }),
        lexical: searchLexicalIndex(index, { ...item, limit: HYBRID_LEXICAL_DEPTH }),
        semantic: { retrieve: async () => ({ semanticRevision: fakeProfile.semanticRevision, candidates }) },
        limit: item.limit,
      };
      const oracle = await hybridSearch({ ...input, config: at2, queryWords: lexicalQueryWords(item.query, config) });
      expect(response.retrieval.fusionRevision).toBe("rrf-group@2");
      expect([item, roots(response)]).toEqual([item, oracle.results.map((result) => result.groupRootRecordId)]);
      if (JSON.stringify(roots(response)) !== JSON.stringify((await hybridSearch(input)).results.map((result) => result.groupRootRecordId))) changed += 1;
    }
    // Positive control: on these requests the two revisions do not agree everywhere.
    expect(changed).toBeGreaterThan(3);
    expect(changed).toBeLessThan(requests.length);
  });

  test("H77: at rrf-group@2 every way semantic retrieval can be missing is still the lexical response, naming the revision", async () => {
    const objects = await goldenRelease();
    const expected = await lexical(objects, { query: QUERY, limit: 20 });
    const cases: readonly [string, SemanticSearchOptions, readonly ProjectionObject[], string][] = [
      ["failed", { gate: new RecordingGate(async () => { throw new Error("down"); }), fusion: at2 }, objects, QUERY],
      ["timed-out", { gate: new RecordingGate(never), fusion: at2, timeoutMs: 20 }, objects, QUERY],
      ["over-budget", { gate: new RecordingGate(async () => ({ status: "over-budget", retryAfterMs: 1 })), fusion: at2 }, objects, QUERY],
      ["disabled", { gate: new RecordingGate(async () => ({ status: "disabled" })), fusion: at2 }, objects, QUERY],
      ["disabled", { gate: untouchableGate, fusion: at2, off: true }, objects, QUERY],
      ["uncovered", { gate: untouchableGate, fusion: at2 }, await goldenRelease({ shardRoots: false }), QUERY],
      ["skipped", { gate: untouchableGate, fusion: at2 }, objects, "KIP770"],
    ];
    const original = console.error;
    console.error = () => undefined;
    try {
      for (const [status, options, release, query] of cases) {
        const response = await searchR2Projection(new MemoryBucket(release).asR2(), { query, limit: 20 }, options);
        expect([status, response.retrieval.semantic!.status]).toEqual([status, status]);
        expect(response.retrieval.fusionRevision).toBe("rrf-group@2");
        expect(withoutSemantic(response)).toEqual(query === QUERY && release === objects ? expected : await lexical(release, { query, limit: 20 }));
        expect(JSON.stringify(response)).not.toContain("semanticScore");
      }
    } finally {
      console.error = original;
    }
    // An `ok` answer without a single candidate is the lexical order too: the rule never reorders on its own.
    const empty = await searchR2Projection(new MemoryBucket(objects).asR2(), { query: QUERY, limit: 20 }, { gate: new RecordingGate(async () => okAnswer([])), fusion: at2 });
    expect(empty.retrieval.semantic).toEqual({ status: "ok", candidates: 0, cached: false });
    expect(withoutSemantic(empty)).toEqual(expected);
  });
});

describe("Spec 016 hybrid search: the similarity a result reports", () => {
  test("H78: `signals.semanticScore` is the similarity of the thread's best passage, present exactly when `semanticRank` is", async () => {
    const objects = await goldenRelease();
    const chunks = chunksOf(objects);
    const chunk = (recordId: string) => chunks.find((item) => item.recordId === recordId)!;
    const t20785 = chunk("kafka:jira:issue:KAFKA-20785");
    const reply = chunk("kafka:mail:kip-405-compaction");
    const root = chunks.find((item) => item.groupRootRecordId === reply.groupRootRecordId && item.id !== reply.id)!;
    // Two passages of one thread (0.4 and 0.75) and one of another (0.5), in no particular order.
    const gate = new RecordingGate(async () => okAnswer([await matchFor(root, 0.4), await matchFor(t20785, 0.5), await matchFor(reply, 0.75)]));
    for (const fusion of [defaultFusionConfig, leadingFullMatchFusionConfig]) {
      const response = await searchR2Projection(new MemoryBucket(objects).asR2(), { query: "txn", limit: 20 }, { gate, fusion });
      const signals = Object.fromEntries(response.results.map((result) => [result.entry.sourceTitleRecordId, result.matches.map((match) => match.signals)]));
      // `txn` is in KAFKA-20785 only: lexical rank 1, and the second semantic thread.
      expect(signals[t20785.groupRootRecordId]).toEqual([{ exactIdentifier: false, lexicalRank: 1, semanticRank: 2, semanticScore: 0.5, fusedRank: 1 }]);
      // The other thread shows both passages; each carries the thread's rank and its best similarity.
      expect(signals[reply.groupRootRecordId]).toEqual([
        { exactIdentifier: false, semanticRank: 1, semanticScore: 0.75, fusedRank: 2 },
        { exactIdentifier: false, semanticRank: 1, semanticScore: 0.75, fusedRank: 2 },
      ]);
      for (const result of response.results) {
        for (const match of result.matches) {
          expect("semanticScore" in match.signals).toBe(match.signals.semanticRank !== undefined);
        }
      }
    }
  });

  test("H78: a lexical thread without a semantic rank, a lexical response, and a flag-off response carry no similarity", async () => {
    const objects = await goldenRelease();
    const chunks = chunksOf(objects);
    const { gate } = await fakeGate(chunks);
    const hybrid = await searchR2Projection(new MemoryBucket(objects).asR2(), { query: "cold data", limit: 20 }, { gate });
    const withRank = hybrid.results.filter((result) => result.matches[0]!.signals.semanticRank !== undefined);
    const without = hybrid.results.filter((result) => result.matches[0]!.signals.semanticRank === undefined);
    expect([withRank.length, without.length]).toEqual([1, 4]);
    expect(withRank[0]!.matches[0]!.signals.semanticScore).toBeGreaterThan(0);
    expect(JSON.stringify(without)).not.toContain("semanticScore");
    expect(JSON.stringify(await searchR2Projection(new MemoryBucket(objects).asR2(), { query: "cold data", limit: 20 }, { gate, off: true }))).not.toContain("semanticScore");
    expect(JSON.stringify(await lexical(objects, { query: "cold data", limit: 20 }))).not.toContain("semanticScore");
    // A similarity the gate's client would refuse never reaches a response: the match is dropped whole (H58).
    const poisoned = new RecordingGate(async () => ({ ...okAnswer([]), matches: [{ ...await matchFor(chunks[0]!, 0.5), score: Number.NaN }, { ...await matchFor(chunks[0]!, 0.5), score: "0.9" }] }) as never);
    const dropped = await searchR2Projection(new MemoryBucket(objects).asR2(), { query: "cold data", limit: 20 }, { gate: poisoned });
    expect(dropped.retrieval.semantic).toEqual({ status: "ok", candidates: 0, cached: false });
    expect(JSON.stringify(dropped)).not.toContain("semanticScore");
  });
});

describe("Spec 016 hybrid search: fallbacks", () => {
  test("H29: /api/search answers 200 with the lexical body for every way the gate can be missing, and never shows its error", async () => {
    const objects = await goldenRelease();
    const expected = await lexical(objects, { query: "txn", limit: 20 });
    const gates: readonly [string, SemanticQueryPort][] = [
      ["failed", new RecordingGate(async () => { throw new Error("upstream said Bearer abc.def and account 0123456789abcdef0123456789abcdef"); })],
      ["failed", new RecordingGate(async () => ({ status: "failed" }))],
      ["failed", new RecordingGate(async () => ({ status: "nonsense" }) as never)],
      ["disabled", new RecordingGate(async () => ({ status: "disabled" }))],
      // Last, and for one millisecond: the handler remembers a spent budget for the whole isolate.
      ["over-budget", new RecordingGate(async () => ({ status: "over-budget", retryAfterMs: 1 }))],
    ];
    const logged: string[] = [];
    const original = console.error;
    console.error = (...values: unknown[]) => { logged.push(values.join(" ")); };
    try {
      for (const [status, gate] of gates) {
        const response = await request("https://dev.example/api/search?q=txn", { OSS_KB_BUCKET: new MemoryBucket(objects).asR2(), SEARCH_SEMANTIC: "rrf-group@1", SEARCH_QUERY_GATE: namespaceOf(gate) });
        expect(response.status).toBe(200);
        const text = await response.text();
        const body = JSON.parse(text) as SearchResponseV1;
        expect(body.retrieval.semantic).toEqual({ status } as never);
        expect(withoutSemantic(body)).toEqual(expected);
        expect(text).not.toContain("upstream");
        expect(text).not.toContain("Bearer");
        expect(text).not.toContain("error");
      }
    } finally {
      console.error = original;
    }
    // The thrown error is logged once, redacted.
    expect(logged).toEqual(["semantic retrieval failed: upstream said Bearer [redacted] and account [redacted]"]);
  });

  test("H29: a gate slower than the timeout is abandoned: the lexical answer returns, the call is aborted, and its late failure is nobody's", async () => {
    const objects = await goldenRelease();
    let reject: (error: Error) => void = () => undefined;
    const gate = new RecordingGate(() => new Promise<SemanticQueryAnswerV1>((_, fail) => { reject = fail; }));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const started = Date.now();
      const response = await searchR2Projection(new MemoryBucket(objects).asR2(), { query: "txn", limit: 20 }, { gate, timeoutMs: 30 });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(response.retrieval.semantic).toEqual({ status: "timed-out" });
      expect(roots(response)).toEqual(["kafka:jira:issue:KAFKA-20785"]);
      expect(gate.signals.map((signal) => signal.aborted)).toEqual([true]);
      reject(new Error("too late"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    // A gate that answers within the timeout is used.
    const quick = new RecordingGate(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return okAnswer([]); });
    expect((await searchR2Projection(new MemoryBucket(objects).asR2(), { query: "txn", limit: 20 }, { gate: quick, timeoutMs: 500 })).retrieval.semantic!.status).toBe("ok");
    expect(quick.signals.map((signal) => signal.aborted)).toEqual([false]);
  });

  test("H29: the timeout's timer is cleared when the gate answers or fails first; the default is 1,000 ms", async () => {
    const objects = await goldenRelease();
    const set = globalThis.setTimeout;
    const clear = globalThis.clearTimeout;
    const armed = new Map<unknown, number>();
    const cleared = new Set<unknown>();
    globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
      const id = set(handler, ms, ...rest);
      if (ms !== undefined && ms >= 777) armed.set(id, ms);
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => {
      cleared.add(id);
      clear(id);
    }) as typeof clearTimeout;
    try {
      for (const [gate, timeoutMs] of [
        [new RecordingGate(async () => okAnswer([])), 777],
        [new RecordingGate(async () => { throw new Error("no"); }), 778],
        [new RecordingGate(async () => okAnswer([])), undefined],
      ] as const) {
        await searchR2Projection(new MemoryBucket(objects).asR2(), { query: "txn", limit: 20 }, { gate, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      }
    } finally {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    }
    expect([...armed.values()]).toEqual([777, 778, 1_000]);
    expect([...armed.keys()].every((id) => cleared.has(id))).toBe(true);
  });

  test("H29: once the gate says its budget is spent, this isolate does not ask again until then", async () => {
    const objects = await goldenRelease();
    const gate = new RecordingGate(async () => ({ status: "over-budget", retryAfterMs: 60_000 }));
    const clock = { now: 1_000_000 };
    const options: SemanticSearchOptions = { gate, refusal: { until: 0 }, now: () => clock.now };
    const ask = async (query: string) => (await searchR2Projection(new MemoryBucket(objects).asR2(), { query, limit: 20 }, options)).retrieval.semantic;
    expect(await ask("txn")).toEqual({ status: "over-budget" });
    expect(await ask("another query")).toEqual({ status: "over-budget" });
    clock.now += 59_999;
    expect(await ask("a third query")).toEqual({ status: "over-budget" });
    expect(gate.requests).toHaveLength(1);
    clock.now += 1;
    gate.answer = async () => okAnswer([]);
    expect((await ask("a fourth query"))!.status).toBe("ok");
    expect(gate.requests).toHaveLength(2);
    // Without the memo every request asks.
    const forgetful = new RecordingGate(async () => ({ status: "over-budget", retryAfterMs: 60_000 }));
    for (const query of ["one more", "and another"]) await searchR2Projection(new MemoryBucket(objects).asR2(), { query, limit: 20 }, { gate: forgetful });
    expect(forgetful.requests).toHaveLength(2);
  });

  test("H29: with the gate over its real budget, queries fall back in mid-day and cached ones still answer", async () => {
    const objects = await goldenRelease();
    const { gate, model } = await fakeGate(chunksOf(objects), { dailyNeuronCap: 2 });
    const status = async (query: string) => (await searchR2Projection(new MemoryBucket(objects).asR2(), { query, limit: 20 }, { gate })).retrieval.semantic!.status;
    expect([await status("交易逾時"), await status("txn"), await status("cold data"), await status("交易逾時")]).toEqual(["ok", "ok", "over-budget", "ok"]);
    expect(model.calls).toBe(2);
    const refused = await searchR2Projection(new MemoryBucket(objects).asR2(), { query: "cold data", limit: 20 }, { gate });
    expect(withoutSemantic(refused)).toEqual(await lexical(objects, { query: "cold data", limit: 20 }));
  });
});

describe("Spec 016 hybrid search: consistency with the served release", () => {
  test("H58: a match counts only as the release's own chunk; stale, foreign, and poisoned matches are dropped", async () => {
    const objects = await goldenRelease();
    const chunks = chunksOf(objects);
    const chunk = (recordId: string) => chunks.find((item) => item.recordId === recordId)!;
    const t20785 = chunk("kafka:jira:issue:KAFKA-20785");
    const t20734 = chunk("kafka:jira:issue:KAFKA-20734");
    const reply = chunk("kafka:mail:kip-405-compaction");
    const datafusion = chunk("datafusion:github:pull:770");
    const good = await matchFor(t20785, 0.9);
    const cases: readonly [string, Awaited<ReturnType<typeof matchFor>>, readonly string[]][] = [
      ["the release's chunk", good, [t20785.groupRootRecordId]],
      ["a passage that is not the group root, found through its group", await matchFor(reply, 0.9), [reply.groupRootRecordId]],
      ["a fingerprint of other text", await matchFor(t20785, 0.9, { fingerprint: await chunkFingerprint({ ...t20785, text: "changed" }) }), []],
      ["a fingerprint of another group", await matchFor(t20785, 0.9, { fingerprint: await chunkFingerprint({ ...t20785, groupRootRecordId: "kafka:other" }) }), []],
      ["a record the release does not hold", await matchFor(t20785, 0.9, { recordId: "kafka:jira:issue:KAFKA-1" }), []],
      ["an ordinal the release does not hold", await matchFor(t20785, 0.9, { ordinal: 3 }), []],
      ["a group root that names another shard", await matchFor(t20785, 0.9, { groupRootRecordId: "kafka:github:issue:20970" }), []],
      ["a group root before the project's first shard", await matchFor(t20785, 0.9, { groupRootRecordId: "a" }), []],
      ["the record under another project", await matchFor(t20785, 0.9, { projectId: "apache-datafusion" }), []],
      ["a project the release does not hold", await matchFor(t20785, 0.9, { projectId: "apache-flink" }), []],
      ["another project's chunk under this project", await matchFor(datafusion, 0.9, { projectId: "apache-kafka" }), []],
    ];
    for (const [name, match, expected] of cases) {
      const response = await searchR2Projection(new MemoryBucket(objects).asR2(), { query: NO_LEXICAL_MATCH, limit: 20 }, { gate: new RecordingGate(async () => okAnswer([match])) });
      expect([name, roots(response)]).toEqual([name, [...expected]]);
      expect(response.retrieval.semantic).toEqual({ status: "ok", candidates: expected.length, cached: false });
    }

    // Every field of a result comes from the release's chunk, not from the match.
    const response = await searchR2Projection(new MemoryBucket(objects).asR2(), { query: NO_LEXICAL_MATCH, limit: 20 }, {
      gate: new RecordingGate(async () => okAnswer([good, await matchFor(t20734, 0.5), { ...good, score: 0.1 }])),
    });
    expect(response.results.map((result) => [result.entry.sourceTitleRecordId, result.matches.map((match) => match.chunkId)]))
      .toEqual([[t20785.groupRootRecordId, [t20785.id]], [t20734.groupRootRecordId, [t20734.id]]]);
  });

  test("H58: a gate answer holding null or malformed matches does not fail the search: they are dropped and the good match stays", async () => {
    const objects = await goldenRelease();
    const t20785 = chunksOf(objects).find((item) => item.recordId === "kafka:jira:issue:KAFKA-20785")!;
    const good = await matchFor(t20785, 0.9);
    const junk = [null, undefined, "x", 7, {}, { ...good, projectId: null }, { ...good, groupRootRecordId: 7 }, { ...good, ordinal: -1 }, { ...good, score: Number.NaN }, { ...good, recordId: "" }];
    // A port that skips the client's parsing, as a future caller or a bug might.
    const gate = new RecordingGate(async () => ({ status: "ok", semanticRevision: fakeProfile.semanticRevision, cached: false, matches: [...junk, good, ...junk] }) as never);
    const response = await searchR2Projection(new MemoryBucket(objects).asR2(), { query: NO_LEXICAL_MATCH, limit: 20 }, { gate });
    expect(roots(response)).toEqual([t20785.groupRootRecordId]);
    expect(response.retrieval.semantic).toEqual({ status: "ok", candidates: 1, cached: false });
    // Matches that are no list at all are no matches.
    const none = new RecordingGate(async () => ({ status: "ok", semanticRevision: fakeProfile.semanticRevision, cached: false, matches: null }) as never);
    const empty = await searchR2Projection(new MemoryBucket(objects).asR2(), { query: "txn", limit: 20 }, { gate: none });
    expect(roots(empty)).toEqual(["kafka:jira:issue:KAFKA-20785"]);
    expect(empty.retrieval.semantic).toEqual({ status: "ok", candidates: 0, cached: false });
  });

  test("H58: vectors newer, older, or of another revision than the release never become results (real gate)", async () => {
    const objects = await goldenRelease();
    const chunks = chunksOf(objects);
    const { gate, index } = await fakeGate(chunks);
    const t20785 = chunks.find((item) => item.recordId === "kafka:jira:issue:KAFKA-20785")!;
    // The index moved on: this passage was re-embedded from newer text, a removed record is still
    // stored, and another record is stored at another revision.
    await storeChunkVectors(index, [{ ...t20785, text: "交易 逾時 newer text the release does not hold" }], fakeEmbed, fakeProfile.semanticRevision);
    await storeChunkVectors(index, [testChunk({ recordId: "kafka:jira:issue:KAFKA-GONE", title: "transaction timeout", text: "交易逾時" })], fakeEmbed, fakeProfile.semanticRevision);
    await storeChunkVectors(index, [testChunk({ recordId: "kafka:jira:issue:KAFKA-OLDREV", title: "transaction timeout", text: "交易逾時" })], fakeEmbed, "fake-concepts@0:4:title-text@1");
    const response = await searchR2Projection(new MemoryBucket(objects).asR2(), { query: "交易逾時", limit: 20 }, { gate });
    // KAFKA-20785's vector is stale, so only the unchanged passage is a candidate.
    expect(roots(response)).toEqual(["kafka:jira:issue:KAFKA-20734"]);
    expect(response.retrieval.semantic).toEqual({ status: "ok", candidates: 1, cached: false });
  });

  test("H58: each shard is read at most once, four at a time, and only shards holding a term or a match", async () => {
    const objects = await goldenRelease();
    const manifest = manifestOf(objects);
    const chunks = chunksOf(objects);
    const config = lexicalSearchConfigFor("bm25-reference@3", searchIdentifierProfiles);
    const shardKeysHolding = (query: string) => {
      const terms = new Set(lexicalQueryTerms(query, config));
      return manifest.shards.filter((_, number) => Object.keys(shardsOf(objects)[number]!.postings).some((term) => terms.has(term))).map((shard) => shard.key);
    };
    const fixed = [SEARCH_CURRENT_KEY, `public/search/v1/releases/${manifest.indexRevision}/manifest.json`, searchTermsKey(manifest.indexRevision)];

    // A Chinese query: no shard holds a term; the two shards holding the matches are read.
    const chinese = new MemoryBucket(objects);
    await searchR2Projection(chinese.asR2(), { query: "交易逾時", limit: 20 }, { gate: (await fakeGate(chunks)).gate });
    const matchShards = ["kafka:jira:issue:KAFKA-20734", "kafka:jira:issue:KAFKA-20785"].map((root) => manifest.shards[searchShardForGroupRoot(manifest, "apache-kafka", root)!]!.key);
    expect(shardKeysHolding("交易逾時")).toEqual([]);
    expect(chinese.reads).toEqual([...fixed, ...new Set(matchShards)]);

    // A query whose terms are in most shards: the lexical shards, then the extra ones, none twice.
    const all = chunks.filter((chunk) => chunk.projectId === "apache-kafka");
    const everything = new RecordingGate(async () => okAnswer(await Promise.all(all.map((chunk, index) => matchFor(chunk, 1 - index / 100)))));
    const wide = new MemoryBucket(objects);
    await searchR2Projection(wide.asR2(), { query: "request manager", limit: 20 }, { gate: everything });
    const lexicalShards = shardKeysHolding("request manager");
    const kafkaShards = manifest.shards.filter((shard) => shard.projectId === "apache-kafka").map((shard) => shard.key);
    expect(lexicalShards.length).toBeGreaterThan(4);
    expect(kafkaShards.some((key) => !lexicalShards.includes(key))).toBe(true);
    expect(wide.reads.slice(0, 3)).toEqual(fixed);
    expect(wide.reads.slice(3, 3 + lexicalShards.length)).toEqual(lexicalShards);
    expect([...wide.reads.slice(3 + lexicalShards.length)].sort()).toEqual(kafkaShards.filter((key) => !lexicalShards.includes(key)).sort());
    expect(new Set(wide.reads).size).toBe(wide.reads.length);
    expect(wide.reads.length).toBeLessThanOrEqual(3 + manifest.shards.length);
    expect(wide.peak).toBe(4);

    // The lexical reader of the same query reads only the lexical shards.
    const plain = new MemoryBucket(objects);
    await searchR2Projection(plain.asR2(), { query: "request manager", limit: 20 });
    expect(plain.reads).toEqual([...fixed, ...lexicalShards]);
  });

  test("H58: the gate is asked before the terms object is read, and shards are read while it answers", async () => {
    const objects = await goldenRelease();
    const bucket = new MemoryBucket(objects);
    const readsWhenAsked: number[] = [];
    let readsWhenAnswered = 0;
    const gate = new RecordingGate(async () => {
      readsWhenAsked.push(bucket.reads.length);
      await new Promise((resolve) => setTimeout(resolve, 25));
      readsWhenAnswered = bucket.reads.length;
      return okAnswer([]);
    });
    await searchR2Projection(bucket.asR2(), { query: "request manager", limit: 20 }, { gate });
    // Pointer and manifest only: the release must be known, nothing else waits.
    expect(readsWhenAsked).toEqual([2]);
    // The terms object and the first four shards were read before the gate answered.
    expect(readsWhenAnswered).toBe(3 + 4);
  });
});

describe("Spec 016 hybrid search: filters, facets, and what a semantic result shows", () => {
  test("H59: every evidence filter applies to semantic passages as to lexical chunks, and facets count semantic threads once", async () => {
    const objects = await goldenRelease();
    const chunks = chunksOf(objects);
    const t20785 = chunks.find((item) => item.recordId === "kafka:jira:issue:KAFKA-20785")!;
    const t20734 = chunks.find((item) => item.recordId === "kafka:jira:issue:KAFKA-20734")!;
    const datafusion = chunks.find((item) => item.recordId === "datafusion:github:pull:770")!;
    const merged = chunks.find((item) => item.recordId === "kafka:github:pr:23203")!;
    const open = chunks.find((item) => item.recordId === "kafka:github:issue:20970")!;
    const all = [t20785, t20734, datafusion, merged, open];
    const gate = () => new RecordingGate(async () => okAnswer(await Promise.all(all.map((chunk, index) => matchFor(chunk, 0.9 - index / 10)))));
    const search = async (filters?: SearchFiltersV1) =>
      searchR2Projection(new MemoryBucket(objects).asR2(), { query: NO_LEXICAL_MATCH, limit: 20, ...(filters === undefined ? {} : { filters }) }, { gate: gate() });
    const expectRoots = async (filters: SearchFiltersV1 | undefined, expected: readonly (typeof all)[number][]) => {
      const response = await search(filters);
      expect([JSON.stringify(filters), roots(response)]).toEqual([JSON.stringify(filters), expected.map((chunk) => chunk.groupRootRecordId)]);
      return response;
    };

    const unfiltered = await expectRoots(undefined, all);
    expect(facetCounts(unfiltered)).toEqual({ "apache-datafusion": 1, "apache-kafka": 4 });
    // The project filter narrows results, not facets: the same counts with either project selected.
    expect(facetCounts(await expectRoots({ projectIds: ["apache-kafka"] }, [t20785, t20734, merged, open]))).toEqual(facetCounts(unfiltered));
    expect(facetCounts(await expectRoots({ projectIds: ["apache-datafusion"] }, [datafusion]))).toEqual(facetCounts(unfiltered));

    expect(facetCounts(await expectRoots({ sourceInstanceIds: [datafusion.sourceInstanceId] }, [datafusion]))).toEqual({ "apache-datafusion": 1, "apache-kafka": 0 });
    await expectRoots({ sourceInstanceIds: [t20785.sourceInstanceId] }, all.filter((chunk) => chunk.sourceInstanceId === t20785.sourceInstanceId));
    // Strict bounds, as for lexical evidence: a passage at the bound itself is outside.
    await expectRoots({ occurredAfter: t20785.occurredAt }, all.filter((chunk) => Date.parse(chunk.occurredAt) > Date.parse(t20785.occurredAt)));
    await expectRoots({ occurredBefore: t20785.occurredAt }, all.filter((chunk) => Date.parse(chunk.occurredAt) < Date.parse(t20785.occurredAt)));
    await expectRoots({ occurredAfter: new Date(Date.parse(t20785.occurredAt) - 1).toISOString() }, all.filter((chunk) => Date.parse(chunk.occurredAt) >= Date.parse(t20785.occurredAt)));
    await expectRoots({ tags: [...datafusion.tags] }, all.filter((chunk) => datafusion.tags.every((tag) => chunk.tags.includes(tag))));
    // A project status is the group's, read from the release.
    await expectRoots({ projectIds: ["apache-kafka"], projectStatuses: ["merged"] }, [merged]);
    await expectRoots({ projectIds: ["apache-kafka"], projectStatuses: ["open"] }, [open]);
    expect(datafusion.tags.length).toBeGreaterThan(0);

    // A thread lexical retrieval also matched is counted once.
    const { gate: real } = await fakeGate(chunks);
    const txn = await searchR2Projection(new MemoryBucket(objects).asR2(), { query: "txn", limit: 20 }, { gate: real });
    expect(facetCounts(txn)).toEqual({ "apache-datafusion": 0, "apache-kafka": 2 });
    expect(facetCounts(await lexical(objects, { query: "txn", limit: 20 }))).toEqual({ "apache-datafusion": 0, "apache-kafka": 1 });
  });

  test("H60: a thread only semantic retrieval found shows the matched passage from its start, links to its source, and opens its detail", async () => {
    const objects = await goldenRelease();
    const chunks = chunksOf(objects);
    const { gate } = await fakeGate(chunks);
    const bucket = new MemoryBucket(objects).asR2();
    const response = await searchR2Projection(bucket, { query: "交易逾時", limit: 20 }, { gate });
    const result = response.results[0]!;
    const chunk = chunks.find((item) => item.recordId === "kafka:jira:issue:KAFKA-20785")!;

    expect(result.entry).toMatchObject({
      title: chunk.title,
      highlightedRecordIds: [chunk.recordId],
      reason: { kind: "search-match", label: "1 matching source record", query: "交易逾時", matchedRecordIds: [chunk.recordId] },
    });
    expect(result.matches).toEqual([{
      chunkId: chunk.id,
      recordId: chunk.recordId,
      excerpt: chunk.text.length > 280 ? `${chunk.text.slice(0, 280).trim()}…` : chunk.text,
      canonicalUrl: chunk.canonicalUrl,
      author: chunk.author,
      occurredAt: chunk.occurredAt,
      sourceVersion: chunk.sourceVersion,
      matchedTerms: [],
      signals: { exactIdentifier: false, semanticRank: 1, semanticScore: expect.any(Number), fusedRank: 1 },
    }]);
    expect(result.matches[0]!.excerpt.length).toBeGreaterThan(20);
    expect(result.matches[0]!.canonicalUrl).toMatch(/^https:\/\//u);
    const detail = await readSearchDetailProjection(bucket, result.detailRef);
    expect(detail?.entry).toMatchObject({ sourceTitleRecordId: chunk.groupRootRecordId, highlightedRecordIds: [chunk.recordId], reason: { kind: "search-match", query: "交易逾時" } });
    expect(detail?.records.map((record) => record.id)).toContain(chunk.recordId);
  });

  test("H60: a long passage is cut like a lexical excerpt, and a thread shows at most five passages, best first", async () => {
    const objects = await goldenRelease({ maxShardChunks: 1_000 });
    const group = chunksOf(objects).filter((chunk) => chunk.groupRootRecordId === "kafka:mail:dev:release-manager-4-4-0");
    expect(group).toHaveLength(4);
    const long = { ...group[0]!, text: `${"word ".repeat(100)}end` };
    // The reader checks the fingerprint, so the long text has to be what the release holds.
    const rewritten = objects.map((object) => !object.key.includes("/lexical/") ? object : {
      ...object,
      body: object.body.replaceAll(JSON.stringify(group[0]!.text), JSON.stringify(long.text)),
    });
    const stored = chunksOf(rewritten).filter((chunk) => chunk.groupRootRecordId === group[0]!.groupRootRecordId);
    const gate = new RecordingGate(async () => okAnswer(await Promise.all(stored.map((chunk, index) => matchFor(chunk, 0.5 + index / 10)))));
    const response = await searchR2Projection(new MemoryBucket(rewritten).asR2(), { query: NO_LEXICAL_MATCH, limit: 20 }, { gate });
    expect(response.results).toHaveLength(1);
    expect(response.results[0]!.matches.map((match) => match.chunkId)).toEqual([...stored].reverse().map((chunk) => chunk.id));
    const excerpt = response.results[0]!.matches.find((match) => match.chunkId === long.id)!.excerpt;
    expect(excerpt).toBe(`${long.text.slice(0, 280).trim()}…`);
    expect(response.results[0]!.entry.reason).toMatchObject({ label: "4 matching source records" });
  });
});

describe("Spec 016 hybrid search on real records", () => {
  const snapshotPath = new URL("../../../packages/search/test/fixtures/real-corpus-snapshot.v1.json", import.meta.url);
  const queries = [...new Set([...realCorpusRows, ...realCorpusGuardRows].map((row) => row.query))];
  const DIMENSIONS = 256;
  const profile = searchEmbeddingProfile("hashing@1", { model: "hashing", modelRevision: "1", dimensions: DIMENSIONS, textAssemblyRevision: "title-text@1" });
  const embedText = hashingEmbed(DIMENSIONS);

  /** The Spec 017 snapshot (1,134 real chunks of 343 threads) as a release of 100 chunks per shard. */
  async function realRelease(): Promise<readonly ProjectionObject[]> {
    const snapshot = await Bun.file(snapshotPath).json() as { readonly provenance: { readonly indexRevision: string }; readonly chunks: Parameters<typeof searchPublicationFromChunks>[0]["chunks"] };
    const publication = searchPublicationFromChunks({ revision: "real-corpus", indexRevision: snapshot.provenance.indexRevision, chunks: snapshot.chunks }, "release-real", "bm25-reference@3");
    return buildR2SearchProjection(publication, { maxShardChunks: 100, identifiers: searchIdentifierProfiles, shardRoots: true });
  }

  test("H29: on every real-corpus and guard query, hybrid search without semantic candidates is the lexical response", async () => {
    const objects = await realRelease();
    expect(queries.length).toBeGreaterThanOrEqual(27);
    expect(manifestOf(objects).shards.length).toBeGreaterThan(10);
    const failing = new RecordingGate(async () => { throw new Error("down"); });
    const original = console.error;
    console.error = () => undefined;
    try {
      for (const query of queries) {
        const expected = await lexical(objects, { query, limit: 20 });
        expect(expected.results.length).toBeGreaterThan(0);
        for (const options of [{ gate: failing }, { gate: untouchableGate, off: true }, { gate: new RecordingGate(async () => okAnswer([])) }, { unavailable: true }] as const) {
          const response = await searchR2Projection(new MemoryBucket(objects).asR2(), { query, limit: 20 }, options);
          expect(withoutSemantic(response)).toEqual(expected);
        }
      }
    } finally {
      console.error = original;
    }
  });

  test("H58: with a bag-of-words embedder over the real records, every hybrid result is a thread of the release, found by one retriever or both, once", async () => {
    const objects = await realRelease();
    const chunks = chunksOf(objects);
    const manifest = manifestOf(objects);
    const index = new FakeVectorIndex(DIMENSIONS);
    await storeChunkVectors(index, chunks, embedText, profile.semanticRevision);
    const gate = new SemanticQueryGate({
      storage: new MemoryGateStorage(),
      config: () => ({ state: "on", profile, embed: async (texts) => texts.map(embedText), index }),
      neuronsPerMillionTokens: 1_091,
      isRefusal: () => false,
      now: () => new Date("2026-10-12T10:00:00.000Z"),
    });
    const groupRoots = new Set(chunks.map((chunk) => chunk.groupRootRecordId));
    let semanticOnlyResults = 0;
    let reordered = 0;
    for (const query of queries) {
      const bucket = new MemoryBucket(objects);
      const response = await searchR2Projection(bucket.asR2(), { query, limit: 20 }, { gate });
      const expected = await lexical(objects, { query, limit: HYBRID_LEXICAL_DEPTH });
      if (response.retrieval.semantic!.status === "skipped") {
        expect(withoutSemantic(response)).toEqual({ ...expected, results: expected.results.slice(0, 20) });
        continue;
      }
      expect(response.retrieval.semantic).toMatchObject({ status: "ok", cached: false });
      // At most 50 passages from each of the two projects' namespaces enter fusion.
      expect(response.retrieval.semantic!.candidates).toBeGreaterThan(20);
      expect(response.retrieval.semantic!.candidates).toBeLessThanOrEqual(100);
      const lexicalRanks = new Map(roots(expected).map((root, position) => [root, position + 1]));
      expect(new Set(roots(response)).size).toBe(response.results.length);
      for (const result of response.results) {
        const root = result.entry.sourceTitleRecordId;
        const signals = result.matches[0]!.signals;
        expect(groupRoots.has(root)).toBe(true);
        expect(signals.lexicalRank).toBe(lexicalRanks.get(root));
        expect(signals.lexicalRank !== undefined || signals.semanticRank !== undefined).toBe(true);
        expect(result.matches.every((match) => chunks.some((chunk) => chunk.id === match.chunkId && chunk.groupRootRecordId === root))).toBe(true);
        if (signals.lexicalRank === undefined) semanticOnlyResults += 1;
      }
      if (JSON.stringify(roots(response)) !== JSON.stringify(roots(expected).slice(0, 20))) reordered += 1;
      // Exact matches, when a query has any, stay first.
      const exact = response.results.map((result) => result.matches.some((match) => match.signals.exactIdentifier));
      expect(exact.lastIndexOf(true)).toBe(exact.filter(Boolean).length - 1);
      expect(new Set(bucket.reads).size).toBe(bucket.reads.length);
      expect(bucket.reads.length).toBeLessThanOrEqual(3 + manifest.shards.length);
      expect(bucket.peak).toBeLessThanOrEqual(4);
    }
    // Positive control: semantic retrieval changed something on these queries.
    expect(reordered).toBeGreaterThan(10);
    expect(semanticOnlyResults).toBeGreaterThan(0);
  });
});
