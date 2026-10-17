/**
 * Spec 023 (DS1–DS3): the stylesheet's colour pairs, the avatar hue, the GitHub source badge and
 * the token references, read from `apps/web/styles.css` without a browser. The computed colours on
 * the real page are checked in `e2e/feed-detail.spec.ts`.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { authorHue } from "../src/avatar";
import { contrast, resolveToken, rootTokens } from "./colorlib";
import { authorHues, testPlanRows } from "./design-system.cases";

const css = await Bun.file(join(import.meta.dir, "..", "styles.css")).text();
const tokens = rootTokens(css);
const colour = (value: string) => (value.startsWith("--") ? resolveToken(tokens, `var(${value})`) : value);

/** Rules as `[selector, body]`, comments removed, at any nesting level. */
function rules(source: string): [string, string][] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//gu, "");
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((m) => [m[1]!.trim(), m[2]!]);
}

describe("Spec 023 colour pairs", () => {
  test.each(testPlanRows)("$id: $pair is $ratio:1 (≥ $min)", (row) => {
    const measured = contrast(colour(row.foreground), colour(row.background));
    expect(Math.round(measured * 100) / 100).toBe(row.ratio);
    expect(measured).toBeGreaterThanOrEqual(row.min);
  });
});

describe("Spec 023 avatars", () => {
  test.each(authorHues)("DS1: authorHue($author) is $hue, stable and within the six avatar tokens", ({ author, hue }) => {
    expect(authorHue(author)).toBe(hue);
    expect(authorHue(author)).toBe(authorHue(author));
  });

  test("DS1: every hue has an avatar rule painting its token, and .avatar draws white initials", () => {
    const all = rules(css);
    for (let hue = 1; hue <= 6; hue += 1) {
      const rule = all.find(([selector]) => selector === `.avatar[data-hue="${hue}"]`);
      expect(rule?.[1]).toContain(`background: var(--avatar-${hue})`);
      expect(tokens.has(`--avatar-${hue}`)).toBe(true);
    }
    for (const name of ["", "x", "Ada Lovelace", "李小龍", "a".repeat(200)]) {
      expect(authorHue(name)).toBeGreaterThanOrEqual(1);
      expect(authorHue(name)).toBeLessThanOrEqual(6);
    }
    expect(all.find(([selector]) => selector === ".avatar")?.[1]).toMatch(/color:\s*#fff\b/u);
  });
});

describe("Spec 023 source badges", () => {
  test("DS2: .src-github has one unscoped rule (slate), and only the profile header scopes the accent", () => {
    const github = rules(css).filter(([selector]) => selector.split(",").some((part) => /\.src-github\b/u.test(part)));
    const unscoped = github.filter(([selector]) => selector === ".src-github");
    expect(unscoped).toHaveLength(1);
    expect(unscoped[0]![1]).toMatch(/background:\s*#eeedf1/u);
    expect(unscoped[0]![1]).toMatch(/color:\s*#4c4959/u);
    expect(github.map(([selector]) => selector).sort()).toEqual([".person-meta .src-github", ".src-github"]);
  });
});

describe("Spec 023 token references", () => {
  const referenced = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/gu)].map((m) => m[1]!));
  const defined = new Set([...css.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/gmu)].map((m) => m[1]!));

  test("DS3: every var(--x) in styles.css names a defined custom property", () => {
    expect([...referenced].filter((name) => !defined.has(name))).toEqual([]);
  });

  test("DS3: every custom property defined in styles.css is referenced", () => {
    expect([...defined].filter((name) => !referenced.has(name))).toEqual([]);
  });
});
