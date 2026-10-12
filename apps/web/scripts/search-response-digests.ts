/**
 * Spec 016 H28: the bytes `/api/search` answers with, as digests, for a fixed set of requests
 * over golden v2 published at `bm25-reference@3` (2 chunks per shard). The committed fixture
 * `test/fixtures/search-responses.lexical.json` was written by this script on origin/main
 * fb70705, before hybrid search existed; `search-hybrid.test.ts` recomputes the digests with the
 * flag off and compares. It uses only what that commit has, so it runs there unchanged:
 *
 *   bun apps/web/scripts/search-response-digests.ts [--write <file>]
 */
import { searchIdentifierProfiles } from "@oss-knowledge-base/reference-pipeline/search-profiles";
import { buildR2SearchProjection, type ProjectionObject } from "@oss-knowledge-base/serving-contract";

import { onRequestGet } from "../functions/api/search";
import { buildGoldenV2SearchPublication } from "./build-search-fixture";

const goldenV2Path = new URL("../../../packages/search/test/fixtures/golden-queries.v2.json", import.meta.url).pathname;

const QUERIES = [
  "KAFKA-20983", "KIP-405", "RecordAccumulator.ready()", "cleaner rewrite segment in place", "issue 20983",
  "remote storage fetch latency compacted topics", "RecordAccumulator ready batches Sender", "move cold data off broker disks",
  "consumer network thread request manager", "RequestManager", "request manager", "KIP-770", "KIP770", "770", "txn", "交易逾時",
  "transaction timeout", "release manager", "the", "zzzzqqq", "a",
];

/** Every query alone, then filters, limits, an ignored parameter, and two errors. */
export const DIGEST_REQUESTS: readonly string[] = [
  ...QUERIES.map((query) => `q=${encodeURIComponent(query)}`),
  "q=request+manager&limit=1",
  "q=request+manager&limit=3",
  "q=request+manager&limit=50",
  "q=issue+20983&projectId=apache-datafusion",
  "q=770&projectId=apache-kafka",
  "q=producer&projectId=apache-kafka&projectStatus=merged",
  "q=tiered+storage&projectId=apache-kafka&occurredBefore=2022-01-01T00:00:00Z",
  "q=issue+20983&projectId=apache-datafusion&occurredAfter=2026-08-22T00:00:00Z",
  "q=optimizer+aggregate&sourceInstanceId=apache-datafusion-github&tag=schema",
  "q=transaction+timeout&projectId=apache-kafka&projectId=apache-datafusion",
  "q=transaction+timeout&semantic=off",
  "q=%E4%BA%A4%E6%98%93%E9%80%BE%E6%99%82&semantic=off",
  "q=",
  "q=request+manager&limit=51",
];

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function lexicalGoldenRelease(): Promise<readonly ProjectionObject[]> {
  const publication = await buildGoldenV2SearchPublication(goldenV2Path, "release-digests", "bm25-reference@3");
  return buildR2SearchProjection(publication, { maxShardChunks: 2, identifiers: searchIdentifierProfiles });
}

/** `status sha256(body)` per request, served by the handler from `objects` with `env` added to the bucket. */
export async function responseDigests(objects: readonly ProjectionObject[], env: Readonly<Record<string, unknown>> = {}): Promise<Readonly<Record<string, string>>> {
  const values = new Map(objects.map((object) => [object.key, object.body]));
  const bucket = { get: async (key: string) => (values.has(key) ? { json: async () => JSON.parse(values.get(key)!) } : null) };
  const digests: Record<string, string> = {};
  for (const request of DIGEST_REQUESTS) {
    const response = await onRequestGet({
      request: new Request(`https://digest.example/api/search?${request}`),
      env: { OSS_KB_BUCKET: bucket, ...env },
    } as unknown as Parameters<typeof onRequestGet>[0]);
    digests[request] = `${response.status} ${await sha256(await response.text())}`;
  }
  return digests;
}

if (import.meta.main) {
  const digests = await responseDigests(await lexicalGoldenRelease());
  const body = `${JSON.stringify({ note: "Written by apps/web/scripts/search-response-digests.ts on origin/main fb70705 (before Spec 016 slice 3).", digests }, null, 2)}\n`;
  const write = process.argv.indexOf("--write");
  if (write >= 0) await Bun.write(process.argv[write + 1]!, body);
  else process.stdout.write(body);
}
