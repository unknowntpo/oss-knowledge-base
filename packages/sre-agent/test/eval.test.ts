/**
 * Spec 027 Amendment (2) L2: the grader self-test on the eval fixtures (SRE60, eval.cases.ts) and the
 * L3 harness's own logic (graders, scoreboard, cost meter), all with `MockLanguageModelV4`. No
 * network, $0. The L3 eval itself (SRE59) runs the same harness against Workers AI, locally.
 */
import { describe, expect, test } from "bun:test";
import { EVAL_CASES, type EvalCase } from "../scripts/eval/cases";
import { CostMeter, evalLibrary, goldenModel, grade, pickWinner, renderScoreboard, runCase, scoreboard, type CaseRun } from "../scripts/eval/harness";
import type { Bundle } from "../src";
import { testPlanRows } from "./eval.cases";

const library = evalLibrary();
const caseOf = (scenario: string): EvalCase => {
  const found = EVAL_CASES.find((value) => value.scenario === scenario);
  if (found === undefined) throw new Error(`no fixture for ${scenario}`);
  return found;
};
const golden = (value: EvalCase, mutate?: Parameters<typeof goldenModel>[2]) =>
  runCase({ evalCase: value, modelId: "golden", library, model: (bundle) => goldenModel(value, bundle, mutate), run: 1 });

/** Grader mutation controls (eval.cases.ts rows with source "control"). */
const controls: Record<string, (value: EvalCase) => Promise<void>> = {
  async "grader control M11"(value) {
    const result = await golden(value, { alterQuote: 0 });
    expect(result.grade.missing).toEqual(["lastRun.r2.classA"]);
    expect(result.grade.fabricated).toBe(true);
    expect(result.grade.pass).toBe(false);
  },
  async "grader control M14"(value) {
    const answer = caseOf("r2-class-a-spike-2026-10-13").golden!;
    const output = { ...answer, evidence: [{ id: "E1", quote: "x" }] };
    const graded = grade(value, { items: [], causes: new Set(["unknown"]), runbooks: new Set() } as unknown as Bundle, [], output, library);
    expect(graded.pass).toBe(false);
  },
  async "grader control M15"(value) {
    const result = await golden(value, { runbook: "cloudflare-data-publisher.md#follow-up-runs-spec-018" });
    expect(result.grade.anchor).toBe(true);
    expect(result.grade.pass).toBe(true);
  },
};

describe("Spec 027 L2: eval fixtures and graders", () => {
  test("eval harness: every control row has its control", () => {
    expect(testPlanRows.filter((row) => row.source === "control" && controls[row.type] === undefined)).toEqual([]);
  });

  test("eval harness: every eval.cases.ts row has one fixture, and every fixture a row", () => {
    const fixtures = testPlanRows.filter((row) => row.source !== "control");
    expect(EVAL_CASES.map((value) => value.scenario).sort()).toEqual(fixtures.map((row) => row.scenario).sort());
    for (const row of fixtures) {
      const value = caseOf(row.scenario);
      expect(value.expected === null).toBe(row.trigger === "none");
      if (value.expected !== null) expect(value.expected.cause).toBe(row.cause);
    }
  });

  test.each(testPlanRows)("$id: $type, $scenario: passes every grader with its golden answer and fails with the cause swapped, one quote altered or a wrong anchor (negative controls)", async (row) => {
    const value = caseOf(row.scenario);
    if (row.source === "control") {
      await controls[row.type]!(value);
      return;
    }
    const result = await golden(value);
    expect(result.grade.pass).toBe(true);
    if (row.trigger === "none") {
      expect(result.called).toBe(false);
      expect(result.modelCalls).toBe(0);
      return;
    }
    expect(result.called).toBe(true);
    expect(result.verdict).not.toBe("unverified");
    expect(result.grade).toMatchObject({ cause: true, evidence: true, anchor: true, fabricated: false });
    const swapped = await golden(value, { cause: "unknown" });
    expect(swapped.grade.cause).toBe(false);
    expect(swapped.grade.pass).toBe(false);
    const altered = await golden(value, { alterQuote: 0 });
    expect(altered.grade.evidence).toBe(false);
    expect(altered.grade.fabricated).toBe(true);
    expect(altered.grade.pass).toBe(false);
    const anchor = await golden(value, { runbook: "cloudflare-data-publisher.md#turn-off" });
    expect(anchor.grade.anchor).toBe(false);
    expect(anchor.grade.pass).toBe(false);
  });

  test("eval harness: a required evidence item must be quoted, not only a valid quote of something else", async () => {
    const value = caseOf("r2-class-a-spike-2026-10-13");
    const result = await golden(value, { dropEvidence: 1 });
    expect(result.grade.fabricated).toBe(false);
    expect(result.grade.evidence).toBe(false);
    expect(result.grade.missing).toEqual(["copiedObjectCount"]);
  });

  test("eval harness: every required item quoted is not enough when another quote is fabricated", async () => {
    const result = await golden(caseOf("dev-stall-2026-10-02"), { extraFabricated: true });
    expect(result.grade.missing).toEqual([]);
    expect(result.grade.fabricated).toBe(true);
    expect(result.grade.evidence).toBe(false);
    expect(result.verdict).toBe("unverified");
  });
});

