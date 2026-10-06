/**
 * Spec 013 ranking-parity test plan: the single source for the tests and for the table in
 * docs/specs/013-search-streaming/spec.md (`bun run docs:test-plan` regenerates it). Each row
 * runs against the golden fixture published as search-release.v3 with `maxShardChunks: 2`
 * (5 shards) and must equal the whole-release (v2) response; `shardsRead` is how many of the
 * 5 shards the query reads, besides the pointer, manifest, and terms object.
 */
export const testPlanRows = [
  { id: "L2", query: "KAFKA-20983", filters: null, limit: 5, shardsRead: 4 },
  { id: "L2", query: "KIP-405", filters: null, limit: 5, shardsRead: 2 },
  { id: "L2", query: "RecordAccumulator.ready()", filters: null, limit: 5, shardsRead: 1 },
  { id: "L2", query: "cleaner rewrite segment in place", filters: null, limit: 3, shardsRead: 4 },
  { id: "L2", query: "issue 20983", filters: "projectIds=apache-datafusion", limit: 1, shardsRead: 3 },
  { id: "L2", query: "issue 20983", filters: "projectIds=apache-datafusion occurredAfter=2026-08-22T00:00:00Z", limit: 10, shardsRead: 3 },
  { id: "L2", query: "remote storage fetch latency compacted topics", filters: null, limit: 3, shardsRead: 2 },
  { id: "L2", query: "RecordAccumulator ready batches Sender", filters: null, limit: 1, shardsRead: 1 },
  { id: "L2", query: "move cold data off broker disks", filters: null, limit: 3, shardsRead: 2 },
  { id: "L2", query: "producer", filters: "projectIds=apache-kafka projectStatuses=merged", limit: 10, shardsRead: 2 },
  { id: "L2", query: "tiered storage", filters: "projectIds=apache-kafka occurredBefore=2022-01-01T00:00:00Z", limit: 10, shardsRead: 2 },
  { id: "L2", query: "optimizer aggregate", filters: "sourceInstanceIds=apache-datafusion-github tags=schema", limit: 10, shardsRead: 2 },
  { id: "L2", query: "the", filters: null, limit: 2, shardsRead: 5 },
  { id: "L3", query: "zzzzqqq", filters: null, limit: 5, shardsRead: 0 },
] as const;

/** Parses the `filters` cell: space-separated `name=value`, repeated names accumulate. */
export function parseFilters(cell: string | null): Record<string, string | string[]> | undefined {
  if (cell === null) return undefined;
  const filters: Record<string, string[]> = {};
  for (const pair of cell.split(" ")) {
    const [name, value] = pair.split("=") as [string, string];
    (filters[name] ??= []).push(value);
  }
  return Object.fromEntries(Object.entries(filters).map(([name, values]) =>
    name.startsWith("occurred") ? [name, values[0]!] : [name, values]));
}
