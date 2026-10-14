/**
 * Spec 014 Behavior 15: token and neuron estimates and the daily spend gate.
 * Prices: https://developers.cloudflare.com/workers-ai/platform/pricing/ (read 2026-10-06).
 * Update this table when Cloudflare changes prices (gardening).
 */
import { PROTECTED_PATTERNS } from "./protect";

export const PRICES = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { inputPerM: 26_668, outputPerM: 204_805 },
  "@cf/qwen/qwen3-30b-a3b-fp8": { inputPerM: 4_625, outputPerM: 30_475 },
  // Clef decision models (launched 2026-10-01): $0.09 and $0.24 per M input tokens, output not
  // billed; at $0.011 per 1,000 neurons that is 8,182 and 21,818 neurons per M input tokens.
  "@cf/cloudflare/clef-flash": { inputPerM: 8_182, outputPerM: 0 },
  "@cf/cloudflare/clef": { inputPerM: 21_818, outputPerM: 0 },
  // Search embeddings (Spec 016): $0.012 per M input tokens, no output; 1,091 neurons per M.
  "@cf/baai/bge-m3": { inputPerM: 1_091, outputPerM: 0 },
} as const;
export type PricedModel = keyof typeof PRICES;

/** Workers AI bills $0.011 per 1,000 neurons. */
export const USD_PER_NEURON = 0.011 / 1_000;

/**
 * The digest's daily cap in calibrated neurons, which is what its ledger counts (Spec 014 D90,
 * D91; see `digestLedgerNeurons`). Dev was 4,500 price-table neurons, up to 5,760 real, until
 * slice 2e.
 */
export const DAILY_CAP = { prod: 5_000, dev: 5_000 } as const;
/** Slice 2c raised card, proposal, highlights and translation after JSON was cut on Dev (Behavior 15). */
export const MAX_TOKENS = { classify: 800, card: 500, proposal: 160, highlights: 800, translation: 4_000 } as const;

const DISPLAY_ID = /\b[A-Z]+-(?:PR|ISSUE|MAIL)-[0-9a-f]+\b/gu;
const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/gu;

/** Identifier spans count 2 characters per token, CJK 1 per character, other text 4 per token. */
export function estimateTokens(text: string): number {
  let identifierChars = 0;
  let rest = text;
  for (const pattern of [DISPLAY_ID, ...PROTECTED_PATTERNS]) {
    rest = rest.replace(pattern, (match) => {
      identifierChars += match.length;
      return "";
    });
  }
  const cjk = (rest.match(CJK) ?? []).length;
  const other = rest.replace(CJK, "").length;
  return Math.ceil(identifierChars / 2 + cjk + other / 4);
}

/** Neurons for a call, rounded to the nearest neuron. */
export function neurons(model: PricedModel, inputTokens: number, outputTokens: number): number {
  const price = PRICES[model];
  return Math.round((inputTokens * price.inputPerM + outputTokens * price.outputPerM) / 1_000_000);
}

/**
 * How many tokens `@cf/baai/bge-m3` bills for each token `estimateTokens` counts. Measured once:
 * the Dev backfill of 2026-10-12 made 176 calls that the AI Gateway `osskb-search-dev` priced at
 * $0.0157, against an estimate of 803 neurons ($0.0088) for the same texts: 1.78, rounded up.
 * The texts were English titles and excerpts with identifiers; other text may differ.
 */
export const EMBEDDING_TOKEN_CALIBRATION = 1.8;

/** Neurons for embedding texts of `estimatedTokens` (from `estimateTokens`), calibrated to the measured tokenizer. */
export function embeddingNeurons(model: PricedModel, estimatedTokens: number): number {
  return neurons(model, Math.ceil(estimatedTokens * EMBEDDING_TOKEN_CALIBRATION), 0);
}

/**
 * How many neurons the digest really spends for each neuron the price table estimates. Measured
 * once: on 2026-10-08 three Dev dry runs were estimated at 4,507 neurons, and the AI Gateway
 * `osskb-digest-dev` logged their 109 calls at $0.06306, which is 5,733 neurons at $0.011 per
 * 1,000: 1.272, rounded up. The digest's ledger applies it (`digestLedgerNeurons`).
 */
export const DIGEST_NEURON_CALIBRATION = 1.28;

/**
 * Spec 014 D90: what the digest's ledger adds for a call the price table puts at
 * `priceTableNeurons`, before the call (its estimate) and after it (the settled amount).
 */
export function digestLedgerNeurons(priceTableNeurons: number): number {
  return Math.ceil(priceTableNeurons * DIGEST_NEURON_CALIBRATION);
}

/**
 * What a UTC day may spend on Dev, by spender. The digest's and the embedding job's caps are in
 * calibrated neurons and the query cap is an upper bound. The three are 8,500 of the 10,000
 * neurons a day the plan includes (Spec 014 D91).
 */
export const DAILY_NEURON_BUDGET = {
  digest: DAILY_CAP.dev,
  searchEmbedding: 2_500,
  searchQuery: 1_000,
  included: 10_000,
} as const;

/** Before a call: input estimate plus `max_tokens` at the output price. */
export function callEstimate(model: PricedModel, input: string, maxTokens: number): number {
  return neurons(model, estimateTokens(input), maxTokens);
}

/** Behavior 15: the next call runs only when `total + estimate <= cap`. */
export function spendAllows(runningTotal: number, estimate: number, cap: number): boolean {
  return runningTotal + estimate <= cap;
}

/** After a call: the estimate is replaced with the actual input and output sizes. */
export function settledNeurons(model: PricedModel, input: string, output: string): number {
  return neurons(model, estimateTokens(input), estimateTokens(output));
}

/**
 * Behavior 15: calls run in order while the cap allows; the first call that would exceed it,
 * and every call after it, is skipped and the run is `limited`.
 */
export function planCalls(estimates: readonly number[], runningTotal: number, cap: number): {
  readonly called: number;
  readonly skipped: number;
  readonly limited: boolean;
  readonly total: number;
} {
  let total = runningTotal;
  for (let index = 0; index < estimates.length; index += 1) {
    if (!spendAllows(total, estimates[index]!, cap)) {
      return { called: index, skipped: estimates.length - index, limited: true, total };
    }
    total += estimates[index]!;
  }
  return { called: estimates.length, skipped: 0, limited: false, total };
}
