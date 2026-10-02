import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { canonicalDigest, canonicalJson, materializeReferenceFeed, type ReferenceMaterializationConfig } from "../src";

/** The pre-Spec 009 implementation, which built a sorted copy and one whole string. */
function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot encode non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  throw new Error(`Canonical JSON cannot encode ${typeof value}`);
}

function previousJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

describe("canonical JSON", () => {
  test("streams the same bytes and digest as the previous whole-string encoder", async () => {
    const fixture = await Bun.file(join(import.meta.dir, "fixtures", "github-events.v1.json")).json() as {
      readonly config: ReferenceMaterializationConfig;
      readonly events: readonly unknown[];
    };
    const { publication } = materializeReferenceFeed(fixture.events, fixture.config);
    const values: unknown[] = [
      publication,
      fixture.events,
      { b: 1, a: [1, "two", null, true, { z: undefined, y: -0 }], "10": "ten", "2": "two", B: "upper", "": "empty" },
      { "4294967295": "not an index", "01": "not an index", "1": "index", "…": "…", emoji: "😀" },
      [{ nested: [[], {}] }, 1.5e-7, "quote\"and\\slash\n"],
      "plain",
      42,
    ];
    for (const value of values) {
      const expected = previousJson(value);
      expect(canonicalJson(value)).toBe(expected);
      expect(canonicalDigest(value)).toBe(`sha256:${createHash("sha256").update(expected).digest("hex")}`);
    }
  });

  test("rejects values the previous encoder rejected", () => {
    for (const value of [Number.NaN, [Number.POSITIVE_INFINITY], [undefined], () => 1, { nested: 1n }]) {
      expect(() => previousJson(value)).toThrow();
      expect(() => canonicalJson(value)).toThrow();
      expect(() => canonicalDigest(value)).toThrow();
    }
  });
});
