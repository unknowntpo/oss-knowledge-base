import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readRepository } from "../docs-site/build";
import { deployDecision, publishedMatches } from "../docs-site/deploy";
import { auditSite, buildDocsSite, DocsError, LOCALES, PAGES, type DocsInput } from "../docs-site/generate";
import { testPlanRows } from "./docs-site.cases";

const root = join(import.meta.dir, "../..");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const STYLES = `:root {\n  --surface-page: #f5f4f1;\n  --surface-card: #fff;\n  --text-body: #333;\n  --accent: #3a53b0;\n  --font-sans: "IBM Plex Sans";\n}\n:root[data-theme="dark"] {\n  --surface-page: #18181d;\n}\n`;
const FILES = new Set(["docs/feature-map.md", "docs/specs/014-topic-digest/spec.md", "apps/web/styles.css"]);
const DIRS = new Set(["docs", "docs/specs"]);

function page(locale: string, id: string, extra = ""): string {
  const zh = locale === "zh-Hant";
  return `# ${zh ? "標題" : "Title"} ${id}\n\n${zh ? "導言。" : "Lede."}\n\n## ${zh ? "第一節" : "First"} {#first}\n\n${zh ? "見" : "See"} [feature map](docs/feature-map.md) ${zh ? "與" : "and"} [search](search.html#first).\n\n{{flow:mini}}\n${extra}`;
}

const flow = () => ({
  id: "mini",
  label: { en: "Mini flow", "zh-Hant": "小流程" },
  columns: [
    { title: { en: "In", "zh-Hant": "輸入" }, cards: [{ id: "a", title: { en: "A", "zh-Hant": "甲" }, nodes: [
      { id: "a1", icon: "A", kind: "src", title: { en: "Step A", "zh-Hant": "步驟甲" }, lead: { en: "Reads `x`.", "zh-Hant": "讀 `x`。" }, facts: [{ k: { en: "Spec", "zh-Hant": "規格" }, v: { en: "[014](docs/specs/014-topic-digest/spec.md)", "zh-Hant": "[014](docs/specs/014-topic-digest/spec.md)" } }], sources: ["apps/web/styles.css"] },
    ] }] },
    { title: { en: "Out", "zh-Hant": "輸出" }, cards: [{ id: "b", title: { en: "B", "zh-Hant": "乙" }, nodes: [
      { id: "b1", icon: "B", kind: "web", title: { en: "Step B", "zh-Hant": "步驟乙" }, lead: { en: "Shows it.", "zh-Hant": "顯示。" }, sources: ["docs/feature-map.md"] },
    ] }] },
  ],
  links: [["a", "b"]],
  initial: "a1",
});

function fixture(): { -readonly [K in keyof DocsInput]: DocsInput[K] } & { pages: Record<string, Record<string, string>>; flows: Record<string, any> } {
  const pages: Record<string, Record<string, string>> = {};
  for (const locale of LOCALES) {
    pages[locale] = {};
    for (const id of PAGES) pages[locale]![id] = page(locale, id);
  }
  return {
    repository: "unknowntpo/oss-knowledge-base",
    commit: { sha: SHA, date: "2026-10-20T00:00:00.000Z" },
    pages,
    flows: { mini: flow() },
    stylesCss: STYLES,
    exists: (path) => (FILES.has(path) ? "file" : DIRS.has(path) ? "dir" : null),
    values: { specs: "25" },
  };
}

function problemsOf(run: () => unknown): string[] {
  try {
    run();
    return [];
  } catch (error) {
    if (error instanceof DocsError) return [...error.problems];
    throw error;
  }
}

const buildChanges: Record<string, (input: ReturnType<typeof fixture>) => void> = {
  "zh-Hant/search.md deleted": (input) => { delete input.pages["zh-Hant"]!.search; },
  "en/extra.md added": (input) => { input.pages.en!.extra = page("en", "extra"); },
  "a level-2 heading without {#id}": (input) => { input.pages.en!.overview += "\n## Loose heading\n\nText.\n"; },
  "page starts without a level-1 heading": (input) => { input.pages.en!.overview = "Just text.\n"; },
  "link to docs/specs/999-none/spec.md": (input) => { input.pages.en!.overview += "\n[x](docs/specs/999-none/spec.md)\n"; },
  "link to ../../etc/passwd": (input) => { input.pages.en!.overview += "\n[x](../../etc/passwd)\n"; },
  "link to javascript:alert(1)": (input) => { input.pages.en!.overview += "\n[x](javascript:alert(1))\n"; },
  "{{value:nope}}": (input) => { input.pages.en!.overview += "\nCount {{value:nope}}.\n"; },
  "{{flow:nope}}": (input) => { input.pages.en!.overview += "\n{{flow:nope}}\n"; },
  "flow node without zh-Hant title": (input) => { delete input.flows.mini.columns[0].cards[0].nodes[0].title["zh-Hant"]; },
  "flow link to an unknown card": (input) => { input.flows.mini.links.push(["a", "ghost"]); },
  "flow initial names no node": (input) => { input.flows.mini.initial = "zz"; },
  "flow node without sources": (input) => { input.flows.mini.columns[1].cards[0].nodes[0].sources = []; },
  "flow source path missing": (input) => { input.flows.mini.columns[1].cards[0].nodes[0].sources = ["apps/none.ts"]; },
  "styles.css without the dark block": (input) => { input.stylesCss = input.stylesCss.slice(0, input.stylesCss.indexOf(":root[data-theme")); },
};

