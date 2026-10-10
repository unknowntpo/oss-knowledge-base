import { describe, expect, test } from "bun:test";

import {
  chunkFingerprint,
  chunkVectorRef,
  embeddingVectors,
  parseVectorMetadata,
  resolveSearchEmbedding,
  searchEmbeddingProfile,
  SUPPORTED_SEARCH_EMBEDDINGS,
  VECTOR_LIMITS,
  vectorId,
  vectorNamespace,
  vectorRecord,
  workersAiEmbedder,
} from "../src";
import { FakeVectorIndex, testChunk } from "../src/testing";

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

describe("Spec 016 vector identity and metadata", () => {
  test.each([
    ["a short id", "kafka:github:pull:22747"],
    ["a 2,000-character id", `kafka:mail:dev:${"x".repeat(2_000)}`],
    ["a non-ASCII id", "kafka:mail:dev:交易逾時-ünïcödé-🚀"],
    ["an empty id", ""],
  ])("H43: the vector id of %s is 48 hex characters, within the 64-byte limit", async (_name, recordId) => {
    const id = await vectorId("apache-kafka", recordId, 0);
    expect(id).toMatch(/^[0-9a-f]{48}$/u);
    expect(bytes(id)).toBeLessThanOrEqual(VECTOR_LIMITS.idBytes);
    // A chunk id is longer than the store accepts, which is why it is not the vector id.
    expect(bytes(`chunk:sha256:${"0".repeat(64)}`)).toBeGreaterThan(VECTOR_LIMITS.idBytes);
    expect(await vectorId("apache-kafka", recordId, 0)).toBe(id);
  });

  test("H43: the vector id differs by project, record, and ordinal, and by nothing else", async () => {
    const base = await vectorId("apache-kafka", "record", 0);
    const others = await Promise.all([
      vectorId("apache-datafusion", "record", 0),
      vectorId("apache-kafka", "record2", 0),
      vectorId("apache-kafka", "record", 1),
      // The separator keeps `("a", "b:c")` apart from `("a:b", "c")`.
      vectorId("apache-kafka\u0000record", "", 0),
    ]);
    expect(new Set([base, ...others]).size).toBe(5);
    const chunk = testChunk({ recordId: "record" });
    const later = testChunk({ recordId: "record", sourceVersion: "v2", occurredAt: "2026-10-09T00:00:00.000Z", author: "someone else" });
    expect(later.id).not.toBe(chunk.id);
    expect(await chunkVectorRef(later)).toEqual(await chunkVectorRef(chunk));
    expect((await chunkVectorRef(chunk)).id).toBe(base);
    expect((await chunkVectorRef(chunk)).namespace).toBe("apache-kafka");
  });

  test("H43: the fingerprint follows the title, the text, and the group, and nothing else", async () => {
    const chunk = testChunk({ recordId: "record" });
    const fingerprint = await chunkFingerprint(chunk);
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/u);
    expect(await chunkFingerprint({ ...chunk, sourceVersion: "v2", id: "other", author: "other", tags: ["x"], canonicalUrl: "https://example.org/other" })).toBe(fingerprint);
    for (const changed of [{ title: "Another title" }, { text: "Another text" }, { groupRootRecordId: "another-root" }]) {
      expect(await chunkFingerprint({ ...chunk, ...changed })).not.toBe(fingerprint);
    }
    // Title and text are one embedded string: moving a word across the boundary is a change.
    expect(await chunkFingerprint({ ...chunk, title: "a", text: "b c" })).not.toBe(await chunkFingerprint({ ...chunk, title: "a b", text: "c" }));
  });

  test("H43: a vector carries only r, h, record, ord and root, and metadata over 10 KiB is refused", async () => {
    const chunk = testChunk({ recordId: "kafka:github:pull:22747", ordinal: 2, groupRootRecordId: "kafka:jira:issue:KAFKA-20765" });
    const ref = await chunkVectorRef(chunk);
    const record = vectorRecord(ref, chunk, [1, 2, 3], "@cf/baai/bge-m3@1:1024:title-text@1");
    expect(record).toEqual({
      id: ref.id,
      namespace: "apache-kafka",
      values: [1, 2, 3],
      metadata: { r: "@cf/baai/bge-m3@1:1024:title-text@1", h: ref.fingerprint, record: "kafka:github:pull:22747", ord: 2, root: "kafka:jira:issue:KAFKA-20765" },
    });
    expect(parseVectorMetadata(record.metadata)).toEqual(record.metadata);
    expect(bytes(JSON.stringify(record.metadata))).toBeLessThan(VECTOR_LIMITS.metadataBytes);

    const huge = testChunk({ recordId: "r".repeat(VECTOR_LIMITS.metadataBytes) });
    expect(() => vectorRecord(ref, huge, [1], "rev")).toThrow("over 10240");
    // Just under the limit is stored.
    const fits = testChunk({ recordId: "r".repeat(4_000), groupRootRecordId: "g".repeat(4_000) });
    expect(vectorRecord(ref, fits, [1], "rev").metadata.record).toHaveLength(4_000);
  });

  test.each([
    ["no object", null],
    ["a missing field", { r: "rev", h: "hash", record: "record", ord: 0 }],
    ["a fractional ordinal", { r: "rev", h: "hash", record: "record", ord: 0.5, root: "root" }],
    ["a negative ordinal", { r: "rev", h: "hash", record: "record", ord: -1, root: "root" }],
    ["a numeric record", { r: "rev", h: "hash", record: 7, ord: 0, root: "root" }],
  ])("H44: metadata with %s is not a vector of this adapter", (_name, value) => {
    expect(parseVectorMetadata(value)).toBeUndefined();
    expect(parseVectorMetadata({ r: "rev", h: "hash", record: "record", ord: 0, root: "root", extra: 1 }))
      .toEqual({ r: "rev", h: "hash", record: "record", ord: 0, root: "root" });
  });

  test("H43: a project id is a namespace only within 64 bytes", () => {
    expect(vectorNamespace("apache-kafka")).toBe("apache-kafka");
    expect(vectorNamespace("p".repeat(64))).toHaveLength(64);
    expect(() => vectorNamespace("p".repeat(65))).toThrow("not a valid vector namespace");
    expect(() => vectorNamespace("專".repeat(22))).toThrow("not a valid vector namespace");
    expect(() => vectorNamespace("")).toThrow("not a valid vector namespace");
  });

  test("H43: the fake index refuses what Vectorize refuses", async () => {
    const index = new FakeVectorIndex(2);
    const vector = { id: "a".repeat(64), values: [1, 0], namespace: "n".repeat(64), metadata: { record: "x".repeat(10_000) } };
    expect((await index.upsert([vector])).mutationId).toBe("mutation-1");
    await expect(index.upsert([{ ...vector, id: "a".repeat(65) }])).rejects.toThrow("vector id is not 1–64 bytes");
    await expect(index.upsert([{ ...vector, namespace: "n".repeat(65) }])).rejects.toThrow("namespace is over 64 bytes");
    await expect(index.upsert([{ ...vector, metadata: { record: "x".repeat(10_240) } }])).rejects.toThrow("metadata is over 10240 bytes");
    await expect(index.upsert([{ ...vector, values: [1, 0, 0] }])).rejects.toThrow("3 dimensions, index has 2");
    await expect(index.upsert(Array.from({ length: 1_001 }, (_, n) => ({ ...vector, id: `v${n}` })))).rejects.toThrow("outside 1–1000");
    expect((await index.upsert(Array.from({ length: 1_000 }, (_, n) => ({ ...vector, id: `v${n}` })))).mutationId).toBe("mutation-2");
    const query = { namespace: vector.namespace, returnMetadata: "all", returnValues: false } as const;
    expect((await index.query([1, 0], { ...query, topK: 50 })).matches).toHaveLength(50);
    await expect(index.query([1, 0], { ...query, topK: 51 })).rejects.toThrow("topK 51 is outside 1–50");
    await expect(index.query([1, 0, 0], { ...query, topK: 1 })).rejects.toThrow("query has 3 dimensions");
    // Nothing a refused call carried was stored.
    expect(index.vectors.size).toBe(1_001);
  });
});

