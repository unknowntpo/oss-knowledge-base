import { describe, expect, test } from "bun:test";
import { hybridSearch, type LexicalSearchResultV1, type SourceRecordChunkV1 } from "@oss-knowledge-base/search";

import { semanticRetrieverContract } from "../../search/test/support/semantic-retriever-contract";
import {
  chunkVectorRef,
  createInMemoryReleaseView,
  searchEmbeddingProfile,
  VectorizeSemanticRetriever,
  type EmbedTexts,
  type SearchEmbeddingProfile,
  type SemanticReleaseView,
} from "../src";
import { FakeVectorIndex, hashingEmbed, storeChunkVectors, testChunk } from "../src/testing";

const DIMENSIONS = 512;
const profile = searchEmbeddingProfile("test@1", { model: "@cf/baai/bge-m3", modelRevision: "1", dimensions: DIMENSIONS, textAssemblyRevision: "title-text@1" });
const embedOne = hashingEmbed(DIMENSIONS);
const embed: EmbedTexts = async (texts) => texts.map(embedOne);

const kafka = (recordId: string, text: string, fields: Partial<SourceRecordChunkV1> = {}) => testChunk({ recordId, text, title: recordId, ...fields });
const fusion = (recordId: string, text: string, fields: Partial<SourceRecordChunkV1> = {}) =>
  testChunk({ recordId, text, title: recordId, projectId: "apache-datafusion", sourceInstanceId: "github:apache/datafusion", ...fields });

const corpus = [
  kafka("kafka:1", "transaction timeout in the coordinator"),
  kafka("kafka:2", "transaction marker written late"),
  kafka("kafka:3", "consumer heartbeat interval"),
  fusion("datafusion:1", "transaction timeout in the planner"),
  fusion("datafusion:2", "parquet page index pruning"),
];

async function setup(
  stored: readonly SourceRecordChunkV1[] = corpus,
  released: readonly SourceRecordChunkV1[] = stored,
  options: { readonly profile?: SearchEmbeddingProfile; readonly embed?: EmbedTexts; readonly release?: SemanticReleaseView } = {},
) {
  const index = new FakeVectorIndex(DIMENSIONS);
  await storeChunkVectors(index, stored, embedOne, profile.semanticRevision);
  index.calls.length = 0;
  const retriever = new VectorizeSemanticRetriever({
    index,
    embed: options.embed ?? embed,
    profile: options.profile ?? profile,
    release: options.release ?? createInMemoryReleaseView("release-1", released),
  });
  return { index, retriever };
}

const records = async (retriever: VectorizeSemanticRetriever, query = "transaction timeout", filters?: Parameters<VectorizeSemanticRetriever["retrieve"]>[0]["filters"]) =>
  (await retriever.retrieve({ query, limit: 10, ...(filters === undefined ? {} : { filters }) })).candidates.map((candidate) => candidate.recordId);

