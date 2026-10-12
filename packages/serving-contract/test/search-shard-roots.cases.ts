/**
 * Spec 016 slice 3 shard-root test plan: the single source for the tests in
 * `search-shards.test.ts` and for the table in docs/specs/016-semantic-search/spec.md (`bun run
 * docs:test-plan` regenerates it). Each row publishes `groups` (`project/groupRoot:chunks`, in the
 * publisher's order) with shard roots. `roots` lists `shard project firstGroupRoot` as the manifest
 * declares them; `lookups` lists `project/groupRoot=shard` for `searchShardForGroupRoot`, where
 * `none` means the release cannot hold that group.
 */
export const testPlanRows = [
  { id: "H57", case: "one shard: its first root, a root between two groups, and one past the last", maxShardChunks: 4, groups: "kafka/b:1 kafka/d:1", roots: "0 kafka b", lookups: "kafka/b=0 kafka/c=0 kafka/d=0 kafka/z=0" },
  { id: "H57", case: "a root before the project's first, and another project", maxShardChunks: 4, groups: "kafka/b:1 kafka/d:1", roots: "0 kafka b", lookups: "kafka/a=none datafusion/b=none" },
  { id: "H57", case: "each side of a shard boundary", maxShardChunks: 4, groups: "kafka/b:2 kafka/d:2 kafka/f:2", roots: "0 kafka b; 1 kafka f", lookups: "kafka/d=0 kafka/e=0 kafka/f=1 kafka/g=1" },
  { id: "H57", case: "two projects: a root is looked up among its own project's shards", maxShardChunks: 4, groups: "datafusion/m:1 kafka/c:1", roots: "0 datafusion m; 1 kafka c", lookups: "datafusion/m=0 datafusion/z=0 datafusion/a=none kafka/c=1 kafka/a=none kafka/n=1" },
  { id: "H57", case: "a group larger than the limit, alone in its shard", maxShardChunks: 4, groups: "kafka/a:1 kafka/b:5 kafka/c:1", roots: "0 kafka a; 1 kafka b; 2 kafka c", lookups: "kafka/a=0 kafka/b=1 kafka/bb=1 kafka/c=2" },
  { id: "H57", case: "the publisher's order, not code-point order: a < A < B < b10 < b2 < b9", maxShardChunks: 4, groups: "kafka/a:2 kafka/B:2 kafka/b10:2 kafka/b9:2", roots: "0 kafka a; 1 kafka b10", lookups: "kafka/A=0 kafka/B=0 kafka/b1=0 kafka/b10=1 kafka/b2=1 kafka/b9=1" },
  { id: "H57", case: "no groups", maxShardChunks: 4, groups: "", roots: "", lookups: "kafka/a=none" },
] as const;
