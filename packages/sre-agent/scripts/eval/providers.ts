/**
 * Spec 027 SRE101–SRE103: the eval's options and its paid model backends. `--provider anthropic` and
 * `--provider openai-compatible` (a new-api gateway, for example) run the same cases as Workers AI; keys
 * come only from the environment and never reach an error message. A paid model needs a USD price, so the
 * eval can bound each diagnosis and the whole run in dollars (SRE102).
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, type LanguageModel } from "ai";

type Model = Exclude<LanguageModel, string>;

export const CANDIDATES = ["@cf/zai-org/glm-4.7-flash", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/qwen/qwen3-30b-a3b-fp8"] as const;
export const PROVIDERS = ["workers-ai", "anthropic", "openai-compatible"] as const;
export const EFFORTS = ["low", "medium", "high"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type Effort = (typeof EFFORTS)[number];

/** USD per million tokens (Anthropic pricing, 2026-10-06; Haiku 5.5 for prompts up to 100K tokens). */
export interface UsdPrice {
  readonly input: number;
  readonly output: number;
}

export const USD_PER_MTOK: Readonly<Record<string, UsdPrice>> = {
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

/** The listed price, or `--usd-per-mtok <in>,<out>`; a model with neither is refused. */
export function priceFor(modelId: string, override?: string): UsdPrice {
  if (override !== undefined) {
    const parts = override.split(",").map(Number);
    if (parts.length !== 2 || !parts.every((value) => Number.isFinite(value) && value >= 0)) throw new Error(`--usd-per-mtok needs <in>,<out> in USD per million tokens, got ${override}`);
    return { input: parts[0]!, output: parts[1]! };
  }
  const price = USD_PER_MTOK[modelId];
  if (price === undefined) throw new Error(`no USD price for ${modelId}; pass --usd-per-mtok <in>,<out>`);
  return price;
}

export interface Options {
  provider: Provider;
  models: string[];
  runs: number;
  budgetUsd: number;
  stub: boolean;
  /** Models in the inner loop (case, run, model), so a budget stop leaves every model with comparable samples. */
  interleave: boolean;
  suffix: string;
  out: string | undefined;
  /** SRE102: the USD cap of one diagnosis on a paid provider. */
  maxUsdPerDiagnosis: number;
  usdPerMtok: string | undefined;
  /** SRE103: the Anthropic `effort` option. */
  effort: Effort;
}

const oneOf = <T extends string>(flag: string, allowed: readonly T[], value: string): T => {
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${flag} must be one of ${allowed.join(", ")}, got ${value}`);
  return value as T;
};

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    provider: "workers-ai", models: [], runs: 5, budgetUsd: 1.29, stub: false, interleave: false, suffix: "", out: undefined,
    maxUsdPerDiagnosis: 0.1, usdPerMtok: undefined, effort: "low",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--provider") options.provider = oneOf(arg, PROVIDERS, next());
    else if (arg === "--model") options.models.push(next());
    else if (arg === "--runs") options.runs = Number(next());
    else if (arg === "--budget-usd") options.budgetUsd = Number(next());
    else if (arg === "--max-usd-per-diagnosis") options.maxUsdPerDiagnosis = Number(next());
    else if (arg === "--usd-per-mtok") options.usdPerMtok = next();
    else if (arg === "--effort") options.effort = oneOf(arg, EFFORTS, next());
    else if (arg === "--stub") options.stub = true;
    else if (arg === "--interleave") options.interleave = true;
    else if (arg === "--suffix") options.suffix = next();
    else if (arg === "--out") options.out = next();
    else throw new Error(`unknown argument ${arg}`);
  }
  if (options.models.length === 0) {
    if (options.provider !== "workers-ai") throw new Error(`--provider ${options.provider} needs --model`);
    options.models = [...CANDIDATES];
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error("--runs must be a positive integer");
  if (!(options.budgetUsd > 0)) throw new Error("--budget-usd must be positive");
  if (!(options.maxUsdPerDiagnosis > 0)) throw new Error("--max-usd-per-diagnosis must be positive");
  if (options.provider !== "workers-ai") for (const modelId of options.models) priceFor(modelId, options.usdPerMtok);
  return options;
}

type Env = Readonly<Record<string, string | undefined>>;

const required = (env: Env, name: string): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
};

/** A paid provider's model; the keys are read from `env` and stay out of every message. */
export function paidModel(provider: Exclude<Provider, "workers-ai">, modelId: string, env: Env): Model {
  if (provider === "anthropic") return createAnthropic({ apiKey: required(env, "ANTHROPIC_API_KEY") })(modelId);
  const baseURL = required(env, "OPENAI_COMPATIBLE_BASE_URL");
  return createOpenAICompatible({ name: "openai-compatible", baseURL, apiKey: required(env, "OPENAI_COMPATIBLE_API_KEY") })(modelId);
}

/** SRE103: every call carries `anthropic.effort`, so thinking fits the production 4,096-token output cap. */
export function withEffort(model: Model, effort: Effort): Model {
  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => ({
        ...params,
        providerOptions: { ...params.providerOptions, anthropic: { ...params.providerOptions?.anthropic, effort } },
      }),
    },
  });
}
