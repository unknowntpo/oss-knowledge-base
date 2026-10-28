/**
 * Spec 014 D109–D112: the reusable experimental label (`apps/web/src/experimental.ts`,
 * `components/ExperimentalLabel.vue`), rendered server-side in Bun like `digest-ui.test.ts`, and its
 * colour tokens read from `apps/web/styles.css`. Browser checks (Proposals tab, All threads, dark
 * theme computed colours) live in `e2e/digest.spec.ts`.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import enFixture from "./fixtures/digest/apache-kafka.en.json";
import zhFixture from "./fixtures/digest/apache-kafka.zh-Hant.json";
import { contrast, hexToRgb, resolveToken, rgbToHex, themeTokens, toLch } from "./colorlib";
import { registerVuePlugin } from "./vue-plugin";

type ServedDigest = import("../src/digest-view").ServedDigest;
const en = enFixture as unknown as ServedDigest;
const zh = zhFixture as unknown as ServedDigest;
const NOW = Date.parse("2026-10-07T03:37:00.000Z");
const scope = globalThis as unknown as Record<string, unknown>;

let render: (component: unknown, props: Record<string, unknown>, locale?: string) => Promise<string>;
let components: { DigestWeek: unknown; TopicPage: unknown; ExperimentalLabel: unknown };
let experimental: typeof import("../src/experimental");
let kafka: () => { readonly profile: unknown };

beforeAll(async () => {
  scope.document = { documentElement: {}, querySelectorAll: () => [], createElement: () => ({}) };
  scope.window ??= { localStorage: { getItem: () => null, setItem: () => undefined }, navigator: { language: "en" }, dispatchEvent: () => true };
  scope.history ??= { state: null, replaceState: () => undefined, pushState: () => undefined };
  registerVuePlugin();
  await import("../i18n.js");
  const { useI18n } = await import("../src/i18n");
  const view = await import("../src/digest-view");
  kafka = () => view.projectByKey("kafka")!;
  experimental = await import("../src/experimental");
  components = {
    DigestWeek: (await import("../src/components/digest/DigestWeek.vue")).default,
    TopicPage: (await import("../src/components/digest/TopicPage.vue")).default,
    ExperimentalLabel: (await import("../src/components/ExperimentalLabel.vue")).default,
  };
  const { createSSRApp, h } = await import("vue");
  const { renderToString } = await import("vue/server-renderer");
  const { createMemoryHistory, createRouter } = await import("vue-router");
  render = async (component, props, locale = "en") => {
    useI18n().setLocale(locale);
    const app = createSSRApp({ render: () => h(component as never, props) });
    app.use(createRouter({ history: createMemoryHistory("/"), routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }] }));
    return renderToString(app);
  };
});

const BADGE = { en: "Experimental · Early access", "zh-Hant": "實驗中・搶先體驗" } as const;
const NOTE = {
  en: "AI-written summaries, still being evaluated. The Chinese version is machine-translated and still being checked.",
  "zh-Hant": "摘要由 AI 撰寫，品質仍在評估中；中文為機器翻譯，仍在校對。",
} as const;

function labels(html: string): string[] {
  return [...html.matchAll(/<p class="experimental-label"[^>]*>[\s\S]*?<\/p>/gu)].map((match) => match[0]);
}

describe("Spec 014 experimental label", () => {
  test.each(["en", "zh-Hant"] as const)("D109: This week and the topic page show the digest's experimental label in %s", async (locale) => {
    const digest = locale === "en" ? en : zh;
    const week = await render(components.DigestWeek, { digest, profile: kafka().profile, projectName: "Apache Kafka", now: NOW }, locale);
    const card = digest.cards.find((item) => item.status === "generated")!;
    const topic = await render(components.TopicPage, { digest, profile: kafka().profile, card }, locale);
    for (const html of [week, topic]) {
      const found = labels(html);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('data-experimental="digest"');
      expect(found[0]).toContain(`<span class="experimental-badge">${BADGE[locale]}</span>`);
      expect(found[0]).toContain(`<span class="experimental-note">${NOTE[locale]}</span>`);
    }
    // The label sits in the header, before the headline: a reader sees it before the generated text.
    expect(week.indexOf("experimental-label")).toBeLessThan(week.indexOf('class="digest-headline"'));
    expect(topic.indexOf("experimental-label")).toBeLessThan(topic.indexOf('class="topic-page-title"'));
  });

  test("D110: the label renders only for a feature in the registry; the registry holds the digest and search (Spec 016 H99)", async () => {
    expect(Object.keys(experimental.EXPERIMENTAL_FEATURES)).toEqual(["digest", "search"]);
    expect(experimental.experimentalFeature("digest")?.note).toBe("experimental.note.digest");
    expect(experimental.experimentalFeature("search")?.note).toBe("experimental.note.search");
    for (const id of ["people", "toString", "__proto__", ""]) {
      expect(experimental.experimentalFeature(id)).toBeUndefined();
      const html = await render(components.ExperimentalLabel, { feature: id });
      expect(html).not.toContain("experimental");
    }
    // Positive control: the same component renders for the flagged feature.
    expect(labels(await render(components.ExperimentalLabel, { feature: "digest" }))).toHaveLength(1);
  });

  test("D110: every ExperimentalLabel in the app names a registered feature, and every registered feature is shown", async () => {
    const root = join(import.meta.dir, "..", "src");
    const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".vue"));
    const used = new Set<string>();
    for (const file of files) {
      const source = await Bun.file(join(root, file)).text();
      for (const match of source.matchAll(/<ExperimentalLabel\b([^>]*)\/?>/gu)) {
        const feature = /\sfeature="([^"]+)"/u.exec(match[1]!)?.[1];
        expect({ file, feature }).toEqual({ file, feature: expect.any(String) });
        used.add(feature!);
      }
    }
    expect([...used].sort()).toEqual(Object.keys(experimental.EXPERIMENTAL_FEATURES).sort());
  });

  test.each(["en", "zh-Hant"] as const)("D111: the label is a note named by its badge text, and the text is in the DOM (%s)", async (locale) => {
    const [label] = labels(await render(components.ExperimentalLabel, { feature: "digest" }, locale));
    expect(label).toContain('role="note"');
    expect(label).toContain(`aria-label="${BADGE[locale]}"`);
    expect(label).not.toContain("aria-hidden");
    // No text drawn by CSS: a screen reader and a copy see the same words as the eye.
    const css = await Bun.file(join(import.meta.dir, "..", "styles.css")).text();
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}]*\.experimental-[^{}]*)\{([^}]*)\}/gu)];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule[2]).not.toMatch(/\bcontent\s*:/u);
  });
});

describe("Spec 014 experimental label colours", () => {
  const cssPath = join(import.meta.dir, "..", "styles.css");
  const over = (rgba: string, background: string) => {
    const match = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/u.exec(rgba);
    if (match === null) throw new Error(`not an rgba() fill: ${rgba}`);
    const [r, g, b, a] = [Number(match[1]) / 255, Number(match[2]) / 255, Number(match[3]) / 255, Number(match[4])];
    const base = hexToRgb(background);
    return rgbToHex([r, g, b].map((channel, index) => channel * a + base[index]! * (1 - a)));
  };

  test.each([
    { theme: "light", surfaces: ["--surface-card", "--surface-page", "--surface-sunken"] },
    { theme: "dark", surfaces: ["--surface-card", "--surface-page", "--surface-sunken"] },
  ] as const)("D112: in the $theme theme the badge text is ≥ 4.5:1 on its translucent fill and the outline ≥ 3:1, on every surface", async ({ theme, surfaces }) => {
    const tokens = themeTokens(await Bun.file(cssPath).text(), theme);
    const value = (name: string) => resolveToken(tokens, `var(${name})`);
    const text = value("--text-experimental");
    const border = value("--border-experimental");
    const fill = value("--surface-experimental");
    // Translucent: a fill with alpha below 1, not an opaque tint.
    expect(Number(/,\s*([\d.]+)\)$/u.exec(fill)?.[1])).toBeLessThan(0.5);
    for (const surface of surfaces) {
      const behind = value(surface);
      expect({ surface, text: contrast(text, over(fill, behind)) >= 4.5 }).toEqual({ surface, text: true });
      expect({ surface, outline: contrast(border, behind) >= 3 }).toEqual({ surface, outline: true });
    }
    // Same hue family (藤 wisteria) for text, fill and outline, and no orange (owner's taste).
    const fillHex = over(fill, "#ffffff");
    for (const colour of [text, border, fillHex]) {
      const [, chroma, hue] = toLch(colour);
      expect({ colour, orange: chroma > 5 && hue >= 30 && hue <= 85 }).toEqual({ colour, orange: false });
      expect(Math.abs(hue - toLch(border)[2])).toBeLessThan(15);
    }
  });

  test("D112: dark values differ from light ones, and the badge draws a fine outline on all four sides, never a one-sided stripe", async () => {
    const css = await Bun.file(cssPath).text();
    const light = themeTokens(css, "light");
    const dark = themeTokens(css, "dark");
    expect(dark.get("--text-experimental")).not.toBe(light.get("--text-experimental"));
    expect(dark.get("--surface-experimental")).not.toBe(light.get("--surface-experimental"));
    const clean = css.replace(/\/\*[\s\S]*?\*\//gu, "");
    const badge = [...clean.matchAll(/(^|\})\s*\.experimental-badge\s*\{([^}]*)\}/gu)].map((match) => match[2]!).join(";");
    expect(badge).toMatch(/border:\s*1px solid var\(--border-experimental\)/u);
    expect(badge).toContain("background: var(--surface-experimental)");
    expect(badge).toContain("color: var(--text-experimental)");
    expect(clean).not.toMatch(/\.experimental-[\w-]+[^{]*\{[^}]*border-(left|right|top|bottom)\s*:/u);
    expect(clean).not.toMatch(/\.experimental-[\w-]+[^{]*\{[^}]*opacity\s*:/u);
  });
});

const SEARCH_NOTE = {
  en: "Results are also found and ranked by meaning (AI embeddings); the ranking is still being tuned.",
  "zh-Hant": "結果也依語意相似度（AI 向量）找出與排序，排序仍在調校。",
} as const;

describe("Spec 016 search experimental label", () => {
  test.each(["en", "zh-Hant"] as const)("H99: the search label shows the shared badge and the search note in %s", async (locale) => {
    const found = labels(await render(components.ExperimentalLabel, { feature: "search" }, locale));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('data-experimental="search"');
    expect(found[0]).toContain(`<span class="experimental-badge">${BADGE[locale]}</span>`);
    expect(found[0]).toContain(`<span class="experimental-note">${SEARCH_NOTE[locale]}</span>`);
  });

  test("H99: only a fused response is experimental; a lexical, degraded or missing response is not", async () => {
    const { searchIsExperimental } = await import("../src/search-results");
    expect(searchIsExperimental({ retrieval: { fusionRevision: "rrf-group@2" } })).toBe(true);
    for (const response of [undefined, { retrieval: {} }, { retrieval: { fusionRevision: "" } }]) {
      expect(searchIsExperimental(response as never)).toBe(false);
    }
  });

  test("H99: the search view shows the label above the count line, only for a fused answer to a query", async () => {
    const source = await Bun.file(join(import.meta.dir, "..", "src", "views", "FeedView.vue")).text();
    const label = '<ExperimentalLabel v-if="query && !searchLoading && searchIsExperimental(searchResponse)" feature="search" />';
    expect(source).toContain(label);
    expect(source.indexOf(label)).toBeLessThan(source.indexOf('<p class="results-count"'));
    // One list-level label, never a per-card badge (Spec 005 S16).
    const card = await Bun.file(join(import.meta.dir, "..", "src", "components", "SearchResultCard.vue")).text();
    expect(card.includes("ExperimentalLabel")).toBe(false);
  });
});
