/**
 * Spec 005 S16–S18 (owner decision 2026-10-13): no search-method badge on a result card, exact
 * matches first with a divider before the rest, and a count line that says what is shown.
 * Rendered server-side in Bun; the browser checks live in `e2e/search-semantic.spec.ts` and
 * `e2e-lexical2/search.spec.ts`.
 */
import { beforeAll, describe, expect, test } from "bun:test";

import { testPlanRows } from "./search-results-view.cases";
import { registerVuePlugin } from "./vue-plugin";

type Translate = (key: string, variables?: Readonly<Record<string, string | number>>) => string;

let view: typeof import("../src/search-results");
let translations: (locale: string) => Translate;
let renderCard: (result: unknown, locale: string) => Promise<string>;

const scope = globalThis as unknown as Record<string, unknown>;

beforeAll(async () => {
  scope.document = { documentElement: {}, querySelectorAll: () => [], createElement: () => ({}) };
  scope.window ??= { localStorage: { getItem: () => null, setItem: () => undefined }, navigator: { language: "en" }, dispatchEvent: () => true };
  scope.history ??= { state: null, replaceState: () => undefined, pushState: () => undefined };
  registerVuePlugin();
  await import("../i18n.js");
  const i18n = (scope.window as { KB_I18N: { setLocale(locale: string): void; t: Translate } }).KB_I18N;
  translations = (locale) => (key, variables) => {
    i18n.setLocale(locale);
    return i18n.t(key, variables);
  };
  view = await import("../src/search-results");
  const { useI18n } = await import("../src/i18n");
  const card = (await import("../src/components/SearchResultCard.vue")).default;
  const { createSSRApp, h } = await import("vue");
  const { renderToString } = await import("vue/server-renderer");
  const { createMemoryHistory, createRouter } = await import("vue-router");
  renderCard = async (result, locale) => {
    useI18n().setLocale(locale);
    const app = createSSRApp({ render: () => h(card as never, { result, rank: 1, projectLabel: "Apache Kafka" }) });
    app.use(createRouter({ history: createMemoryHistory("/"), routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }] }));
    return renderToString(app);
  };
});

type Signals = { exactIdentifier: boolean; lexicalRank?: number; semanticRank?: number; semanticScore?: number; fusedRank?: number };
function result(name: string, signals: readonly Signals[]) {
  return {
    entry: { title: `${name} title`, summary: `${name} summary`, projectId: "apache-kafka" },
    detailRef: `sdr1.${name}`,
    matches: signals.map((item, index) => ({
      chunkId: `${name}#${index}`, recordId: `${name}/r${index}`, excerpt: `${name} excerpt ${index}`, canonicalUrl: "https://example.test/",
      author: "ada", occurredAt: "2026-10-01T00:00:00Z", sourceVersion: "v1", matchedTerms: [], signals: item,
    })),
  };
}
const exact = result("exact", [{ exactIdentifier: true, lexicalRank: 1, fusedRank: 1 }]);
const lexicalOnly = result("lexical", [{ exactIdentifier: false, lexicalRank: 2, fusedRank: 2 }]);
const semanticOnly = result("semantic", [{ exactIdentifier: false, semanticRank: 1, semanticScore: 0.61, fusedRank: 3 }]);
const mixed = result("mixed", [{ exactIdentifier: false, lexicalRank: 3, semanticRank: 2, semanticScore: 0.58, fusedRank: 1 }]);

const methodWording = ["search-match-badge", "semantic-match-badge", "Evidence search", "證據搜尋", "Similar meaning", "意思相近", "search.lexicalMatch", "search.semanticMatch"];

