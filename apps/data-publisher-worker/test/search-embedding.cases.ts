/**
 * Spec 016 slice 2b embedding run plan: the single source for the rows of
 * `search-embedding-run.test.ts` and for the table in docs/specs/016-semantic-search/spec.md
 * (`bun run docs:test-plan` regenerates it).
 *
 * Every row runs against a release of five chunks in two projects (so two shards) with two texts
 * per model call: three batches, `[a1 a2] [a3 b1] [b2]`.
 *
 * - `start`: `empty`, or `one extra` (all five embedded, plus one vector of a chunk the release
 *   no longer holds).
 * - `limits`: overrides of the run's bounds; `callMs` is how long the fake model takes.
 * - `fault`: what goes wrong during the first run only.
 * - `days`: the UTC day of each run.
 * - `expected`: per run, model calls, chunks embedded of chunks read, vectors deleted, the bound
 *   reached, and `ok` or the failure kind.
 */
export const testPlanRows = [
  { id: "H21", case: "everything is embedded, then nothing is left to do", start: "empty", limits: "—", fault: "—", days: "1 1", expected: "3 calls, 5/5 embedded, 0 deleted, not limited, ok → 0 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H21", case: "a vector the release dropped is deleted", start: "one extra", limits: "—", fault: "—", days: "1 1", expected: "0 calls, 5/5 embedded, 1 deleted, not limited, ok → 0 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H46", case: "chunks per run", start: "empty", limits: "maxChunksPerRun=3", fault: "—", days: "1 1", expected: "2 calls, 3/5 embedded, 0 deleted, chunks-per-run, ok → 1 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H46", case: "model calls per run", start: "empty", limits: "maxCallsPerRun=1", fault: "—", days: "1 1 1", expected: "1 calls, 2/5 embedded, 0 deleted, calls-per-run, ok → 1 calls, 4/5 embedded, 0 deleted, calls-per-run, ok → 1 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H46", case: "model calls per UTC day", start: "empty", limits: "maxCallsPerDay=2", fault: "—", days: "1 1 2", expected: "2 calls, 4/5 embedded, 0 deleted, calls-per-day, ok → 0 calls, 4/5 embedded, 0 deleted, calls-per-day, ok → 1 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H46", case: "estimated neurons per UTC day", start: "empty", limits: "dailyNeuronCap=2", fault: "—", days: "1 1 2", expected: "2 calls, 4/5 embedded, 0 deleted, daily-neurons, ok → 0 calls, 4/5 embedded, 0 deleted, daily-neurons, ok → 1 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H46", case: "the deadline", start: "empty", limits: "deadlineMs=1500 callMs=1000", fault: "—", days: "1 1", expected: "2 calls, 4/5 embedded, 0 deleted, deadline, ok → 1 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H46", case: "a bound of zero embeds nothing", start: "empty", limits: "maxChunksPerRun=0", fault: "—", days: "1", expected: "0 calls, 0/5 embedded, 0 deleted, chunks-per-run, ok" },
  { id: "H48", case: "a model error, then success", start: "empty", limits: "—", fault: "model: call 1 fails", days: "1 1", expected: "4 calls, 5/5 embedded, 0 deleted, not limited, ok → 0 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H48", case: "a model error twice leaves that batch pending", start: "empty", limits: "—", fault: "model: calls 2 and 3 fail", days: "1 1", expected: "4 calls, 3/5 embedded, 0 deleted, not limited, model → 1 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H48", case: "Workers AI code 3036 stops model use", start: "empty", limits: "—", fault: "model: call 1 is refused with code 3036", days: "1 1", expected: "1 calls, 0/5 embedded, 0 deleted, model-limit, model-limit → 3 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H48", case: "a gateway 429 stops model use", start: "empty", limits: "—", fault: "model: call 2 is refused with a gateway 429", days: "1 1", expected: "2 calls, 2/5 embedded, 0 deleted, model-limit, model-limit → 2 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H48", case: "a spend-limit refusal stops model use", start: "empty", limits: "—", fault: "model: call 3 is refused for the spend limit", days: "1 1", expected: "3 calls, 4/5 embedded, 0 deleted, model-limit, model-limit → 1 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H48", case: "too few vectors", start: "empty", limits: "—", fault: "model: calls 1 and 2 return one vector too few", days: "1 1", expected: "4 calls, 3/5 embedded, 0 deleted, not limited, model → 1 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H48", case: "a wrong dimension", start: "empty", limits: "—", fault: "model: calls 1 and 2 return 3-dimension vectors", days: "1 1", expected: "4 calls, 3/5 embedded, 0 deleted, not limited, model → 1 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H48", case: "a model call that never answers", start: "empty", limits: "callTimeoutMs=5", fault: "model: calls 1 and 2 never answer", days: "1 1", expected: "4 calls, 3/5 embedded, 0 deleted, not limited, model → 1 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H48", case: "an upsert error, then success", start: "empty", limits: "—", fault: "index: upsert 1 fails", days: "1 1", expected: "3 calls, 5/5 embedded, 0 deleted, not limited, ok → 0 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H48", case: "an upsert error twice stops embedding", start: "empty", limits: "—", fault: "index: upserts 2 and 3 fail", days: "1 1", expected: "2 calls, 2/5 embedded, 0 deleted, vector-store, vector-store → 2 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H48", case: "an index that does not answer", start: "empty", limits: "—", fault: "index: describe fails", days: "1 1", expected: "0 calls, 0/0 embedded, 0 deleted, not limited, vector-store → 3 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H48", case: "an index of other dimensions", start: "empty", limits: "—", fault: "index: has 768 dimensions", days: "1", expected: "0 calls, 0/0 embedded, 0 deleted, not limited, config" },
  { id: "H48", case: "a delete error, then success", start: "one extra", limits: "—", fault: "index: delete 1 fails", days: "1", expected: "0 calls, 5/5 embedded, 1 deleted, not limited, ok" },
  { id: "H48", case: "a delete error twice keeps the vector and its state", start: "one extra", limits: "—", fault: "index: deletes 1 and 2 fail", days: "1 1", expected: "0 calls, 5/5 embedded, 0 deleted, not limited, vector-store → 0 calls, 5/5 embedded, 1 deleted, not limited, ok" },
  { id: "H48", case: "an unreadable shard keeps what was embedded before it", start: "empty", limits: "—", fault: "release: the second shard cannot be read", days: "1 1", expected: "1 calls, 2/3 embedded, 0 deleted, not limited, release-read → 2 calls, 5/5 embedded, 0 deleted, not limited, ok" },
  { id: "H48", case: "an unreadable shard deletes nothing", start: "one extra", limits: "—", fault: "release: the second shard cannot be read", days: "1 1", expected: "0 calls, 3/3 embedded, 0 deleted, not limited, release-read → 0 calls, 5/5 embedded, 1 deleted, not limited, ok" },
  { id: "H48", case: "a manifest whose chunk count disagrees deletes nothing", start: "one extra", limits: "—", fault: "release: the manifest declares 6 chunks", days: "1 1", expected: "0 calls, 5/5 embedded, 0 deleted, not limited, release-read → 0 calls, 5/5 embedded, 1 deleted, not limited, ok" },
  { id: "H48", case: "a release that is not search-release.v3", start: "one extra", limits: "—", fault: "release: a search-release.v2 manifest", days: "1", expected: "0 calls, 0/0 embedded, 0 deleted, not limited, release-read" },
  { id: "H48", case: "no current pointer", start: "one extra", limits: "—", fault: "release: no current pointer", days: "1", expected: "0 calls, 0/0 embedded, 0 deleted, not limited, release-read" },
] as const;
