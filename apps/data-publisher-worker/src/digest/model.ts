/**
 * Spec 014 Behavior 14–15: the model seam and how its errors and spend are handled. `run` is text
 * generation (summaries, highlights, translation); `decide` is the Clef decision model
 * (classification, slice 2b). Production wires Workers AI through AI Gateway (workers-ai.ts);
 * tests use a fake. Error shapes and token estimates are checked on Dev (D35).
 */
import {
  callEstimate, clefRequestTokens, estimateTokens, neurons, settledNeurons,
  type ClefModel, type ClefRequest, type ClefResponse, type PricedModel,
} from "@oss-knowledge-base/reference-pipeline";

export interface ModelUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
}

export interface DigestModel {
  run(model: PricedModel, prompt: string, maxTokens: number): Promise<string | { readonly text: string; readonly usage?: ModelUsage }>;
  decide?(model: ClefModel, request: ClefRequest): Promise<ClefResponse>;
}

/** An error from a model call; `code` is a Workers AI error code, `status` an HTTP status. */
export class ModelCallError extends Error {
  constructor(message: string, readonly code?: number, readonly status?: number) {
    super(message);
  }
}

/**
 * 3036 (daily allocation), a gateway 429 (rate limit), and a gateway spend-limit refusal stop the
 * run's model use; anything else is retried once.
 */
export function modelErrorKind(error: unknown): "limit" | "retry" {
  if (error instanceof ModelCallError && (error.code === 3036 || error.status === 429 || /spend limit/iu.test(error.message))) return "limit";
  return "retry";
}

export const RETRY_DELAY_MS = 5_000;
/** At most this many model requests per run; the Dev gateway allows 60 per hour (D26). */
export const MAX_CALLS_PER_RUN = 45;
const MAX_RECORDED_ERRORS = 10;

export interface SpendLedger {
  /** Estimated neurons already spent today (UTC). */
  readonly spent: number;
  readonly cap: number;
}

/** D35: what a failed call looked like, so Behavior 14–15's matching can be confirmed. */
export interface ModelErrorShape {
  readonly model: string;
  readonly kind: "limit" | "retry";
  readonly name: string;
  readonly message: string;
  readonly code?: number;
  readonly status?: number;
}

/** D35: the job's token estimate next to the usage the model reported, per successful call. */
export interface CallRecord {
  readonly model: string;
  readonly estimatedInputTokens: number;
  readonly reportedInputTokens?: number;
}

export interface Calibration {
  readonly calls: number;
  readonly callsWithUsage: number;
  readonly estimatedInputTokens: number;
  readonly reportedInputTokens: number;
  /** reported / estimated over calls that reported usage; null without usage. */
  readonly ratio: number | null;
}

/**
 * One run's model calls: the daily cap gate, the per-run call ceiling, one retry, and the stop
 * after a limit. Returns the model's output, or `undefined` when the caller must fall back.
 */
export class ModelCalls {
  limited = false;
  calls = 0;
  failures = 0;
  readonly errors: ModelErrorShape[] = [];
  readonly records: CallRecord[] = [];
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

  get decides(): boolean {
    return this.model?.decide !== undefined;
  }

  calibration(): Calibration {
    const withUsage = this.records.filter((record) => record.reportedInputTokens !== undefined);
    const estimated = withUsage.reduce((sum, record) => sum + record.estimatedInputTokens, 0);
    const reported = withUsage.reduce((sum, record) => sum + record.reportedInputTokens!, 0);
    return {
      calls: this.records.length,
      callsWithUsage: withUsage.length,
      estimatedInputTokens: this.records.reduce((sum, record) => sum + record.estimatedInputTokens, 0),
      reportedInputTokens: reported,
      ratio: estimated > 0 ? Math.round((reported / estimated) * 100) / 100 : null,
    };
  }

  async call(model: PricedModel, prompt: string, maxTokens: number): Promise<string | undefined> {
    const output = await this.attempt(model, callEstimate(model, prompt, maxTokens), estimateTokens(prompt), async () => {
      const result = await this.model!.run(model, prompt, maxTokens);
      return typeof result === "string" ? { value: result, usage: undefined } : { value: result.text, usage: result.usage };
    }, (text) => settledNeurons(model, prompt, text));
    return output;
  }

  async decide(model: ClefModel, request: ClefRequest): Promise<ClefResponse | undefined> {
    const inputTokens = clefRequestTokens(request);
    return this.attempt(model, neurons(model, inputTokens, 0), inputTokens, async () => {
      const response = await this.model!.decide!(model, request);
      return { value: response, usage: response.usage as ModelUsage | undefined };
    }, () => neurons(model, inputTokens, 0));
  }

  private async attempt<T>(
    model: PricedModel,
    estimate: number,
    estimatedInputTokens: number,
    invoke: () => Promise<{ value: T; usage: ModelUsage | undefined }>,
    settle: (value: T) => number,
  ): Promise<T | undefined> {
    if (this.model === undefined || this.limited) return undefined;
    if (this.total + estimate > this.ledger.cap) {
      this.limited = true;
      return undefined;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.calls >= MAX_CALLS_PER_RUN) {
        this.limited = true;
        return undefined;
      }
      this.calls += 1;
      try {
        const { value, usage } = await invoke();
        const reported = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
        this.total += settle(value);
        this.records.push({ model, estimatedInputTokens, ...(reported === undefined ? {} : { reportedInputTokens: reported }) });
        return value;
      } catch (error) {
        // Gardening G21: a failed call is charged its pre-call estimate.
        this.total += estimate;
        const kind = modelErrorKind(error);
        if (this.errors.length < MAX_RECORDED_ERRORS) this.errors.push(errorShape(model, kind, error));
        if (kind === "limit") {
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

function errorShape(model: string, kind: "limit" | "retry", error: unknown): ModelErrorShape {
  const name = error instanceof Error ? error.constructor.name || error.name : typeof error;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
  const code = error instanceof ModelCallError ? error.code : undefined;
  const status = error instanceof ModelCallError ? error.status : undefined;
  return { model, kind, name, message, ...(code === undefined ? {} : { code }), ...(status === undefined ? {} : { status }) };
}
