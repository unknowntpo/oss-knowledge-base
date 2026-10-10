/**
 * Spec 016 H40: what `bm25-reference@2` adds to a Search release over `@1`, for the same Feed.
 *
 *   bun run measure:search-revisions [--seed <r2-seed directory>]
 *
 * Publishes the version-controlled recorded Feed snapshot (real GitHub records of both projects)
 * at each revision with the community search profiles, exactly as the publisher does, and prints
 * the bytes of `terms.json` and of the lexical shards. `--seed` measures a recorded R2 seed
 * instead (a larger snapshot). Offline; writes nothing.
 */
import { parseArgs } from "node:util";

import { searchIdentifierProfiles } from "@oss-knowledge-base/reference-pipeline/search-profiles";
import { SUPPORTED_LEXICAL_REVISIONS } from "@oss-knowledge-base/search";
import {
  searchGroupsFromFeed,
  searchProjectionObjects,
  type SearchTermsV1,
} from "@oss-knowledge-base/serving-contract";

import { loadRecordedFeedFixture, loadRecordedFeedPublication } from "./load-recorded-feed-publication";

const { values } = parseArgs({ options: { seed: { type: "string" } } });
const recorded = values.seed === undefined ? await loadRecordedFeedFixture() : await loadRecordedFeedPublication(values.seed);

const measured: Record<string, Readonly<Record<string, number>>> = {};
for (const lexicalRevision of SUPPORTED_LEXICAL_REVISIONS) {
  const stream = searchProjectionObjects({
    indexRevision: `feed-${recorded.releaseId}`,
    corpusRevision: `feed:${recorded.releaseId}`,
    generatedAt: recorded.publication.index.generatedAt,
  }, searchGroupsFromFeed(recorded.publication), { lexicalRevision, identifiers: searchIdentifierProfiles });
  const shardBytes: number[] = [];
  let termsBytes = 0;
  let distinctTerms = 0;
  let next = await stream.next();
  for (; !next.done; next = await stream.next()) {
    if (next.value.key.includes("/lexical/")) shardBytes.push(next.value.byteLength);
    if (next.value.key.endsWith("/terms.json")) {
      termsBytes = next.value.byteLength;
      distinctTerms = Object.keys((JSON.parse(new TextDecoder().decode(next.value.body)) as SearchTermsV1).terms).length;
    }
  }
  const { manifest } = next.value;
  measured[lexicalRevision] = {
    groupCount: manifest.groupCount,
    chunkCount: manifest.chunkCount,
    totalChunkLength: manifest.totalChunkLength,
    distinctTerms,
    termsBytes,
    shardCount: shardBytes.length,
    shardBytes: shardBytes.reduce((total, bytes) => total + bytes, 0),
    largestShardBytes: Math.max(0, ...shardBytes),
  };
}

const [before, after] = SUPPORTED_LEXICAL_REVISIONS.map((revision) => measured[revision]!) as [Readonly<Record<string, number>>, Readonly<Record<string, number>>];
const growth = Object.fromEntries(Object.keys(before).map((name) => [
  name,
  before[name] === 0 ? null : `${((after[name]! / before[name]! - 1) * 100).toFixed(1)}%`,
]));

console.log(JSON.stringify({
  source: values.seed ?? "apps/web/test/fixtures/recorded-feed-publication.v1.json",
  releaseId: recorded.releaseId,
  ...measured,
  growth,
}, null, 2));
