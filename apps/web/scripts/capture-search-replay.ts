/**
 * Spec 016 fusion (H74): records what a deployed `/api/search` answers for each labelled query,
 * once lexically (`semantic=off`) and once hybrid, as a replay fixture: thread ids with their
 * lexical rank, semantic rank, live fused rank and matched query terms. Fusion revisions are then
 * compared on the fixture, in CI, without the network (`apps/web/test/search-fusion-replay.test.ts`).
 * Not run in CI. Only public GETs, one at a time, `--delay` ms apart (default 1,000); no credential.
 *
 *   bun run capture:search-replay --out apps/web/test/fixtures/hybrid-replay.<date>.json \
 *     [--base https://oss-knowledge-base-dev.pages.dev] [--queries extra.json] [--raw dir] [--from-raw dir]
 *
 * Cost against the query gate: one hybrid request per query that is not an identifier, so at most
 * one model call (none within the embedding cache's 7 days) and two index queries (none within the
 * match cache's hour) each. `--queries` replaces the list with a JSON array of strings; `--raw`
 * keeps each pair of responses, and `--from-raw` rebuilds a fixture from such a folder, offline.
 *
 * What a response does not hold is not in the fixture: thread titles and excerpts (public, but not
 * needed to replay fusion), and semantic candidates beyond the response's 50 results. The semantic
 * similarity is recorded when the deployment serves `signals.semanticScore`.
 */
import { lexicalQueryTerms, lexicalQueryWords, lexicalSearchConfigFor } from "@oss-knowledge-base/search";
import { searchIdentifierProfiles } from "@oss-knowledge-base/reference-pipeline/search-profiles";
import type { SearchResponseV1 } from "@oss-knowledge-base/serving-contract";

import { evalQueries } from "./measure-search-hybrid";

export const REPLAY_SCHEMA = "ossknowledge.search-hybrid-replay.v1";
/** The API returns at most 50 threads, and hybrid search ranks lexical threads to 50. */
export const REPLAY_DEPTH = 50;

/**
 * One thread of one query: `[id, project, lexicalRank, semanticRank, liveFusedRank, terms, exact, semanticScore]`.
 * `project` indexes `ReplayFixture.projects`; a rank of 0 is "not returned"; `terms` holds, for each
 * passage the lexical response showed, a bit mask over the query's `terms`; `exact` is 1 for an
 * exact identifier match; `semanticScore` is `null` when the deployment did not serve it.
 */
export type ReplayThread = readonly [string, number, number, number, number, readonly number[], 0 | 1, number | null];

export interface ReplayQuery {
  readonly query: string;
  /** `retrieval.semantic.status` of the hybrid response. */
  readonly semantic: string;
  /** The query's distinct terms as the release's lexical revision reads it, matched or not. */
  readonly terms: readonly string[];
  /** The query's distinct words (`lexicalQueryWords`): what a full lexical match holds in one passage. */
  readonly words: readonly string[];
  /** Lexical threads in lexical order, then threads only the hybrid response returned, in its order. */
  readonly threads: readonly ReplayThread[];
}

export interface ReplayFixture {
  readonly schema: typeof REPLAY_SCHEMA;
  readonly base: string;
  readonly release: string;
  readonly capturedAt: string;
  readonly lexicalRevision: string;
  readonly semanticRevision: string | null;
  readonly fusionRevision: string | null;
  readonly depth: number;
  readonly projects: readonly string[];
  readonly queries: readonly ReplayQuery[];
}

/** Pure: the fixture row of one query from its two responses. Throws when they disagree on a lexical rank. */
export function replayQuery(query: string, lexical: SearchResponseV1, hybrid: SearchResponseV1, projects: string[]): ReplayQuery {
  const config = lexicalSearchConfigFor(lexical.retrieval.lexicalRevision, searchIdentifierProfiles);
  const terms = lexicalQueryTerms(query, config);
  const project = (id: string) => {
    if (!projects.includes(id)) projects.push(id);
    return projects.indexOf(id);
  };
  const masks = (result: SearchResponseV1["results"][number]) => result.matches.map((match) => {
    let bits = 0;
    for (const term of match.matchedTerms) {
      if (!terms.includes(term)) throw new Error(`"${query}": matched term ${term} is not a query term`);
      bits |= 1 << terms.indexOf(term);
    }
    return bits;
  });
  const live = new Map(hybrid.results.map((result) => [result.entry.sourceTitleRecordId, result]));
  const threads: ReplayThread[] = [];
  const seen = new Set<string>();
  lexical.results.forEach((result, index) => {
    const id = result.entry.sourceTitleRecordId;
    const fused = live.get(id)?.matches[0]?.signals;
    if (fused !== undefined && fused.lexicalRank !== index + 1) {
      throw new Error(`"${query}": ${id} is lexical rank ${index + 1} alone and ${fused.lexicalRank} in the hybrid response`);
    }
    seen.add(id);
    threads.push([
      id, project(result.entry.projectId), index + 1, fused?.semanticRank ?? 0, fused?.fusedRank ?? 0, masks(result),
      result.matches.some((match) => match.signals.exactIdentifier) ? 1 : 0, score(fused),
    ]);
  });
  for (const result of hybrid.results) {
    const id = result.entry.sourceTitleRecordId;
    if (seen.has(id)) continue;
    const signals = result.matches[0]!.signals;
    if (signals.lexicalRank !== undefined) throw new Error(`"${query}": ${id} has lexical rank ${signals.lexicalRank} but is not in the lexical response`);
    threads.push([id, project(result.entry.projectId), 0, signals.semanticRank ?? 0, signals.fusedRank, [], 0, score(signals)]);
  }
  return { query, semantic: hybrid.retrieval.semantic?.status ?? "absent", terms, words: lexicalQueryWords(query, config), threads };
}

