/**
 * Spec 027 B30: the core takes a `LanguageModel` and imports no provider package. The Worker half of
 * SRE57 (building the model from the `AI` binding) belongs to the wiring slice, so this test does not
 * carry the ID yet.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the core in src imports only ai, zod and its own modules", () => {
  const dir = join(import.meta.dir, "../src");
  const specifiers = [...new Bun.Glob("**/*.ts").scanSync({ cwd: dir })].flatMap((file) =>
    [...readFileSync(join(dir, file), "utf8").matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gu)].map((match) => `${file} ${match[1]}`));
  expect(specifiers.length).toBeGreaterThan(5);
  expect(specifiers.filter((value) => !/ (ai|zod|\.\/[\w.-]+)$/u.test(value))).toEqual([]);
});