const run = (modelId: string, over: Partial<CaseRun>): CaseRun => ({
  scenario: "s", modelId, run: 1, called: true, firings: 1, verdict: "explained", reason: null, cause: "c", runbook: null,
  evidence: [], evidenceFailures: [], tools: [], steps: 2, modelCalls: 2, inputTokens: 1000, outputTokens: 100,
  neurons: 100, neuronsReported: 100, latencyMs: 1000,
  grade: { cause: true, evidence: true, anchor: true, fabricated: false, pass: true, missing: [] },
  ...over,
});

describe("Spec 027 L3 harness: scoreboard and cost meter", () => {
  test("eval harness: the scoreboard gives per model pass, cause, evidence, anchor, fabrication, failures, neurons and latency", () => {
    const board = scoreboard([
      run("a", {}),
      run("a", { grade: { cause: false, evidence: true, anchor: true, fabricated: false, pass: false, missing: [] }, neurons: 300, neuronsReported: 300, latencyMs: 3000 }),
      run("a", { verdict: "unverified", grade: { cause: true, evidence: false, anchor: true, fabricated: true, pass: false, missing: [] } }),
      run("a", { verdict: "inconclusive", reason: "malformed", cause: null, modelCalls: 1, grade: { cause: false, evidence: false, anchor: false, fabricated: false, pass: false, missing: [] } }),
      run("a", { called: false, firings: 0, modelCalls: 0, neurons: 0, neuronsReported: 0, latencyMs: 1 }),
    ], { budgetUsd: 1.29 });
    const a = board.models[0]!;
    expect(a).toMatchObject({ modelId: "a", runs: 5, diagnoses: 4, passed: 2, causeCorrect: 2, evidenceOk: 2, anchorOk: 3, fabricated: 1, failures: { malformed: 1 }, noCallPassed: 1, noCallRuns: 1 });
    expect(a.passRate).toBeCloseTo(2 / 5);
    expect(a.fabricationRate).toBeCloseTo(1 / 3); // of the diagnoses with an output
    expect(a.neuronsPerDiagnosis).toBeCloseTo((100 + 300 + 100 + 100) / 4);
    expect(a.latencyMsMean).toBeCloseTo((1000 + 3000 + 1000 + 1000) / 4);
    expect(a.costUsd).toBeCloseTo(600 * 0.011 / 1000);
    expect(renderScoreboard(board)).toContain("| a |");
    expect(renderScoreboard(board)).toContain("$1.29");
    expect(renderScoreboard(scoreboard([run("a", {})], { budgetUsd: 1.285 }))).toContain("$1.285");
  });

  test("eval harness: the winner has the highest pass rate, then the lowest fabrication rate, then the fewest neurons", () => {
    const board = scoreboard([
      run("cheap", { neurons: 50, neuronsReported: 50 }),
      run("costly", { neurons: 500, neuronsReported: 500 }),
      run("wrong", { grade: { cause: false, evidence: true, anchor: true, fabricated: false, pass: false, missing: [] } }),
    ], { budgetUsd: 1.29 });
    expect(pickWinner(board.models)?.modelId).toBe("cheap");
  });

  test("eval harness: the cost meter refuses a diagnosis that could pass the budget (1,500 neurons each at most)", () => {
    const meter = new CostMeter(0.02); // 1,818 neurons; the worst diagnosis is 1,500 neurons, $0.0165
    expect(meter.worstDiagnosisUsd).toBeCloseTo(1500 * 0.011 / 1000);
    expect(meter.canStart()).toBe(true);
    meter.add(400 * 0.011 / 1000);
    expect(meter.canStart()).toBe(false);
    expect(meter.spentUsd).toBeCloseTo(400 * 0.011 / 1000);
  });

  test("eval harness: a diagnosis is capped at the production 1,500 neurons, so a runaway model fails with reason budget", async () => {
    const value = caseOf("r2-class-a-spike-2026-10-13");
    // An unlisted model id is charged at the highest rates; a long prompt per call reaches the cap within 12 steps.
    const result = await runCase({ evalCase: value, modelId: "@cf/unlisted", library, model: (bundle) => goldenModel(value, bundle, { loopTool: true }), run: 1 });
    expect(result.reason).toBe("budget");
    expect(result.grade.pass).toBe(false);
  });
});
