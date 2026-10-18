/**
 * Spec 023 (DS1–DS7): the stylesheet's colour pairs, the avatar hue, the GitHub source badge, the
 * token references, and the data-viz palettes (owner's values, no aliasing of UI tokens, 3:1
 * outlines, CVD-separated areas), read from `apps/web/styles.css` without a browser. Computed
 * colours on the real page are checked in `e2e/feed-detail.spec.ts` and `e2e/people-chart.spec.ts`.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { authorHue } from "../src/avatar";
import { colourStringsIn, literalsIn, literalsInMarkup, NAMED_COLOURS } from "./css-literals";
import { contrast, deltaE2000, resolveToken, rootTokens, simulate, themeTokens, toLch, type Vision } from "./colorlib";
import { activityColourTokens, activityPalette, AREA_MIN_DELTA_E, areaTokens, authorHues, badgeStates, testPlanRows } from "./design-system.cases";
import { BADGE_STATES, badgeState } from "../src/badge-state";

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
    expect(all.find(([selector]) => selector === ".avatar")?.[1]).toMatch(/color:\s*var\(--text-on-accent\)/u);
  });
});

describe("Spec 023 source badges", () => {
  test("DS2: .src-github has one unscoped rule (slate), and only the profile header scopes the accent", () => {
    const github = rules(css).filter(([selector]) => selector.split(",").some((part) => /\.src-github\b/u.test(part)));
    const unscoped = github.filter(([selector]) => selector === ".src-github");
    expect(unscoped).toHaveLength(1);
    expect(unscoped[0]![1]).toMatch(/background:\s*var\(--source-github-tint\)/u);
    expect(unscoped[0]![1]).toMatch(/color:\s*var\(--source-github\)/u);
    expect([tokens.get("--source-github"), tokens.get("--source-github-tint")]).toEqual(["#4c4959", "#eeedf1"]);
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
  const textRows = testPlanRows.filter((row) => ["DS7", "DS8", "DS9", "DS10"].includes(row.id));

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

  // Opacity lowers the drawn contrast of any text inside without changing its token, so the pair
  // tables cannot see it. `opacity: 0` (hidden, not faded) is allowed; a rule that fades a mark
  // with no text in it goes in this list with its reason. Empty today.
  const NON_TEXT_FADES: readonly string[] = [];
  test("DS8: no rule fades an element with opacity between 0 and 1, as a number or a percentage (opacity: 0 is allowed)", () => {
    const faded = rules(css).flatMap(([selector, body]) => [...body.matchAll(/(?:^|[;\s])opacity:\s*([\d.]+)(%?)\s*(?:!important)?\s*(?:;|$)/gu)]
      .map((m) => ({ selector, value: Number(m[1]) / (m[2] === "%" ? 100 : 1) })))
      .filter(({ selector, value }) => value > 0 && value < 1 && !NON_TEXT_FADES.includes(selector));
    expect(faded).toEqual([]);
  });

  test("DS8: the opacity check catches a percentage and a number, and lets opacity: 0 through (positive control)", () => {
    const sample = ".a { opacity: 60%; }\n.b { opacity: .5; }\n.c { opacity: 0; }\n.d { opacity: 1; }\n.e { fill-opacity: 0.5; }";
    const caught = rules(sample).filter(([, body]) => [...body.matchAll(/(?:^|[;\s])opacity:\s*([\d.]+)(%?)\s*(?:!important)?\s*(?:;|$)/gu)]
      .some((m) => { const v = Number(m[1]) / (m[2] === "%" ? 100 : 1); return v > 0 && v < 1; }));
    expect(caught.map(([selector]) => selector)).toEqual([".a", ".b"]);
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
  const nonSemantic = /^--(?:data|avatar|font|series|fs|space|radius)-/u;
  const semantic = [...tokens.keys()].filter((name) => !nonSemantic.test(name));

  test("DS8: every semantic token is a role named surface, text, border, accent, brand, icon, focus-ring, shadow or source, and holds a literal", () => {
    expect(semantic.filter((name) => !/^--(?:surface|text|border|accent|brand|icon|focus-ring|shadow|source)(?:-|$)/u.test(name))).toEqual([]);
    expect(semantic.filter((name) => tokens.get(name)!.includes("var("))).toEqual([]);
  });

  test("DS8: docs/product/design-system.md lists every semantic and area token with its value, and nothing that is not defined", () => {
    const missing = [...tokens].filter(([name]) => !nonSemantic.test(name) || name.startsWith("--data-area-"))
      .filter(([name, value]) => !doc.toLowerCase().includes(`| \`${name}\` | \`${value}\``.toLowerCase()))
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

describe("Spec 023 badge states", () => {
  test("DS9: progress is wisteria (LCh hue 295–315°) and stays ΔE00 ≥ 10 from info and neutral under normal, protan and deutan vision", () => {
    const progress = colour("--text-state-progress");
    const hue = toLch(progress)[2];
    expect(hue >= 295 && hue <= 315).toBe(true);
    for (const other of ["--text-state-info", "--text-state-neutral"]) {
      for (const vision of ["normal", "protan", "deutan"] as const) {
        expect({ other, vision, apart: deltaE2000(simulate(progress, vision), simulate(colour(other), vision)) >= 10 }).toEqual({ other, vision, apart: true });
      }
    }
  });

  test.each(badgeStates)("DS9: $key is shown as $state", ({ key, state }) => {
    expect(badgeState(key)).toBe(state);
  });

  test("DS9: each of the six states has one colour rule, and no status or stage class sets a colour of its own", () => {
    const all = rules(css);
    for (const state of BADGE_STATES) {
      expect(all.filter(([selector]) => selector === `[data-state="${state}"]`)).toHaveLength(1);
    }
    const keyClass = new RegExp(`\\.(?:status|stage)-(?:${badgeStates.map(({ key }) => key).join("|")})(?![\\w-])`, "u");
    // The base classes are shape only (DS9 follow-up): a colour on them would override the state rule
    // that comes earlier in the file, as `.thread-status` once did.
    const base = /\.(?:status-badge|stage-badge|thread-status)(?![\w-])/u;
    const own = all.filter(([selector, body]) => (keyClass.test(selector) || base.test(selector)) && /(?:^|[;\s])(?:color|background(?:-color)?):/u.test(body));
    expect(own.map(([selector]) => selector)).toEqual([]);
  });
});

describe("Spec 023 colour literals", () => {
  const web = join(import.meta.dir, "..");
  // A TypeScript file that must hold colour strings goes here with its reason. Empty today.
  const TS_COLOUR_ALLOWLIST: readonly string[] = [];

  test("DS10: no colour literal in apps/web/styles.css outside the :root token blocks", () => {
    expect(literalsIn(css)).toEqual([]);
  });

  test("DS10: no colour literal in a Vue <style> block, style/fill/stroke attribute, or apps/web/index.html", async () => {
    const found: string[] = [];
    for await (const path of new Bun.Glob("src/**/*.vue").scan({ cwd: web })) {
      found.push(...literalsInMarkup(await Bun.file(join(web, path)).text()).map((hit) => `${path}: ${hit}`));
    }
    found.push(...literalsInMarkup(await Bun.file(join(web, "index.html")).text()).map((hit) => `index.html: ${hit}`));
    expect(found).toEqual([]);
  });

  test("DS10: no hex or colour-function string in apps/web/src TypeScript or Vue scripts", async () => {
    const found: string[] = [];
    for await (const path of new Bun.Glob("src/**/*.{ts,vue}").scan({ cwd: web })) {
      if (TS_COLOUR_ALLOWLIST.includes(path)) continue;
      found.push(...colourStringsIn(await Bun.file(join(web, path)).text()).map((hit) => `${path}: ${hit}`));
    }
    expect(found).toEqual([]);
  });

  test("DS10: the checks catch hex, functions and named colours, and not white-space, color-mix, tokens or :root (positive control)", () => {
    const sample = [
      ".a { color: #fff; }", ".b { box-shadow: 0 0 1px rgba(0, 0, 0, .1); }", ".c { border: 1px solid rebeccapurple; }",
      ".d { background: oklch(70% 0.1 200); }", ".e { fill: color(srgb 1 0 0); }", ".f { outline-color: lab(50% 20 30); }",
      ".g { white-space: nowrap; color: var(--text-muted); background: color-mix(in srgb, var(--x) 50%, transparent); }",
      ".h { font-family: Tan, sans-serif; }", ":root { --x: #123456; }",
    ].join("\n");
    expect(literalsIn(sample).map((hit) => hit.slice(0, 2))).toEqual([".a", ".b", ".c", ".d", ".e", ".f"]);
    expect(literalsInMarkup("<template><svg><rect fill=\"#fff\" /></svg><p style=\"color: red\"></p></template>\n<style scoped>\n.x { border: 1px solid #123456; }\n</style>"))
      .toEqual([".x { border: 1px solid #123456 }", "style=\"color: red\"", "fill=\"#fff\""]);
    expect(colourStringsIn('export const PALETTE = ["#3a53b0"];\nconst ok = "#/feed/KAFKA-1";\nconst f = `rgb(0 0 0)`;')).toEqual(['"#3a53b0"', "`rgb(0 0 0)`"]);
    expect(NAMED_COLOURS).toHaveLength(148);
  });
});

