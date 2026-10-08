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
} as const;
export type PricedModel = keyof typeof PRICES;

export const DAILY_CAP = { prod: 5_000, dev: 4_500 } as const;
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