const auditChanges: Record<string, (files: Map<string, string>) => void> = {
  "zh-Hant overview has an extra {#id} section": (files) => edit(files, "zh-Hant/overview.html", (html) => html.replace("</main>", '<h2 id="extra">多</h2></main>')),
  "en overview cites one more source": (files) => edit(files, "en/overview.html", (html) => html.replace("</main>", `<a href="https://github.com/unknowntpo/oss-knowledge-base/blob/${SHA}/README.md">r</a></main>`)),
  "en link to missing.html": (files) => edit(files, "en/overview.html", (html) => html.replace("</main>", '<a href="missing.html">m</a></main>')),
  "en link to search.html#nowhere": (files) => edit(files, "en/overview.html", (html) => html.replace("</main>", '<a href="search.html#nowhere">m</a></main>')),
  "a <script src> from a CDN": (files) => edit(files, "en/overview.html", (html) => html.replace("</head>", '<script src="https://cdn.example.com/x.js"></script></head>')),
  "a stylesheet from fonts.googleapis.com": (files) => edit(files, "en/overview.html", (html) => html.replace("</head>", '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X"></head>')),
  "text with dev@kafka.apache.org": (files) => edit(files, "en/overview.html", (html) => html.replace("</main>", "<p>dev@kafka.apache.org</p></main>")),
  "text with ghp_ followed by 36 characters": (files) => edit(files, "en/overview.html", (html) => html.replace("</main>", `<p>ghp_${"a1".repeat(18)}</p></main>`)),
  "text with a workers.dev hostname": (files) => edit(files, "en/overview.html", (html) => html.replace("</main>", "<p>oss-knowledge-base-data-dev.someone.workers.dev</p></main>")),
  "text with POST /digest/run": (files) => edit(files, "en/overview.html", (html) => html.replace("</main>", "<p>POST /digest/run</p></main>")),
  "a link to the Dev /api/search": (files) => edit(files, "en/overview.html", (html) => html.replace("</main>", '<a href="https://oss-knowledge-base-dev.pages.dev/api/search?q=x">s</a></main>')),
  "text with the Dev site URL only": (files) => edit(files, "en/overview.html", (html) => html.replace("</main>", '<a href="https://oss-knowledge-base-dev.pages.dev/">Dev</a></main>')),
};

function edit(files: Map<string, string>, path: string, change: (html: string) => string) {
  const before = files.get(path)!;
  const after = change(before);
  if (after === before) throw new Error(`fixture edit did not apply to ${path}`);
  files.set(path, after);
}

