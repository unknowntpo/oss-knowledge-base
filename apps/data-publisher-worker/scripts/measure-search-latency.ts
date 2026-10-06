/**
 * Spec 013 Q-budget: local `/api/search` latency, R2 reads, and bytes read per query against a
 * Search release published from seeded events, using the Pages Function reader unchanged.
 *
 *   bun run measure:search-latency [--events 8600,17200] [--seed 9] [--iterations 7]
 *
 * Runs under Bun with an in-memory R2 stand-in, so it measures parse and ranking work, not
 * network time; Dev latency is measured separately after deployment.
 */
import { parseArgs } from "node:util";

import { defaultReferenceConfig, materializeReferenceFeed } from "@oss-knowledge-base/reference-pipeline";
import { searchGroupsFromFeed, searchProjectionObjects } from "@oss-knowledge-base/serving-contract";

import { searchR2Projection } from "../../web/functions/_shared/search-projection";
import { generateSeededGitHubEvents } from "./seeded-github-events";

const MATERIALIZED_AT = "2026-10-02T01:42:16.361Z";
const QUERIES = [
  { query: "transaction", limit: 20 },
  { query: "consumer rebalance timeout", limit: 20 },
  { query: "partition", filters: { projectIds: ["apache-kafka"] }, limit: 20 },
  // Worst case: common words that select every shard (the "R2 gets" column shows 3 + shards).
  { query: "issue pull request", limit: 20 },
] as const;

const { values } = parseArgs({
  options: {
    events: { type: "string", default: "8600,17200" },
    seed: { type: "string", default: "9" },
    iterations: { type: "string", default: "21" },
  },
});

for (const count of values.events.split(",").map(Number)) {
  const objects = await publishSearch(count, Number(values.seed));
  const stats = { gets: 0, bytes: 0 };
  const bucket = {
    get: async (key: string) => {
      const body = objects.get(key);
      if (body === undefined) return null;
      stats.gets += 1;
      stats.bytes += body.byteLength;
      return {
        json: async <T>() => JSON.parse(new TextDecoder().decode(body)) as T,
        text: async () => new TextDecoder().decode(body),
        arrayBuffer: async () => body.slice().buffer,
      };
    },
  } as unknown as R2Bucket;

  const rows = [];
  for (const request of QUERIES) {
    await searchR2Projection(bucket, request);
    const samples: number[] = [];
    let reads = { gets: 0, bytes: 0 };
    for (let iteration = 0; iteration < Number(values.iterations); iteration += 1) {
      stats.gets = 0;
      stats.bytes = 0;
      const startedAt = performance.now();
      const response = await searchR2Projection(bucket, request);
      samples.push(performance.now() - startedAt);
      reads = { ...stats };
      if (iteration === 0) rows.push({ query: request.query, results: response.results.length });
    }
    samples.sort((left, right) => left - right);
    Object.assign(rows.at(-1)!, {
      "p50 ms": Number(samples[Math.floor(samples.length / 2)]!.toFixed(1)),
      "p95 ms": Number(samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]!.toFixed(1)),
      "max ms": Number(samples.at(-1)!.toFixed(1)),
      "R2 gets": reads.gets,
      "MB read": Number((reads.bytes / 1_048_576).toFixed(2)),
    });
  }
  const lexical = [...objects].filter(([key]) => key.includes("/lexical/"));
  const terms = [...objects].find(([key]) => key.endsWith("/terms.json"))?.[1];
  const manifest = [...objects].find(([key]) => key.endsWith("/manifest.json"))![1];
  console.log(`\n${count} events: ${lexical.length} lexical shards, ` +
    `terms ${((terms?.byteLength ?? 0) / 1_048_576).toFixed(2)} MB, manifest ${(manifest.byteLength / 1_048_576).toFixed(2)} MB, ` +
    `largest ${(Math.max(...lexical.map(([, body]) => body.byteLength)) / 1_048_576).toFixed(2)} MB, ` +
    `total ${(lexical.reduce((total, [, body]) => total + body.byteLength, 0) / 1_048_576).toFixed(2)} MB`);
  console.table(rows);
}

/** Publishes only the Search release, keeping its bytes in memory. */
async function publishSearch(count: number, seed: number): Promise<Map<string, Uint8Array>> {
  const config = defaultReferenceConfig(MATERIALIZED_AT);
  const events = generateSeededGitHubEvents({ count, seed, materializedAt: MATERIALIZED_AT });
  const feed = materializeReferenceFeed(events, config).publication;
  const objects = new Map<string, Uint8Array>();
  const stream = searchProjectionObjects(
    { indexRevision: "measure", corpusRevision: "measure", generatedAt: MATERIALIZED_AT },
    searchGroupsFromFeed(feed),
  );
  let next = await stream.next();
  for (; !next.done; next = await stream.next()) objects.set(next.value.key, next.value.body);
  const { descriptor } = next.value;
  objects.set(descriptor.currentKey, new TextEncoder().encode(JSON.stringify(descriptor.current)));
  return objects;
}