describe("Spec 023 scales", () => {
  const declarations = rules(css)
    .filter(([selector]) => !selector.startsWith(":root"))
    .flatMap(([selector, body]) => body.split(";").map((part) => part.trim()).filter((part) => part.includes(":"))
      .map((part) => ({ selector, property: part.slice(0, part.indexOf(":")).trim(), value: part.slice(part.indexOf(":") + 1).trim() })));
  // SVG text inside the donut's 42-unit viewBox is sized in user units, not CSS pixels.
  const FONT_EXEMPT = [".person-donut-total", ".person-donut-unit"];
  // The visually-hidden pattern's -1px margin is not spacing.
  const SPACE_EXEMPT = [".visually-hidden"];

  test("DS11: the type scale is eight steps and a display size (12.5px maps to 13px)", () => {
    const scale = Object.fromEntries([...tokens].filter(([name]) => name.startsWith("--fs-")));
    expect(scale).toEqual({
      "--fs-2xs": "11px", "--fs-xs": "12px", "--fs-sm": "13px", "--fs-md": "14px", "--fs-lg": "15px",
      "--fs-xl": "17px", "--fs-2xl": "22px", "--fs-3xl": "28px", "--fs-display": "clamp(24px, 4vw, 34px)",
    });
  });

  test("DS11: every font size comes from the type scale", () => {
    const off = declarations.filter(({ selector, property, value }) => property === "font-size" && !FONT_EXEMPT.includes(selector)
      && !/^var\(--fs-[\w-]+\)$|^inherit$/u.test(value));
    expect(off).toEqual([]);
  });

  test("DS11: every padding, margin and gap comes from the spacing scale (0, auto, % allowed)", () => {
    const atom = /^(?:0|auto|-?[\d.]+%|var\(--space-\d+\)|calc\(var\(--space-\d+\) \* -1\))$/u;
    const off = declarations.filter(({ selector, property, value }) => /^(?:padding|margin|gap|row-gap|column-gap)(?:-[a-z]+)?$/u.test(property)
      && !SPACE_EXEMPT.includes(selector)
      && !value.replace(/calc\(var\(--space-\d+\) \* -1\)/gu, "x").split(/\s+/u).every((part) => part === "x" || atom.test(part)));
    expect(off).toEqual([]);
    const steps = [...tokens].filter(([name]) => name.startsWith("--space-")).map(([, value]) => value);
    expect(steps).toEqual(["2px", "4px", "6px", "8px", "10px", "12px", "14px", "16px", "20px", "24px", "28px", "32px", "40px", "48px", "64px", "96px"]);
  });

  test("DS11: every border radius comes from the radius scale (or 50% for a circle)", () => {
    const off = declarations.filter(({ property, value }) => /^border(?:-[a-z]+)*-radius$/u.test(property)
      && !value.split(/\s+/u).every((part) => /^(?:0|50%|var\(--radius-(?:xs|sm|md|lg|xl|pill)\))$/u.test(part)));
    expect(off).toEqual([]);
  });
});