describe("Spec 016 Vectorize semantic retriever", () => {
  test.each([...semanticRetrieverContract])("H24: $name", async ({ run }) => {
    await run(async ({ revision, chunks, embed: embedChunk }) => {
      const contractProfile = searchEmbeddingProfile("contract", revision);
      const index = new FakeVectorIndex(revision.dimensions);
      await storeChunkVectors(index, chunks, embedChunk, contractProfile.semanticRevision);
      return new VectorizeSemanticRetriever({
        index,
        embed: async (texts) => texts.map(embedChunk),
        profile: contractProfile,
        release: createInMemoryReleaseView("contract", chunks),
      });
    });
  });

  test("H24: it queries one namespace per requested project, and every project of the release without a filter", async () => {
    const { index, retriever } = await setup();
    expect(await records(retriever)).toEqual(["datafusion:1", "kafka:1", "kafka:2"]);
    expect(index.calls).toEqual(["query:apache-datafusion:10", "query:apache-kafka:10"]);

    index.calls.length = 0;
    expect(await records(retriever, "transaction timeout", { projectIds: ["apache-kafka"] })).toEqual(["kafka:1", "kafka:2"]);
    expect(index.calls).toEqual(["query:apache-kafka:10"]);

    // Namespaces isolate projects: a project with no vectors answers nothing, and sees no other's.
    index.calls.length = 0;
    expect(await records(retriever, "transaction timeout", { projectIds: ["apache-flink"] })).toEqual([]);
    expect(index.calls).toEqual(["query:apache-flink:10"]);
    expect((await retriever.retrieve({ query: "transaction timeout", limit: 10 })).semanticRevision).toBe(profile.semanticRevision);
  });

  test("H24: the adapter and the search packages name no Cloudflare type", async () => {
    const sources = async (directory: string) => {
      const texts: string[] = [];
      for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: directory, absolute: true })) texts.push(await Bun.file(path).text());
      return texts.join("\n");
    };
    const root = new URL("../..", import.meta.url).pathname;
    const adapter = await sources(`${root}semantic-vectorize/src`);
    expect(adapter).toContain("export class VectorizeSemanticRetriever");
    expect(adapter).not.toContain("@cloudflare");
    expect(adapter).not.toMatch(/\bVectorize(Index|Vector|Matches|QueryOptions|AsyncMutation)\b/u);
    for (const name of ["search", "serving-contract"]) {
      const code = (await sources(`${root}${name}/src`)).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, "");
      expect(code).not.toMatch(/vectorize/iu);
      expect(await Bun.file(`${root}${name}/package.json`).text()).not.toContain("semantic-vectorize");
    }
  });

  test("H44: a candidate is the release's own chunk, found by project, record and ordinal", async () => {
    // The release holds a later source version of every record: new chunk ids, same passages.
    const released = corpus.map((chunk) => ({ ...chunk, id: `${chunk.id}:later`, sourceVersion: "v9" }));
    const { retriever } = await setup(corpus, released);
    const { candidates } = await retriever.retrieve({ query: "transaction timeout", limit: 10, filters: { projectIds: ["apache-kafka"] } });
    expect(candidates.map((candidate) => candidate.chunkId)).toEqual(["chunk:kafka:1:0:v1:later", "chunk:kafka:2:0:v1:later"]);
    expect(candidates[0]).toEqual({
      chunkId: "chunk:kafka:1:0:v1:later",
      recordId: "kafka:1",
      groupRootRecordId: "kafka:1",
      projectId: "apache-kafka",
      score: candidates[0]!.score,
    });
    expect(candidates[0]!.score).toBeGreaterThan(candidates[1]!.score);
  });

  test.each([
    ["its text changed", (chunk: SourceRecordChunkV1) => ({ ...chunk, text: "transaction timeout in the group coordinator" })],
    ["its title changed", (chunk: SourceRecordChunkV1) => ({ ...chunk, title: "renamed" })],
    ["it moved to another group", (chunk: SourceRecordChunkV1) => ({ ...chunk, groupRootRecordId: "kafka:2" })],
    ["it left the release", () => undefined],
    ["only another ordinal of the record remains", (chunk: SourceRecordChunkV1) => ({ ...chunk, ordinal: 1 })],
  ])("H44: a vector is dropped when %s, and the other candidates stay", async (_name, change) => {
    const released = corpus.flatMap((chunk) => {
      if (chunk.recordId !== "kafka:1") return [chunk];
      const changed = change(chunk);
      return changed === undefined ? [] : [changed];
    });
    const { retriever } = await setup(corpus, released);
    expect(await records(retriever)).toEqual(["datafusion:1", "kafka:2"]);
    // Positive control: with the release the vectors were made from, kafka:1 is a candidate.
    expect(await records((await setup(corpus, corpus)).retriever)).toEqual(["datafusion:1", "kafka:1", "kafka:2"]);
  });

  test("H44: after a rollback, unchanged passages keep their candidates and newer vectors are dropped", async () => {
    const older = corpus;
    const newer = corpus.map((chunk) => chunk.recordId === "kafka:2" ? { ...chunk, text: "transaction marker written much later", sourceVersion: "v2", id: "chunk:kafka:2:new" } : chunk);
    // The index was last reconciled with the newer release.
    const serve = async (released: readonly SourceRecordChunkV1[]) => records((await setup(newer, released)).retriever, "transaction");
    expect(await serve(newer)).toEqual(["datafusion:1", "kafka:1", "kafka:2"]);
    expect(await serve(older)).toEqual(["datafusion:1", "kafka:1"]);
  });

  test("H44: a vector in another project's namespace, with malformed metadata, or answered by a lying release view is dropped", async () => {
    const { index, retriever } = await setup();
    const stray = await chunkVectorRef(corpus[0]!);
    // The same passage stored under the wrong namespace, and a vector whose metadata is not ours.
    await index.upsert([
      { id: "stray", namespace: "apache-datafusion", values: embedOne("transaction timeout"), metadata: { r: profile.semanticRevision, h: stray.fingerprint, record: "kafka:1", ord: 0, root: "kafka:1" } },
      { id: "foreign", namespace: "apache-kafka", values: embedOne("transaction timeout"), metadata: { title: "someone else's vector" } },
      { id: "bare", namespace: "apache-kafka", values: embedOne("transaction timeout") },
    ]);
    expect(await records(retriever)).toEqual(["datafusion:1", "kafka:1", "kafka:2"]);

    // A view that answers with some other chunk cannot put it in the results.
    const lying: SemanticReleaseView = { indexRevision: "x", projectIds: ["apache-kafka"], chunks: async (refs) => refs.map(() => corpus[2]!) };
    expect(await records((await setup(corpus, corpus, { release: lying })).retriever)).toEqual([]);
  });

  test("H22: a vector of another semantic revision is never a candidate, while a mixed index is re-embedded", async () => {
    const next = searchEmbeddingProfile("test@2", { ...profile.revision, modelRevision: "2" });
    const index = new FakeVectorIndex(DIMENSIONS);
    await storeChunkVectors(index, corpus, embedOne, profile.semanticRevision);
    // Half way through the change: kafka:1 already carries the new revision.
    await storeChunkVectors(index, [corpus[0]!], embedOne, next.semanticRevision);
    const view = createInMemoryReleaseView("release-1", corpus);
    const at = (served: SearchEmbeddingProfile) => new VectorizeSemanticRetriever({ index, embed, profile: served, release: view });
    expect(index.vectors.size).toBe(corpus.length);
    expect(await records(at(next))).toEqual(["kafka:1"]);
    expect(await records(at(profile))).toEqual(["datafusion:1", "kafka:2"]);
    expect((await at(next).retrieve({ query: "transaction timeout", limit: 10 })).semanticRevision).toBe("@cf/baai/bge-m3@2:512:title-text@1");
  });

  test("H24: it applies the evidence filters to the release's chunk and keeps the best score per chunk", async () => {
    const released = corpus.map((chunk) => chunk.recordId === "kafka:2"
      ? { ...chunk, occurredAt: "2026-10-05T00:00:00.000Z", tags: ["bug"], sourceInstanceId: "jira:KAFKA" }
      : chunk);
    // Fingerprints ignore these fields, so the stored vectors still match.
    const { retriever } = await setup(corpus, released);
    expect(await records(retriever, "transaction", { occurredAfter: "2026-10-03T00:00:00.000Z" })).toEqual(["kafka:2"]);
    expect(await records(retriever, "transaction", { tags: ["bug"] })).toEqual(["kafka:2"]);
    expect(await records(retriever, "transaction", { sourceInstanceIds: ["github:apache/datafusion"] })).toEqual(["datafusion:1"]);
    expect(await records(retriever, "transaction", { occurredBefore: "2026-10-03T00:00:00.000Z" })).toEqual(["datafusion:1", "kafka:1"]);
    expect(await records(retriever, "nothing shared with any chunk")).toEqual([]);
    expect((await retriever.retrieve({ query: "transaction", limit: 2 })).candidates).toHaveLength(2);
  });
});