describe("Spec 016 embedding profile and model call", () => {
  test("H45: SEARCH_EMBEDDING blank is off, bge-m3@1 is the decided profile, anything else throws", () => {
    for (const blank of [undefined, "", "   "]) expect(resolveSearchEmbedding(blank)).toBeUndefined();
    expect(SUPPORTED_SEARCH_EMBEDDINGS).toEqual(["bge-m3@1"]);
    expect(resolveSearchEmbedding(" bge-m3@1 ")).toEqual({
      key: "bge-m3@1",
      revision: { model: "@cf/baai/bge-m3", modelRevision: "1", dimensions: 1_024, textAssemblyRevision: "title-text@1" },
      semanticRevision: "@cf/baai/bge-m3@1:1024:title-text@1",
    });
    for (const value of ["true", "on", "bge-m3", "bge-m3@2", "@cf/baai/bge-m3", "toString"]) {
      expect(() => resolveSearchEmbedding(value)).toThrow(`SEARCH_EMBEDDING "${value}" is not a supported embedding profile (bge-m3@1)`);
    }
  });

  test("H22: any field of the revision changes the semantic revision id", () => {
    const revision = resolveSearchEmbedding("bge-m3@1")!.revision;
    const ids = [revision, { ...revision, model: "@cf/baai/bge-large" }, { ...revision, modelRevision: "2" }, { ...revision, dimensions: 512 }, { ...revision, textAssemblyRevision: "title-text@2" }]
      .map((changed) => searchEmbeddingProfile("x", changed).semanticRevision);
    expect(new Set(ids).size).toBe(5);
    expect(() => searchEmbeddingProfile("x", { ...revision, dimensions: 0 })).toThrow("positive integer");
  });

  test("H21: the model is called once per batch through the named gateway, with the texts in order", async () => {
    const calls: unknown[][] = [];
    const profile = searchEmbeddingProfile("test@1", { model: "@cf/baai/bge-m3", modelRevision: "1", dimensions: 2, textAssemblyRevision: "title-text@1" });
    const ai = { run: async (...args: unknown[]) => { calls.push(args); return { shape: [2, 2], data: [[1, 0], [0, 1]], pooling: "cls" }; } };
    const signal = new AbortController().signal;
    expect(await workersAiEmbedder(ai, "osskb-search-dev", profile, { skipCache: true })(["first", "second"], signal)).toEqual([[1, 0], [0, 1]]);
    expect(calls).toEqual([["@cf/baai/bge-m3", { text: ["first", "second"], truncate_inputs: true }, { gateway: { id: "osskb-search-dev", skipCache: true }, signal }]]);
    await workersAiEmbedder(ai, "osskb-search-dev", profile)(["first", "second"]);
    expect(calls[1]![2]).toEqual({ gateway: { id: "osskb-search-dev" } });
    expect(() => workersAiEmbedder(ai, " ", profile)).toThrow("AI Gateway id is required");
  });

  test.each([
    ["no data", { response: [[1, 0]] }, "no data array"],
    ["null", null, "no data array"],
    ["one vector too few", { data: [[1, 0]] }, "has 1 vectors, expected 2"],
    ["one vector too many", { data: [[1, 0], [0, 1], [1, 1]] }, "has 3 vectors, expected 2"],
    ["a short vector", { data: [[1, 0], [1]] }, "has 1 dimensions, expected 2"],
    ["a vector that is no array", { data: [[1, 0], "x"] }, "has 0 dimensions, expected 2"],
    ["a NaN", { data: [[1, 0], [Number.NaN, 1]] }, "not a finite number"],
    ["a string value", { data: [[1, 0], ["1", 1]] }, "not a finite number"],
  ])("H48: an embedding response with %s is refused", (_name, response, error) => {
    expect(() => embeddingVectors(response, 2, 2)).toThrow(error);
    expect(embeddingVectors({ data: [[1, 0], [0.5, -1]] }, 2, 2)).toEqual([[1, 0], [0.5, -1]]);
  });
});
