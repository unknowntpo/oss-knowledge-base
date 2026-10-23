/**
 * Workers Logs: both deployed configurations keep every invocation's console output (100% head
 * sampling), so every console call must log error text only through the sanitizer.
 */
import { describe, expect, test } from "bun:test";

const read = async (path: string) => Bun.file(new URL(`../${path}`, import.meta.url)).text();

/**
 * A log call: `console.*`, or Spec 028's `runLog(context, level, message)` and a run's
 * `log(level, message)`, which reach the console with the same text.
 */
const LOG_CALL = /console\.(log|error|warn|info|debug)\(|\brunLog\(|\blog\("(log|error)",/u;

/** A console call that interpolates an error's raw text instead of `errorText`/`sanitizeErrorMessage`. */
function rawErrorLog(line: string): boolean {
  return LOG_CALL.test(line) &&
    /\b(error|err|e)\.message\b|String\((error|err|e)\)|\$\{error\}|\$\{err\}/u.test(line) &&
    !/errorText\(|sanitizeErrorMessage\(/u.test(line);
}

describe("Workers Logs", () => {
  test("Dev and Prod Worker configurations enable observability at 100% head sampling", async () => {
    for (const name of ["wrangler.development.jsonc", "wrangler.production.jsonc"]) {
      const config = JSON.parse(await read(name)) as { observability?: unknown };
      expect(config.observability).toEqual({ enabled: true, head_sampling_rate: 1 });
    }
  });

  test("no console call in the Worker or the semantic package logs raw error text", async () => {
    // Positive control: the line this rule replaced is flagged; its sanitized form is not.
    expect(rawErrorLog("console.error(`Scheduling failed: ${error instanceof Error ? error.message : String(error)}`)")).toBe(true);
    expect(rawErrorLog("console.error(`Scheduling failed: ${errorText(error)}`)")).toBe(false);
    // Spec 028: the run loggers are log calls too.
    expect(rawErrorLog("runLog(context, \"error\", `failed: ${error}`)")).toBe(true);
    expect(rawErrorLog("log(\"error\", `failed: ${String(error)}`)")).toBe(true);
    const offending: string[] = [];
    let calls = 0;
    for (const root of ["src", "../../packages/semantic-vectorize/src"]) {
      for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: new URL(`../${root}`, import.meta.url).pathname })) {
        const lines = (await read(`${root}/${path}`)).split("\n");
        lines.forEach((line, index) => {
          if (LOG_CALL.test(line)) calls += 1;
          if (rawErrorLog(line)) offending.push(`${root}/${path}:${index + 1}`);
        });
      }
    }
    expect(calls).toBeGreaterThanOrEqual(9);
    expect(offending).toEqual([]);
  });
});
