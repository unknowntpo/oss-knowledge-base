/**
 * Spec 027 "Eval providers" (SRE101–SRE103): `--provider`, keys from the environment, the USD cap and
 * the Anthropic effort option. Rows: eval-providers.cases.ts. Fake keys only; no request leaves the test.
 */
import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { generateText, type LanguageModel } from "ai";
import { EVAL_CASES } from "../scripts/eval/cases";
import { CostMeter, evalLibrary, goldenModel, runCase, scoreboard, type CaseRun } from "../scripts/eval/harness";
import { paidModel, parseArgs, priceFor, USD_PER_MTOK, withEffort } from "../scripts/eval/providers";
import { testPlanRows } from "./eval-providers.cases";

const library = evalLibrary();
const FAKE = "fake-key-0123456789";

describe("Spec 027 eval providers", () => {
  test("eval providers: every SRE101–SRE103 row is listed", () => {
    expect(new Set(testPlanRows.map((row) => row.id))).toEqual(new Set(["SRE101", "SRE102", "SRE103"]));
  });

  test("SRE101: --provider defaults to workers-ai and accepts anthropic and openai-compatible only", () => {
    expect(parseArgs([]).provider).toBe("workers-ai");
    expect(parseArgs(["--provider", "anthropic", "--model", "claude-sonnet-5-5"]).provider).toBe("anthropic");
    expect(parseArgs(["--provider", "openai-compatible", "--model", "m", "--usd-per-mtok", "1,4"]).provider).toBe("openai-compatible");
    expect(() => parseArgs(["--provider", "openrouter"])).toThrow(/workers-ai, anthropic, openai-compatible/u);
  });

  test("SRE101: a paid provider reads its keys only from the environment and names a missing one", () => {
    expect(() => paidModel("anthropic", "claude-sonnet-5-5", {})).toThrow(/ANTHROPIC_API_KEY/u);
    expect(() => paidModel("openai-compatible", "m", { OPENAI_COMPATIBLE_API_KEY: FAKE })).toThrow(/OPENAI_COMPATIBLE_BASE_URL/u);
    let message = "";
    try {
      paidModel("openai-compatible", "m", { OPENAI_COMPATIBLE_BASE_URL: "https://gateway.test/v1" });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/OPENAI_COMPATIBLE_API_KEY/u);
    expect(message).not.toContain(FAKE);
    expect(paidModel("anthropic", "claude-sonnet-5-5", { ANTHROPIC_API_KEY: FAKE }).modelId).toBe("claude-sonnet-5-5");
    expect(paidModel("openai-compatible", "qwen-max", { OPENAI_COMPATIBLE_BASE_URL: "https://gateway.test/v1", OPENAI_COMPATIBLE_API_KEY: FAKE }).modelId).toBe("qwen-max");
  });

  test("SRE101: --stub needs no key", () => {
    expect(parseArgs(["--provider", "anthropic", "--model", "claude-sonnet-5-5", "--stub"]).stub).toBe(true);
  });

  test("SRE102: a paid model needs a listed price or --usd-per-mtok", () => {
    expect(USD_PER_MTOK["claude-sonnet-5-5"]).toEqual({ input: 2, output: 10 });
    expect(priceFor("claude-haiku-5-5")).toEqual({ input: 0.1, output: 0.5 });
    expect(() => priceFor("qwen-max")).toThrow(/--usd-per-mtok/u);
    expect(priceFor("qwen-max", "1,4")).toEqual({ input: 1, output: 4 });
    expect(() => priceFor("qwen-max", "1")).toThrow(/--usd-per-mtok/u);
    expect(() => parseArgs(["--provider", "openai-compatible", "--model", "qwen-max"])).toThrow(/--usd-per-mtok/u);
  });

  test("SRE102: a paid diagnosis stops at the USD cap, not at the neuron ledger", async () => {
    const value = EVAL_CASES.find((row) => row.scenario === "r2-class-a-spike-2026-10-13")!;
    const price = { input: 2, output: 10 };
    // Each call: 20,000 input and 1,000 output tokens = $0.05. At the highest neuron rates the second call
    // would pass 1,500 neurons; under the $0.10 cap the eval stops when a reservation would pass $0.10.
    const result = await runCase({
      evalCase: value, modelId: "@cf/unlisted", library, run: 1,
      model: (bundle) => goldenModel(value, bundle, { loopTool: true }),
      pricing: { price, maxUsdPerDiagnosis: 0.1 },
    });
    expect(result.reason).toBe("budget");
    expect(result.modelCalls).toBeGreaterThan(1);
    expect(result.costUsd).toBeLessThanOrEqual(0.1);
    expect(result.costUsd).toBeCloseTo((result.inputTokens * price.input + result.outputTokens * price.output) / 1_000_000);
  });

  test("SRE102: the meter and the scoreboard count USD", () => {
    const meter = new CostMeter(0.8, 0.1);
    expect(meter.canStart()).toBe(true);
    meter.add(0.65);
    expect(meter.canStart()).toBe(true);
    meter.add(0.06);
    expect(meter.canStart()).toBe(false);
    const run = (over: Partial<CaseRun>): CaseRun => ({
      scenario: "s", modelId: "a", run: 1, called: true, firings: 1, verdict: "explained", reason: null, cause: "c", runbook: null,
      evidence: [], evidenceFailures: [], tools: [], steps: 1, modelCalls: 1, inputTokens: 1, outputTokens: 1, neurons: 100, neuronsReported: 100,
      latencyMs: 1, grade: { cause: true, evidence: true, anchor: true, fabricated: false, pass: true, missing: [] }, ...over,
    });
    const board = scoreboard([run({ costUsd: 0.03 }), run({ costUsd: 0.02 }), run({})], { budgetUsd: 0.8 });
    expect(board.models[0]!.costUsd).toBeCloseTo(0.05 + (100 * 0.011) / 1000);
    expect(board.costUsd).toBeCloseTo(0.05 + (100 * 0.011) / 1000);
  });

  test("SRE103: an Anthropic call carries the effort option and keeps the other provider options", async () => {
    const seen: unknown[] = [];
    const mock = () => new MockLanguageModelV4({
      doGenerate: async (options) => {
        seen.push(options.providerOptions);
        return { content: [{ type: "text", text: "ok" }], finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] };
      },
    });
    const call = (model: LanguageModel, providerOptions?: Record<string, Record<string, boolean>>) => generateText({ model, prompt: "x", ...(providerOptions === undefined ? {} : { providerOptions }) });
    expect(parseArgs(["--provider", "anthropic", "--model", "claude-sonnet-5-5"]).effort).toBe("low");
    await call(withEffort(mock(), "low"));
    await call(withEffort(mock(), parseArgs(["--provider", "anthropic", "--model", "claude-sonnet-5-5", "--effort", "medium"]).effort));
    await call(withEffort(mock(), "medium"), { anthropic: { sendReasoning: false } });
    await call(mock());
    expect(seen).toEqual([{ anthropic: { effort: "low" } }, { anthropic: { effort: "medium" } }, { anthropic: { sendReasoning: false, effort: "medium" } }, undefined]);
    expect(() => parseArgs(["--provider", "anthropic", "--model", "claude-sonnet-5-5", "--effort", "max"])).toThrow(/low, medium, high/u);
  });
});
