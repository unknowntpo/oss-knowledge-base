/** Spec 014: the offline `digest` command prints eval and measure reports from the committed fixture. */
import { expect, test } from "bun:test";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "..", "packages", "reference-pipeline", "scripts", "digest.ts");

function run(mode: string) {
  const result = Bun.spawnSync(["bun", script, mode], { stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString() };
}

test("D33: `digest -- eval` prints the golden-set report for the committed fixture", () => {
  const { code, out } = run("eval");
  expect(code).toBe(0);
  const report = JSON.parse(out);
  expect(report.candidates).toBe(234);
  expect(report.recall).toBe("pending human labels");
  expect(report.errorClasses["status-mismatch"]).toEqual({ fixtures: 2, rejectedByRules: 2 });
});

test("D25 D26: `digest -- measure` reports cold and steady budgets within their limits", () => {
  const { code, out } = run("measure");
  expect(code).toBe(0);
  const report = JSON.parse(out);
  expect(report.ok).toBe(true);
  expect(report.cold.modelCalls).toBeLessThanOrEqual(45);
});

test("an unknown mode exits with usage", () => {
  expect(run("dry-run").code).toBe(2);
});
