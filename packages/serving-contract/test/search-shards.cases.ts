/**
 * Spec 013 shard-layout test plan: the single source for the unit tests and for the table in
 * docs/specs/013-search-streaming/spec.md (`bun run docs:test-plan` regenerates it).
 * `groups`: `project/groupRoot:chunks`, in the order the publisher receives them (by project, then root). `shards`: `index project [groupRoots]`.
 */
export const testPlanRows = [
  { id: "L1", case: "groups fill a shard exactly", maxShardChunks: 4, groups: "kafka/a:2 kafka/b:2", shards: "0 kafka [a b]" },
  { id: "L1", case: "one chunk over the limit starts a shard", maxShardChunks: 4, groups: "kafka/a:2 kafka/b:3", shards: "0 kafka [a]; 1 kafka [b]" },
  { id: "L1", case: "one chunk under the limit stays", maxShardChunks: 4, groups: "kafka/a:1 kafka/b:2", shards: "0 kafka [a b]" },
  { id: "L1", case: "a group larger than the limit is alone", maxShardChunks: 4, groups: "kafka/a:1 kafka/b:5 kafka/c:1", shards: "0 kafka [a]; 1 kafka [b]; 2 kafka [c]" },
  { id: "L1", case: "a group of exactly the limit fills one shard", maxShardChunks: 4, groups: "kafka/a:4 kafka/b:1", shards: "0 kafka [a]; 1 kafka [b]" },
  { id: "L1", case: "a project boundary starts a shard", maxShardChunks: 4, groups: "datafusion/b:1 kafka/a:1", shards: "0 datafusion [b]; 1 kafka [a]" },
  { id: "L1", case: "a group without chunks joins the open shard", maxShardChunks: 4, groups: "kafka/a:4 kafka/b:0", shards: "0 kafka [a b]" },
  { id: "L1", case: "a project whose groups have no chunks still gets a shard", maxShardChunks: 4, groups: "datafusion/a:0 kafka/b:1", shards: "0 datafusion [a]; 1 kafka [b]" },
  { id: "L11", case: "no groups", maxShardChunks: 4, groups: "", shards: "" },
] as const;
