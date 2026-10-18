/**
 * Spec 024 (DM1, DM3–DM9): the dark theme, read from `apps/web/styles.css`, `apps/web/index.html`
 * and `docs/product/design-system.md` without a browser. First paint, the OS preference and the
 * page layout in both themes are checked in `e2e/dark-theme.spec.ts`.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { contrast, deltaE2000, resolveToken, rootTokens, simulate, themeTokens, toLch, type Vision } from "./colorlib";
import { THEME_INVARIANT, testPlanRows, themeResolution } from "./dark-theme.cases";

const web = join(import.meta.dir, "..");
const css = await Bun.file(join(web, "styles.css")).text();
const html = await Bun.file(join(web, "index.html")).text();
const doc = await Bun.file(join(web, "..", "..", "docs", "product", "design-system.md")).text();
const themes = { light: themeTokens(css, "light"), dark: themeTokens(css, "dark") };
const colour = (value: string, theme: "light" | "dark") => (value.startsWith("--") ? resolveToken(themes[theme], `var(${value})`) : value);
const clean = css.replace(/\/\*[\s\S]*?\*\//gu, "");
const darkBlocks = [...clean.matchAll(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/gu)].map((m) => m[1]!);
const darkNames = new Set(darkBlocks.flatMap((body) => [...body.matchAll(/(--[\w-]+)\s*:/gu)].map((m) => m[1]!)));
const light = rootTokens(css);
const round = (value: number) => Math.round(value * 100) / 100;

describe("Spec 024 colour pairs in both themes", () => {
  test.each(testPlanRows)("$id: $pair is $light:1 light and $dark:1 dark (≥ $min)", (row) => {
    const lightRatio = contrast(colour(row.foreground, "light"), colour(row.background, "light"));
    const darkRatio = contrast(colour(row.foreground, "dark"), colour(row.background, "dark"));
    expect([round(lightRatio), round(darkRatio)]).toEqual([row.light, row.dark]);
    expect(darkRatio).toBeGreaterThanOrEqual(row.min);
  });
});

describe("Spec 024 tokens", () => {
  test("DM4: every :root token has a dark value or is theme-invariant, and the dark blocks define nothing else", () => {
    const missing = [...light.keys()].filter((name) => !darkNames.has(name) && !THEME_INVARIANT.some((pattern) => pattern.test(name)));
    expect(missing).toEqual([]);
    expect([...darkNames].filter((name) => !light.has(name))).toEqual([]);
  });

  test("DM4: dark values are literals, like the light ones", () => {
    expect([...darkNames].filter((name) => themes.dark.get(name)!.includes("var("))).toEqual([]);
  });

  test("DM5: dark progress (wisteria) stays ΔE00 ≥ 10 from info and neutral under normal, protan and deutan vision", () => {
    const progress = colour("--text-state-progress", "dark");
    const hue = toLch(progress)[2];
    expect(hue >= 295 && hue <= 315).toBe(true);
    for (const other of ["--text-state-info", "--text-state-neutral"]) {
      for (const vision of ["normal", "protan", "deutan"] as const) {
        const apart = deltaE2000(simulate(progress, vision), simulate(colour(other, "dark"), vision));
        expect({ other, vision, apart: apart >= 10 }).toEqual({ other, vision, apart: true });
      }
    }
  });

  test("DM7: the chart tooltip sits on --surface-popover, the highest dark layer", () => {
    expect(/\.person-chart-tip \{[^}]*background: var\(--surface-popover\)/u.test(clean)).toBe(true);
    const lightness = (name: string) => toLch(colour(name, "dark"))[0];
    const layers = ["--surface-inverse", "--surface-page", "--surface-sunken", "--surface-card", "--surface-chip", "--surface-popover"];
    const order = layers.map(lightness);
    expect(order.every((value, index) => index === 0 || value >= order[index - 1]!)).toBe(true);
    expect(colour("--surface-popover", "light")).toBe(colour("--surface-inverse", "light"));
  });

  test("DM8: color-scheme follows the theme, and theme-color has a light and a dark entry", () => {
    expect(/:root \{\s*color-scheme: light;/u.test(clean)).toBe(true);
    expect(darkBlocks.some((body) => /color-scheme: dark;/u.test(body))).toBe(true);
    expect(html).toContain('<meta name="theme-color" media="(prefers-color-scheme: light)" content="#16161a" />');
    expect(html).toContain('<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#101013" />');
  });
});

describe("Spec 024 dark area palette", () => {
  const areas = ["--data-area-1", "--data-area-2", "--data-area-3", "--data-area-4", "--data-area-5", "--data-area-6", "--data-area-other"];
  const activity = ["--data-given-stroke", "--data-github-stroke", "--data-received-stroke", "--data-jira-stroke", "--data-mail-stroke", "--data-unrecorded-line"];

  test.each(["normal", "protan", "deutan"] as const)("DM6: every pair of dark area colours is at least ΔE00 10 apart (%s vision)", (vision: Vision) => {
    const values = areas.map((name) => colour(name, "dark"));
    const close: string[] = [];
    for (let i = 0; i < values.length; i += 1) {
      for (let j = i + 1; j < values.length; j += 1) {
        const distance = deltaE2000(simulate(values[i]!, vision), simulate(values[j]!, vision));
        if (distance < 10) close.push(`${areas[i]} ${areas[j]} ${distance.toFixed(1)}`);
      }
    }
    expect(close).toEqual([]);
  });

  test("DM6: the dark area colours are not orange, ≥ 3:1 on the dark card, and ΔE00 ≥ 10 from every dark activity colour", () => {
    for (const area of areas) {
      const value = colour(area, "dark");
      const [, chroma, hue] = toLch(value);
      expect({ area, orange: chroma > 15 && hue >= 30 && hue <= 85 }).toEqual({ area, orange: false });
      expect(contrast(value, colour("--surface-card", "dark"))).toBeGreaterThanOrEqual(3);
      for (const series of activity) {
        expect({ area, series, apart: deltaE2000(value, colour(series, "dark")) >= 10 }).toEqual({ area, series, apart: true });
      }
    }
  });
});

/** Runs the inline theme script of index.html against a fake document, storage and media query. */
function runThemeScript(storedChoice: string, osDark: boolean, storage: "ok" | "throws") {
  const stored = storedChoice === "none" ? null : storedChoice;
  const script = /<script>\s*([\s\S]*?)<\/script>/u.exec(html)?.[1];
  if (script === undefined) throw new Error("no inline theme script in index.html");
  const listeners: (() => void)[] = [];
  const query = { matches: osDark, addEventListener: (_: string, listener: () => void) => listeners.push(listener) };
  let value = stored;
  const localStorage = {
    getItem: () => { if (storage === "throws") throw new Error("SecurityError"); return value; },
  };
  const document = { documentElement: { dataset: {} as Record<string, string> } };
  const window = { localStorage, matchMedia: () => query };
  new Function("window", "document", script)(window, document);
  return {
    theme: () => document.documentElement.dataset.theme,
    setOs: (dark: boolean) => { query.matches = dark; for (const listener of listeners) listener(); },
    setStored: (next: string | null) => { value = next; },
  };
}

