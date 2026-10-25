/** Spec 031: old `#/…` links map to their path form before the first navigation. */
import { describe, expect, test } from "bun:test";

import { legacyHashPath } from "../src/legacy-hash";
import { testPlanRows } from "./legacy-hash.cases";
import { registerVuePlugin } from "./vue-plugin";

describe("Spec 031 legacy hash", () => {
  // `path` is in each row to show that it plays no part: the hash alone decides.
  test.each(testPlanRows)("$id: $case", (row) => {
    expect(legacyHashPath(row.hash)).toBe(row.lands);
  });

  test("U3: the mapped path resolves to the same route the hash named", async () => {
    // Route components import i18n.js and runtime-dom, which read these at import time.
    const scope = globalThis as unknown as Record<string, unknown>;
    scope.document ??= { documentElement: {}, querySelectorAll: () => [], createElement: () => ({}) };
    scope.window ??= { localStorage: { getItem: () => null, setItem: () => undefined }, navigator: { language: "en" }, dispatchEvent: () => true };
    registerVuePlugin();
    const { createRoutes } = await import("../src/routes");
    const { createMemoryHistory, createRouter } = await import("vue-router");
    const router = createRouter({ history: createMemoryHistory("/"), routes: createRoutes(() => undefined) });
    const target = legacyHashPath("#/kafka/people/github%3Am1a2st")!;
    const resolved = router.resolve(target);
    expect(resolved.name).toBe("person");
    expect(resolved.params).toEqual({ projectKey: "kafka", personId: "github:m1a2st" });
    // Positive control: an in-page anchor names no route.
    expect(legacyHashPath("#main")).toBeNull();
  });
});