describe("Spec 016 Vectorize retriever failures", () => {
  const lexical: LexicalSearchResultV1[] = [];
  const hybrid = (retriever: VectorizeSemanticRetriever, timeoutMs = 1_000) =>
    hybridSearch({ query: "transaction timeout", lexical, semantic: retriever, timeoutMs });

  test.each([
    ["the query embedding fails", { embed: (async () => { throw new Error("AiError: 3040: capacity"); }) as EmbedTexts }, "3040: capacity"],
    ["the gateway answers 429", { embed: (async () => { throw new Error("429 Too Many Requests"); }) as EmbedTexts }, "429 Too Many Requests"],
    ["the embedding has the wrong dimension", { embed: (async () => [[1, 2, 3]]) as EmbedTexts }, "Embedding has 3 dimensions, expected 512"],
    ["the model returns no vector", { embed: (async () => []) as EmbedTexts }, "did not return one vector"],
    ["the model returns two vectors", { embed: (async () => [embedOne("a"), embedOne("b")]) as EmbedTexts }, "did not return one vector"],
  ])("H50: when %s the retriever rejects and hybrid search answers lexically", async (_name, options, error) => {
    const { index, retriever } = await setup(corpus, corpus, options);
    await expect(retriever.retrieve({ query: "transaction timeout", limit: 10 })).rejects.toThrow(error);
    expect(index.calls).toEqual([]);
    const answer = await hybrid(retriever);
    expect(answer.retrieval).toEqual({ fusionRevision: "rrf-group@1", semantic: "failed", semanticError: expect.stringContaining(error) });
    expect(answer.results).toEqual([]);
    // Positive control: the same index with a working embedder is hybrid.
    expect((await hybrid((await setup()).retriever)).retrieval).toMatchObject({ semantic: "ok", semanticRevision: profile.semanticRevision });
  });

  test("H50: an index query or a release read that fails rejects, and hybrid search answers lexically", async () => {
    const { index, retriever } = await setup();
    index.fail = (operation, call) => (operation === "query" && call === 1 ? new Error("VECTOR_QUERY_ERROR (code = 40006)") : undefined);
    await expect(retriever.retrieve({ query: "transaction timeout", limit: 10 })).rejects.toThrow("VECTOR_QUERY_ERROR");
    index.fail = (operation) => (operation === "query" ? new Error("VECTOR_QUERY_ERROR (code = 40006)") : undefined);
    expect((await hybrid(retriever)).retrieval).toMatchObject({ semantic: "failed", semanticError: expect.stringContaining("VECTOR_QUERY_ERROR") });

    const broken: SemanticReleaseView = { indexRevision: "x", projectIds: ["apache-kafka"], chunks: async () => { throw new Error("shard read failed"); } };
    await expect((await setup(corpus, corpus, { release: broken })).retriever.retrieve({ query: "transaction timeout", limit: 10 })).rejects.toThrow("shard read failed");
  });

  test("H50: a query embedding that never answers times out, the signal is aborted, and the retriever rejects", async () => {
    let seen: AbortSignal | undefined;
    const hanging: EmbedTexts = (_texts, signal) => {
      seen = signal;
      return new Promise(() => undefined);
    };
    const { retriever } = await setup(corpus, corpus, { embed: hanging });
    const answer = await hybrid(retriever, 20);
    expect(answer.retrieval).toEqual({ fusionRevision: "rrf-group@1", semantic: "timed-out" });
    expect(seen?.aborted).toBe(true);

    const controller = new AbortController();
    const pending = retriever.retrieve({ query: "transaction timeout", limit: 10, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("Semantic retrieval was aborted");
    // An already aborted request does not start.
    await expect((await setup()).retriever.retrieve({ query: "q", limit: 10, signal: controller.signal })).rejects.toThrow("aborted");
    // Positive control: an unaborted signal changes nothing.
    expect(await (await setup()).retriever.retrieve({ query: "transaction timeout", limit: 10, signal: new AbortController().signal }))
      .toEqual(await (await setup()).retriever.retrieve({ query: "transaction timeout", limit: 10 }));
  });

  test("H50: a limit above 50 asks each namespace for 50, the most Vectorize returns with metadata", async () => {
    const many = Array.from({ length: 60 }, (_, n) => kafka(`kafka:many:${String(n).padStart(2, "0")}`, "transaction timeout"));
    const { index, retriever } = await setup(many);
    const { candidates } = await retriever.retrieve({ query: "transaction timeout", limit: 100 });
    expect(index.calls).toEqual(["query:apache-kafka:50"]);
    expect(candidates).toHaveLength(50);
    index.calls.length = 0;
    expect((await retriever.retrieve({ query: "transaction timeout", limit: 7 })).candidates).toHaveLength(7);
    expect(index.calls).toEqual(["query:apache-kafka:7"]);
    for (const limit of [0, -1, 1.5]) await expect(retriever.retrieve({ query: "q", limit })).rejects.toThrow("positive integer");
  });
});