describe("Spec 025 docs site", () => {
  test("DOC1: every page is built in both locales, plus the root, 404 and build.json", () => {
    const files = buildDocsSite(fixture());
    for (const locale of LOCALES) for (const id of PAGES) {
      expect(files.get(`${locale}/${id}.html`)).toContain(`<html lang="${locale}">`);
    }
    expect([...files.keys()].sort()).toEqual(["404.html", "build.json", ...LOCALES.flatMap((l) => PAGES.map((p) => `${l}/${p}.html`)), "index.html"].sort());
    const rootPage = files.get("index.html")!;
    expect(rootPage).toContain('href="en/index.html"');
    expect(rootPage).toContain('href="zh-Hant/index.html"');
    expect(rootPage).toContain("location.replace(l+\"/index.html\")");
    expect(JSON.parse(files.get("build.json")!)).toMatchObject({ schema: "docs-site.build.v1", commit: SHA });
  });

  test("DOC2: each page's locale toggle opens the same page in the other locale", () => {
    const files = buildDocsSite(fixture());
    for (const id of PAGES) {
      expect(files.get(`en/${id}.html`)).toContain(`<a class="locale" href="../zh-Hant/${id}.html" hreflang="zh-Hant"`);
      expect(files.get(`zh-Hant/${id}.html`)).toContain(`<a class="locale" href="../en/${id}.html" hreflang="en"`);
    }
    // The script carries the fragment, so a section stays open across the switch (ids are locale-independent).
    expect(files.get("en/index.html")).toContain("loc.href=loc.getAttribute('href').split('#')[0]+location.hash");
  });

  test("DOC3: the fixture's two locales have the same sections, flows and sources (audit clean)", () => {
    const files = buildDocsSite(fixture());
    expect(auditSite(files)).toEqual([]);
    expect(files.get("en/overview.html")).toContain('<h2 id="first">');
    expect(files.get("zh-Hant/overview.html")).toContain('<h2 id="first">');
  });

  test("DOC5: a repository path becomes a GitHub link at the build commit", () => {
    const html = buildDocsSite(fixture()).get("en/overview.html")!;
    expect(html).toContain(`href="https://github.com/unknowntpo/oss-knowledge-base/blob/${SHA}/docs/feature-map.md"`);
    expect(html).toContain('href="search.html#first"');
    expect(html).toContain(`commit/${SHA}"><code>0123456</code></a> (2026-10-20)`);
  });

  test("DOC8: the product's light and dark tokens are inlined", () => {
    const html = buildDocsSite(fixture()).get("en/index.html")!;
    expect(html).toContain(":root{--surface-page: #f5f4f1;");
    expect(html).toContain(':root[data-theme="dark"]{--surface-page: #18181d;}');
    expect(html).toContain('@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--surface-page: #18181d;}}');
  });

  test("DOC9: a flow renders cards, node anchors and one detail per node without script", () => {
    const html = buildDocsSite(fixture()).get("zh-Hant/overview.html")!;
    expect(html).toContain('<figure class="flow" id="flow-mini" data-initial="mini-a1"');
    expect(html).toContain('<a class="flow-node" href="#mini-a1" data-node="mini-a1">');
    expect(html).toContain('<section class="flow-detail" id="mini-b1"');
    expect(html).toContain("步驟甲");
    expect(html).toContain('[["mini-card-a","mini-card-b"]]');
  });

  test("DOC10: {{value:specs}} is replaced by the derived value", () => {
    const input = fixture();
    input.pages.en!.index += "\nThere are {{value:specs}} specs.\n";
    expect(buildDocsSite(input).get("en/index.html")).toContain("There are 25 specs.");
  });

  test("DOC11: the same input gives byte-identical files", () => {
    const [a, b] = [buildDocsSite(fixture()), buildDocsSite(fixture())];
    expect([...a]).toEqual([...b]);
  });

  test("DOC13: build.json is accepted only when it names the commit", () => {
    expect(publishedMatches(JSON.stringify({ schema: "docs-site.build.v1", commit: SHA }), SHA)).toBe(true);
    expect(publishedMatches(JSON.stringify({ schema: "docs-site.build.v1", commit: "f".repeat(40) }), SHA)).toBe(false);
    expect(publishedMatches("<html>not json", SHA)).toBe(false);
  });

  test("DOC14: the committed docs/site builds and audits clean, every page in both locales", () => {
    const input = readRepository(root, "unknowntpo/oss-knowledge-base");
    const files = buildDocsSite(input);
    expect(auditSite(files)).toEqual([]);
    for (const locale of LOCALES) for (const id of PAGES) expect(files.has(`${locale}/${id}.html`)).toBe(true);
    // Each content page has an interactive flow or sections in both locales, never an empty body.
    for (const id of PAGES) expect(files.get(`en/${id}.html`)!.match(/<h2 id=/gu)?.length ?? 0).toBeGreaterThan(1);
  });

  test.each(testPlanRows)("$id: $change → $stage reports \"$expect\"", (row) => {
    if (row.stage === "deploy") {
      const [event, ref, credentials, status] = row.change.split(" ");
      const decision = deployDecision({ event: event!, ref: ref!, hasCredentials: credentials === "yes", projectStatus: status === "-" ? null : Number(status) });
      expect(decision.action).toBe(row.expect as "deploy" | "skip" | "fail");
      return;
    }
    if (row.stage === "build") {
      const input = fixture();
      expect(problemsOf(() => buildDocsSite(input))).toEqual([]); // positive control: the unchanged fixture builds
      buildChanges[row.change]!(input);
      const problems = problemsOf(() => buildDocsSite(input));
      expect(problems.some((problem) => problem.includes(row.expect))).toBe(true);
      return;
    }
    const files = buildDocsSite(fixture());
    expect(auditSite(files)).toEqual([]);
    auditChanges[row.change]!(files);
    const problems = auditSite(files);
    if (row.expect === "") expect(problems).toEqual([]);
    else expect(problems.some((problem) => problem.includes(row.expect))).toBe(true);
  });
});
