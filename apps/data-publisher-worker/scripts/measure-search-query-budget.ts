/**
 * Spec 016 H68: the query-time budget, from the constants the gate enforces. Offline arithmetic:
 * no network, no Workers AI, no Vectorize. It is the estimate to read before hybrid search is
 * enabled; after that, `/health` `searchQuery.today` shows what was spent.
 *
 *   bun run measure:search-query-budget [--chunks 8780]
 */
import { parseArgs } from "node:util";

import { DAILY_NEURON_BUDGET, DIGEST_NEURON_CALIBRATION, EMBEDDING_TOKEN_CALIBRATION, estimateTokens, PRICES, USD_PER_NEURON } from "@oss-knowledge-base/reference-pipeline";
import { DEFAULT_QUERY_GATE_LIMITS, MAX_SEMANTIC_QUERY_CHARACTERS, queryNeuronCharge, resolveSearchEmbedding } from "@oss-knowledge-base/semantic-vectorize";

import { DEFAULT_EMBEDDING_LIMITS } from "../src/search-embedding/run";

const { values } = parseArgs({ options: { chunks: { type: "string" } } });
const chunks = Number(values.chunks ?? 8_780);
if (!Number.isInteger(chunks) || chunks <= 0) throw new Error("--chunks must be a positive integer");

const profile = resolveSearchEmbedding("bge-m3@1")!;
const perMillion = PRICES["@cf/baai/bge-m3"].inputPerM;
const limits = DEFAULT_QUERY_GATE_LIMITS;
const neuronsOf = (tokens: number) => (tokens * perMillion) / 1_000_000;
const sample = (label: string, text: string) => ({
  label,
  characters: text.length,
  calibratedEstimateNeurons: Number(neuronsOf(estimateTokens(text) * EMBEDDING_TOKEN_CALIBRATION).toFixed(4)),
  upperBoundNeurons: Number(neuronsOf(text.length + 3).toFixed(4)),
  charged: queryNeuronCharge(text, perMillion),
});

const INCLUDED_QUERIED_DIMENSIONS = 50_000_000;
const INCLUDED_STORED_DIMENSIONS = 10_000_000;
const dimensions = profile.revision.dimensions;
const DAYS = 31;
const monthlyQueried = (chunks + DAYS * limits.maxIndexQueriesPerDay) * dimensions;
const total = DAILY_NEURON_BUDGET.digestCalibrated + DAILY_NEURON_BUDGET.searchEmbedding + DAILY_NEURON_BUDGET.searchQuery;

console.log(JSON.stringify({
  model: profile.revision.model,
  neuronsPerMillionTokens: perMillion,
  perQuery: [
    sample("a typical query", "consumer network thread request manager"),
    sample("a Chinese query", "消費者重新平衡很慢"),
    sample(`the longest accepted text, ASCII (${MAX_SEMANTIC_QUERY_CHARACTERS} characters)`, "x".repeat(MAX_SEMANTIC_QUERY_CHARACTERS)),
    sample(`the longest accepted text, CJK (${MAX_SEMANTIC_QUERY_CHARACTERS} characters)`, "交".repeat(MAX_SEMANTIC_QUERY_CHARACTERS)),
  ],
  workersAiNeuronsPerDay: {
    digestCapInItsOwnEstimate: DAILY_NEURON_BUDGET.digest,
    digestCalibration: DIGEST_NEURON_CALIBRATION,
    digest: DAILY_NEURON_BUDGET.digestCalibrated,
    searchEmbedding: DAILY_NEURON_BUDGET.searchEmbedding,
    searchQuery: DAILY_NEURON_BUDGET.searchQuery,
    total,
    included: DAILY_NEURON_BUDGET.included,
    headroom: DAILY_NEURON_BUDGET.included - total,
    embeddingCalibration: EMBEDDING_TOKEN_CALIBRATION,
    usdIfTheQueryCapWereBilled: Number((DAILY_NEURON_BUDGET.searchQuery * USD_PER_NEURON).toFixed(4)),
  },
  queryGate: {
    uncachedQueriesPerDayAtMost: Math.min(limits.dailyNeuronCap, limits.maxIndexQueriesPerDay),
    uncachedTwoProjectSearchesPerDayAtMost: Math.min(limits.dailyNeuronCap, Math.floor(limits.maxIndexQueriesPerDay / 2)),
    modelCallsPerHourAtMost: limits.maxModelCallsPerHour,
    hoursToSpendTheDayAtLeast: limits.dailyNeuronCap / limits.maxModelCallsPerHour,
    matchCacheMinutes: limits.matchTtlMs / 60_000,
    embeddingCacheDays: limits.vectorRetentionDays,
    gatewayRequestsPerHour: { gateAtMost: limits.maxModelCallsPerHour, embeddingRunAtMost: DEFAULT_EMBEDDING_LIMITS.maxCallsPerRun, gatewayLimit: 600 },
  },
  vectorizePerMonth: {
    chunks,
    dimensions,
    storedDimensions: chunks * dimensions,
    includedStoredDimensions: INCLUDED_STORED_DIMENSIONS,
    storedWithinIncluded: chunks * dimensions <= INCLUDED_STORED_DIMENSIONS,
    indexQueriesAtMost: DAYS * limits.maxIndexQueriesPerDay,
    queriedDimensionsAtMost: monthlyQueried,
    includedQueriedDimensions: INCLUDED_QUERIED_DIMENSIONS,
    queriedWithinIncluded: monthlyQueried <= INCLUDED_QUERIED_DIMENSIONS,
    chunksAtWhichQueriedPassesIncluded: Math.floor(INCLUDED_QUERIED_DIMENSIONS / dimensions) - DAYS * limits.maxIndexQueriesPerDay + 1,
  },
}, null, 2));