describe("Spec 005 S16: a result card names no search method", () => {
  for (const locale of ["en", "zh-Hant"]) {
    for (const [name, item] of [["lexical-only", lexicalOnly], ["semantic-only", semanticOnly], ["lexical and semantic", mixed], ["exact", exact]] as const) {
      test(`S16: a ${name} result renders no method badge, ${locale}`, async () => {
        const html = await renderCard(item, locale);
        for (const wording of methodWording) expect(html).not.toContain(wording);
        // Positive control: the card itself rendered, with its title and evidence.
        expect(html).toContain(`${item.entry.title}`);
        expect(html).toContain("class=\"evidence\"");
      });
    }

    test(`S16: the exact-match marker stays, as text, on an exact result only, ${locale}`, async () => {
      const label = translations(locale)("search.exact");
      expect(["Exact match", "精確命中"]).toContain(label);
      expect(await renderCard(exact, locale)).toContain(`<span class="exact-match">${label}</span>`);
      for (const item of [lexicalOnly, semanticOnly, mixed]) expect(await renderCard(item, locale)).not.toContain("exact-match");
    });
  }

  test("S16: the removed strings are gone from both locales", () => {
    for (const locale of ["en", "zh-Hant"]) {
      // A missing key renders as the key itself.
      expect(translations(locale)("search.lexicalMatch")).toBe("search.lexicalMatch");
      expect(translations(locale)("search.semanticMatch")).toBe("search.semanticMatch");
      expect(translations(locale)("search.exact")).not.toBe("search.exact");
    }
  });
});

describe("Spec 005 S17: exact matches first, then a divider", () => {
  test("S17: the divider sits before the first non-exact result only when both groups exist", () => {
    expect(view.otherResultsStart([exact, lexicalOnly, semanticOnly])).toBe(1);
    expect(view.otherResultsStart([exact, exact, mixed])).toBe(2);
    expect(view.otherResultsStart([exact, exact])).toBeUndefined();
    expect(view.otherResultsStart([lexicalOnly, semanticOnly])).toBeUndefined();
    expect(view.otherResultsStart([exact])).toBeUndefined();
    expect(view.otherResultsStart([])).toBeUndefined();
  });

  test("S17: the response order is kept — a result is exact when any of its matches is", () => {
    const later = result("later", [{ exactIdentifier: false, lexicalRank: 1 }, { exactIdentifier: true, lexicalRank: 1 }]);
    expect(view.isExactResult(later)).toBe(true);
    expect(view.isExactResult(semanticOnly)).toBe(false);
    // No exact result leads the list, so nothing is moved and no divider is drawn.
    expect(view.otherResultsStart([lexicalOnly, exact])).toBeUndefined();
  });

  test("S17: the divider has a label in both locales", () => {
    expect(translations("en")("results.search.others")).toBe("Other related results");
    expect(translations("zh-Hant")("results.search.others")).toBe("其他相關結果");
  });
});

describe("Spec 005 S18: the count line", () => {
  test.each(testPlanRows)("$id: $case → $en", (row) => {
    const count = { exact: row.exact, shown: row.shown, ...(row.total === null ? {} : { total: row.total }) };
    expect(view.searchCountText(count, translations("en"))).toBe(row.en);
    expect(view.searchCountText(count, translations("zh-Hant"))).toBe(row.zh);
  });

  test("S18: the counts come from the response — results for exact and shown, project facets for the total", () => {
    const response = {
      results: [exact, lexicalOnly, semanticOnly],
      facets: { projects: [{ projectId: "apache-datafusion", count: 4 }, { projectId: "apache-kafka", count: 152 }] },
    };
    expect(view.searchCount(response, undefined)).toEqual({ exact: 1, shown: 3, total: 156 });
    // Facets ignore the project filter, so a filtered list is counted against its own project.
    expect(view.searchCount(response, "apache-kafka")).toEqual({ exact: 1, shown: 3, total: 152 });
    expect(view.searchCount(response, "apache-unknown")).toEqual({ exact: 1, shown: 3 });
    expect(view.searchCount({ results: [], facets: { projects: [] } }, undefined)).toEqual({ exact: 0, shown: 0, total: 0 });
  });
});