type Signals = SearchResponseV1["results"][number]["matches"][number]["signals"];
const score = (signals: Signals | undefined) =>
  typeof signals?.semanticScore === "number" && Number.isFinite(signals.semanticScore) ? Math.round(signals.semanticScore * 1e4) / 1e4 : null;

if (import.meta.main) {
  const option = (name: string) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? undefined : process.argv[index + 1];
  };
  const base = option("--base") ?? "https://oss-knowledge-base-dev.pages.dev";
  const out = option("--out");
  if (out === undefined) throw new Error("--out <fixture path> is required");
  const delay = Number(option("--delay") ?? 1_000);
  const raw = option("--raw");
  const list = option("--queries");
  const queries: readonly string[] = list === undefined ? evalQueries().map((query) => query.query) : await Bun.file(list).json();
  const ask = async (query: string, lexicalOnly: boolean) => {
    const url = new URL("/api/search", base);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(REPLAY_DEPTH));
    if (lexicalOnly) url.searchParams.set("semantic", "off");
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const body = await response.json() as SearchResponseV1;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return body;
  };

  const fromRaw = option("--from-raw");
  const kept = fromRaw === undefined ? undefined : new Map<string, { lexical: SearchResponseV1; hybrid: SearchResponseV1; capturedAt?: string }>();
  if (fromRaw !== undefined) {
    for (const name of [...new Bun.Glob("*.json").scanSync(fromRaw)].sort()) {
      const pair = await Bun.file(`${fromRaw}/${name}`).json();
      kept!.set(pair.query, pair);
    }
  }
  const projects: string[] = [];
  const rows: ReplayQuery[] = [];
  let first: SearchResponseV1 | undefined;
  let semanticRevision: string | null = null;
  let capturedAt = new Date().toISOString();
  for (const [index, query] of (kept === undefined ? queries : [...kept.keys()]).entries()) {
    const lexical = kept?.get(query)!.lexical ?? await ask(query, true);
    const hybrid = kept?.get(query)!.hybrid ?? await ask(query, false);
    capturedAt = kept?.get(query)!.capturedAt ?? capturedAt;
    first ??= hybrid;
    if (lexical.retrieval.indexRevision !== first.retrieval.indexRevision || hybrid.retrieval.indexRevision !== first.retrieval.indexRevision) {
      throw new Error(`The release changed during the capture at "${query}"; run it again`);
    }
    semanticRevision ??= hybrid.retrieval.semanticRevision ?? null;
    rows.push(replayQuery(query, lexical, hybrid, projects));
    if (raw !== undefined) await Bun.write(`${raw}/${String(index).padStart(2, "0")}.json`, JSON.stringify({ query, capturedAt, lexical, hybrid }));
    console.log(`${query}: ${hybrid.retrieval.semantic?.status ?? "lexical only"}${hybrid.retrieval.semantic?.cached === true ? " (cached)" : ""}, ${rows.at(-1)!.threads.length} threads`);
  }
  const fixture: ReplayFixture = {
    schema: REPLAY_SCHEMA,
    base,
    release: first?.retrieval.indexRevision ?? "",
    capturedAt,
    lexicalRevision: first?.retrieval.lexicalRevision ?? "",
    semanticRevision,
    fusionRevision: first?.retrieval.fusionRevision ?? null,
    depth: REPLAY_DEPTH,
    projects,
    queries: rows,
  };
  // One thread a line: reviewable diffs without two megabytes of indentation.
  const body = JSON.stringify({ ...fixture, queries: "@" }, null, 2).replace('"@"', `[\n${rows.map((row) =>
    `    {"query": ${JSON.stringify(row.query)}, "semantic": ${JSON.stringify(row.semantic)}, "terms": ${JSON.stringify(row.terms)}, "words": ${JSON.stringify(row.words)}, "threads": [\n${
      row.threads.map((thread) => `      ${JSON.stringify(thread)}`).join(",\n")}\n    ]}`).join(",\n")}\n  ]`);
  await Bun.write(out, `${body}\n`);
}
