/**
 * Spec 023 (DS1–DS7): the stylesheet's colour pairs, the avatar hue, the GitHub source badge, the
 * token references, and the data-viz palettes (owner's values, no aliasing of UI tokens, 3:1
 * outlines, CVD-separated areas), read from `apps/web/styles.css` without a browser. Computed
 * colours on the real page are checked in `e2e/feed-detail.spec.ts` and `e2e/people-chart.spec.ts`.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { authorHue } from "../src/avatar";
import { contrast, deltaE2000, resolveToken, rootTokens, simulate, themeTokens, toLch, type Vision } from "./colorlib";
import { activityColourTokens, activityPalette, AREA_MIN_DELTA_E, areaTokens, authorHues, testPlanRows } from "./design-system.cases";

const css = await Bun.file(join(import.meta.dir, "..", "styles.css")).text();
const tokens = rootTokens(css);
const themes = { light: themeTokens(css, "light"), dark: themeTokens(css, "dark") };
const colour = (value: string, theme: "light" | "dark" = "light") =>
  (value.startsWith("--") ? resolveToken(themes[theme], `var(${value})`) : value);

/** Rules as `[selector, body]`, comments removed, at any nesting level. */
function rules(source: string): [string, string][] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//gu, "");
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((m) => [m[1]!.trim(), m[2]!]);
}

