/**
 * Spec 027 B30, SRE57 (core half): the core takes a `LanguageModel` and imports no provider package
 * (`agents`, `workers-ai-provider`, `@ai-sdk/*`). The Worker half (the model built in one line from the
 * `AI` binding) is apps/data-publisher-worker/test/sre-agent-worker.test.ts.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("SRE57: the core in src imports only ai, zod and its own modules, no provider package", () => {
  const dir = join(import.meta.dir, "../src");
  const specifiers = [...new Bun.Glob("**/*.ts").scanSync({ cwd: dir })].flatMap((file) =>
    [...readFileSync(join(dir, file), "utf8").matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gu)].map((match) => `${file} ${match[1]}`));
  expect(specifiers.length).toBeGreaterThan(5);
  expect(specifiers.filter((value) => !/ (ai|zod|\.\/[\w.-]+)$/u.test(value))).toEqual([]);
});