describe("Spec 024 theme resolution (the inline script)", () => {
  test.each(themeResolution)("DM1, DM3: stored $stored, OS dark $osDark, storage $storage → $theme", ({ stored, osDark, storage, theme }) => {
    expect(runThemeScript(stored, osDark, storage).theme()).toBe(theme);
  });

  test("DM1: with no stored choice the theme follows a live OS change; a stored choice does not", () => {
    const following = runThemeScript("none", false, "ok");
    following.setOs(true);
    expect(following.theme()).toBe("dark");
    following.setOs(false);
    expect(following.theme()).toBe("light");
    const pinned = runThemeScript("light", false, "ok");
    pinned.setOs(true);
    expect(pinned.theme()).toBe("light");
  });

  test("DM1: the script runs before the stylesheet and the app (blocking, not a module)", () => {
    const script = html.indexOf("<script>");
    expect(script).toBeGreaterThan(0);
    expect(script).toBeLessThan(html.indexOf("<link"));
    expect(script).toBeLessThan(html.indexOf('<script type="module"'));
  });
});

describe("Spec 024 design-system page", () => {
  test("DM9: every token with a dark value is listed with its light and dark value", () => {
    const missing = [...darkNames].filter((name) => !name.startsWith("--data-") || name.startsWith("--data-area-") || name.startsWith("--data-bar-"))
      .filter((name) => !doc.toLowerCase().includes(`| \`${name}\` | \`${light.get(name)}\` | \`${themes.dark.get(name)}\``.toLowerCase()))
      .map((name) => `${name} ${light.get(name)} → ${themes.dark.get(name)}`);
    expect(missing).toEqual([]);
  });
});
