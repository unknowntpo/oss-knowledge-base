/**
 * Spec 014 Behavior 14–15: the model seam and how its errors and spend are handled. Slice 2 has
 * no Workers AI binding: production runs without a model (rules features, no generated text),
 * and tests use a fake. The real error shapes are confirmed on Dev before Prod (D35).
 */
import { callEstimate, settledNeurons, type PricedModel } from "@oss-knowledge-base/reference-pipeline";

export interface DigestModel {
  run(model: PricedModel, prompt: string, maxTokens: number): Promise<string>;
}

/** An error from a model call; `code` is a Workers AI error code, `status` an HTTP status. */
export class ModelCallError extends Error {
  constructor(message: string, readonly code?: number, readonly status?: number) {
    super(message);
  }
}

/** 3036 (daily allocation) and a gateway 429 stop the run's model use; anything else is retried once. */
export function modelErrorKind(error: unknown): "limit" | "retry" {
  if (error instanceof ModelCallError && (error.code === 3036 || error.status === 429)) return "limit";
  return "retry";
}

export const RETRY_DELAY_MS = 5_000;

export interface SpendLedger {
  /** Estimated neurons already spent today (UTC). */
  readonly spent: number;
  readonly cap: number;
}

/**
 * One run's model calls: the daily cap gate, one retry, and the stop after a limit. Returns the
 * model's text, or `undefined` when the caller must fall back.
 */
export class ModelCalls {
  limited = false;
  calls = 0;
  failures = 0;
  private total: number;

  constructor(
    private readonly model: DigestModel | undefined,
    private readonly ledger: SpendLedger,
    private readonly delay: (ms: number) => Promise<void>,
  ) {
    this.total = ledger.spent;
  }

  get spentToday(): number {
    return this.total;
  }

  get enabled(): boolean {
    return this.model !== undefined && !this.limited;
  }

  async call(model: PricedModel, prompt: string, maxTokens: number): Promise<string | undefined> {
    if (this.model === undefined || this.limited) return undefined;
    const estimate = callEstimate(model, prompt, maxTokens);
    if (this.total + estimate > this.ledger.cap) {
      this.limited = true;
      return undefined;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.calls += 1;
      try {
        const output = await this.model.run(model, prompt, maxTokens);
        this.total += settledNeurons(model, prompt, output);
        return output;
      } catch (error) {
        this.total += estimate;
        if (modelErrorKind(error) === "limit") {
          this.limited = true;
          return undefined;
        }
        if (attempt === 0) await this.delay(RETRY_DELAY_MS);
      }
    }
    this.failures += 1;
    return undefined;
  }
}