describe("Spec 023 colour pairs", () => {
  test.each(testPlanRows)("$id: $pair is $ratio:1 (≥ $min)", (row) => {
    const measured = contrast(colour(row.foreground, row.theme), colour(row.background, row.theme));
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

describe("Spec 023 data-viz palettes", () => {
  test.each(["light", "dark"] as const)("DS4: the activity series are the owner's 方案二 values (%s)", (theme) => {
    const actual = Object.fromEntries(Object.keys(activityPalette[theme]).map((name) => [name, themes[theme].get(name)?.toLowerCase()]));
    expect(actual).toEqual(activityPalette[theme]);
  });

  test("DS4: no data token aliases another token (a hover, tint, border or muted change cannot recolour a chart)", () => {
    for (const theme of ["light", "dark"] as const) {
      const aliased = [...themes[theme]].filter(([name, value]) => name.startsWith("--data-") && /var\(/u.test(value));
      expect(aliased).toEqual([]);
    }
  });

  test("DS4: chart marks, legend, tile and tooltip swatches, hatch and donut take their colours from --data-* tokens only", () => {
    const chartRules = rules(css).filter(([selector]) =>
      /\[data-series|person-hatch|person-swatch-hatch|person-donut-slice|person-swatch\[data-color/u.test(selector) && !selector.startsWith(":root"));
    expect(chartRules.length).toBeGreaterThan(0);
    for (const [selector, body] of chartRules) {
      const refs = [...body.matchAll(/var\((--[\w-]+)\)/gu)].map((m) => m[1]!);
      expect({ selector, refs: refs.filter((name) => !name.startsWith("--data-") && !name.startsWith("--series-")) }).toEqual({ selector, refs: [] });
      expect({ selector, literal: /#[0-9a-f]{3,8}\b|rgba?\(/iu.test(body) }).toEqual({ selector, literal: false });
    }
  });

  const orange = (hex: string) => {
    const [, chroma, hue] = toLch(hex);
    return chroma > 15 && hue >= 30 && hue <= 85;
  };

  test("DS6: no data colour is orange (LCh hue 30–85° with chroma above 15)", () => {
    for (const theme of ["light", "dark"] as const) {
      const colours = [...themes[theme]].filter(([name, value]) => name.startsWith("--data-") && value.startsWith("#"));
      expect(colours.filter(([, value]) => orange(value))).toEqual([]);
    }
  });

  test.each(["normal", "protan", "deutan"] as const)("DS6: every pair of area colours is at least ΔE00 10 apart (%s vision)", (vision: Vision) => {
    const values = areaTokens.map((name) => colour(name));
    const close: string[] = [];
    for (let i = 0; i < values.length; i += 1) {
      for (let j = i + 1; j < values.length; j += 1) {
        const distance = deltaE2000(simulate(values[i]!, vision), simulate(values[j]!, vision));
        if (distance < AREA_MIN_DELTA_E) close.push(`${areaTokens[i]} ${areaTokens[j]} ${distance.toFixed(1)}`);
      }
    }
    expect(close).toEqual([]);
  });

  test("DS6: no area colour comes within ΔE00 10 of an activity-chart colour on the same page", () => {
    const close = areaTokens.flatMap((area) => activityColourTokens
      .map((series) => ({ area, series, distance: deltaE2000(colour(area), colour(series)) }))
      .filter((pair) => pair.distance < AREA_MIN_DELTA_E));
    expect(close).toEqual([]);
  });
});

describe("Spec 023 text contrast", () => {
  const textRows = testPlanRows.filter((row) => row.id === "DS7" || row.id === "DS8");

  test.each(textRows)("$id: $pair is drawn in $foreground", (row) => {
    const property = row.pair.endsWith(":focus-visible") ? "outline-color" : "color";
    // The last declaration in source order wins (all these rules have the same specificity per selector).
    const declared = rules(css)
      .filter(([selector]) => selector.split(",").map((part) => part.trim()).includes(row.pair))
      .map(([, body]) => new RegExp(`(?:^|[;\\s{])${property}:\\s*([^;]+);`, "u").exec(body)?.[1]?.trim())
      .filter((value) => value !== undefined)
      .at(-1);
    expect(declared).toBe(row.foreground.startsWith("--") ? `var(${row.foreground})` : row.foreground);
  });

  test("DS7: no rule sets text in a colour below the text floor (--muted-3, --muted-4, --dark-muted-2, brand orange)", () => {
    const weak = rules(css).filter(([, body]) => /(?:^|[;\s])color:\s*var\(--(?:muted-3|muted-4|dark-muted-2|brand-orange|brand)\)/u.test(body));
    expect(weak.map(([selector]) => selector)).toEqual([]);
  });

  test("DS8: no rule fades an element with opacity below 1 (text inside would drop below its pair; use a solid colour)", () => {
    const faded = rules(css).filter(([, body]) => /(?:^|[;\s])opacity:\s*(?:0?\.\d+|0)\s*(?:;|$)/u.test(body));
    expect(faded.map(([selector]) => selector)).toEqual([]);
  });
});

describe("Spec 023 colour-mix fallback", () => {
  test("DS4: every color-mix() declaration follows a plain declaration of the same property", () => {
    const mixed = rules(css).flatMap(([selector, body]) => [...body.matchAll(/([\w-]+):\s*color-mix\(/gu)].map((m) => ({ selector, body, property: m[1]! })));
    expect(mixed.length).toBeGreaterThan(0);
    for (const { selector, body, property } of mixed) {
      const declarations = body.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${property}:`));
      expect({ selector, first: declarations[0]?.includes("color-mix(") }).toEqual({ selector, first: false });
    }
  });
});

const repo = join(import.meta.dir, "..", "..", "..");
const doc = await Bun.file(join(repo, "docs", "product", "design-system.md")).text();
const constitution = await Bun.file(join(repo, "docs", "constitution.md")).text();

describe("Spec 023 semantic layer", () => {
  const nonSemantic = /^--(?:data|avatar|font|series)-/u;
  const semantic = [...tokens.keys()].filter((name) => !nonSemantic.test(name));

  test("DS8: every semantic token is a role named surface, text, border, accent, brand, icon or focus-ring, and holds a literal", () => {
    expect(semantic.filter((name) => !/^--(?:surface|text|border|accent|brand|icon|focus-ring)(?:-|$)/u.test(name))).toEqual([]);
    expect(semantic.filter((name) => tokens.get(name)!.includes("var("))).toEqual([]);
  });

  test("DS8: docs/product/design-system.md lists every semantic and area token with its value, and nothing that is not defined", () => {
    const missing = [...tokens].filter(([name]) => !nonSemantic.test(name) || name.startsWith("--data-area-"))
      .filter(([name, value]) => !new RegExp(`\\| \`${name}\` \\| \`${value}\``, "iu").test(doc))
      .map(([name, value]) => `${name} ${value}`);
    expect(missing).toEqual([]);
    const listed = [...doc.matchAll(/^\| `(--[\w-]+)` \|/gmu)].map((m) => m[1]!);
    expect(listed.filter((name) => !tokens.has(name))).toEqual([]);
  });

  test("DS8: constitution §6 links the design system", () => {
    const section = constitution.slice(constitution.indexOf("## 6."), constitution.indexOf("## 7."));
    expect(section).toContain("(product/design-system.md)");
  });
});
