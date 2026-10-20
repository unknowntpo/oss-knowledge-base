/**
 * Spec 025: the public documentation site. Pure functions: `buildDocsSite` turns the bilingual
 * Markdown pages in docs/site/<locale>/, the flow files in docs/site/flows/ and the product's design
 * tokens (apps/web/styles.css) into static files; `auditSite` checks the output (links, external
 * resources, secrets, locale parity). It reads no clock, no environment and no network.
 *
 * Markdown is the subset scripts/feature-map-site/markdown.ts parses, plus three conventions:
 * `## Title {#id}` (a locale-independent anchor, required on level-2 headings), a paragraph that is
 * only `{{flow:<id>}}` (an interactive flow), and `{{value:<name>}}` (a value derived from the repository).
 */
import { escapeHtml, parseMarkdown, renderInline, type Block, type ListItem } from "../feature-map-site/markdown";

export const LOCALES = ["en", "zh-Hant"] as const;
export type Locale = (typeof LOCALES)[number];
export const PAGES = ["index", "overview", "search", "digest", "process"] as const;
export type PageId = (typeof PAGES)[number];
export type Text = Readonly<Record<Locale, string>>;

export const PROJECT_NAME = "oss-knowledge-base-docs";
export const SITE_URL = `https://${PROJECT_NAME}.pages.dev`;
/** The only hosts a page may load a resource (stylesheet, font, script, image) from. */
export const ALLOWED_RESOURCE_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"] as const;

export class DocsError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`docs site: ${problems.length} problem(s)\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
}

const UI = {
  en: {
    site: "OSS Knowledge Base · Docs",
    nav: { index: "Home", overview: "System", search: "Search", digest: "Digest", process: "Process & cost" },
    other: "中文",
    otherTitle: "閱讀繁體中文版",
    toc: "On this page",
    theme: "Toggle light or dark theme",
    built: "Built from commit",
    of: "of",
    sources: "Every fact links to its source file at this commit.",
    flowHint: "Select a step to see its details.",
    flowSources: "Sources",
    skip: "Skip to content",
    notFound: "Page not found",
    home: "Go to the documentation home",
  },
  "zh-Hant": {
    site: "OSS Knowledge Base · 文件",
    nav: { index: "首頁", overview: "系統", search: "搜尋", digest: "週報", process: "流程與成本" },
    other: "English",
    otherTitle: "Read in English",
    toc: "本頁內容",
    theme: "切換淺色或深色主題",
    built: "建置自 commit",
    of: "，來源",
    sources: "每項事實都連到這個 commit 的來源檔案。",
    flowHint: "點選任一步驟查看細節。",
    flowSources: "來源",
    skip: "跳到內容",
    notFound: "找不到這個頁面",
    home: "回到文件首頁",
  },
} as const satisfies Record<Locale, unknown>;

// ---------------------------------------------------------------------------------------------
// Flows

export type NodeKind = "src" | "r2" | "ai" | "rule" | "web";
export interface FlowNode {
  readonly id: string;
  readonly icon: string;
  readonly kind: NodeKind;
  readonly title: Text;
  readonly meta?: Text;
  readonly tag?: { readonly kind: "on" | "off" | "dev"; readonly text: Text };
  readonly lead: Text;
  readonly facts?: readonly { readonly k: Text; readonly v: Text }[];
  readonly sources: readonly string[];
}
export interface FlowCard {
  readonly id: string;
  readonly title: Text;
  readonly count?: string;
  readonly nodes: readonly FlowNode[];
}
export interface Flow {
  readonly id: string;
  readonly label: Text;
  readonly columns: readonly { readonly title: Text; readonly cards: readonly FlowCard[] }[];
  readonly links: readonly (readonly [string, string])[];
  readonly initial: string;
  readonly note?: Text;
}

const KINDS: readonly NodeKind[] = ["src", "r2", "ai", "rule", "web"];
const ID = /^[a-z0-9][a-z0-9-]*$/u;

/** Checks a parsed flow file; returns the problems (empty when it is a valid Flow). */
export function flowProblems(name: string, raw: unknown): string[] {
  const problems: string[] = [];
  const at = (path: string, message: string) => problems.push(`flow ${name}: ${path}: ${message}`);
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const text = (value: unknown, path: string) => {
    if (!isObject(value)) return at(path, "must be an object with en and zh-Hant");
    for (const locale of LOCALES) {
      if (typeof value[locale] !== "string" || (value[locale] as string).trim() === "") at(path, `missing ${locale} text`);
    }
    for (const key of Object.keys(value)) if (!(LOCALES as readonly string[]).includes(key)) at(path, `unknown locale ${key}`);
  };
  if (!isObject(raw)) {
    at("$", "must be an object");
    return problems;
  }
  if (raw.id !== name) at("id", `must equal the file name ${name}`);
  text(raw.label, "label");
  if (raw.note !== undefined) text(raw.note, "note");
  const cards = new Set<string>();
  const nodes = new Set<string>();
  if (!Array.isArray(raw.columns) || raw.columns.length === 0) at("columns", "must be a non-empty array");
  for (const [c, column] of (Array.isArray(raw.columns) ? raw.columns : []).entries()) {
    if (!isObject(column)) {
      at(`columns[${c}]`, "must be an object");
      continue;
    }
    text(column.title, `columns[${c}].title`);
    if (!Array.isArray(column.cards) || column.cards.length === 0) at(`columns[${c}].cards`, "must be a non-empty array");
    for (const card of Array.isArray(column.cards) ? column.cards : []) {
      if (!isObject(card) || typeof card.id !== "string" || !ID.test(card.id)) {
        at(`columns[${c}].cards`, "a card needs an id of a-z, 0-9 and -");
        continue;
      }
      if (cards.has(card.id)) at(`card ${card.id}`, "duplicate id");
      cards.add(card.id);
      text(card.title, `card ${card.id}.title`);
      if (!Array.isArray(card.nodes) || card.nodes.length === 0) at(`card ${card.id}.nodes`, "must be a non-empty array");
      for (const node of Array.isArray(card.nodes) ? card.nodes : []) {
        if (!isObject(node) || typeof node.id !== "string" || !ID.test(node.id)) {
          at(`card ${card.id}.nodes`, "a node needs an id of a-z, 0-9 and -");
          continue;
        }
        const where = `node ${node.id}`;
        if (nodes.has(node.id)) at(where, "duplicate id");
        nodes.add(node.id);
        if (typeof node.icon !== "string" || node.icon === "") at(where, "needs an icon");
        if (!KINDS.includes(node.kind as NodeKind)) at(where, `kind must be one of ${KINDS.join(", ")}`);
        text(node.title, `${where}.title`);
        text(node.lead, `${where}.lead`);
        if (node.meta !== undefined) text(node.meta, `${where}.meta`);
        if (node.tag !== undefined) {
          if (!isObject(node.tag) || !["on", "off", "dev"].includes(node.tag.kind as string)) at(`${where}.tag`, "kind must be on, off or dev");
          else text(node.tag.text, `${where}.tag.text`);
        }
        for (const [f, fact] of (Array.isArray(node.facts) ? node.facts : []).entries()) {
          if (!isObject(fact)) at(`${where}.facts[${f}]`, "must be an object");
          else {
            text(fact.k, `${where}.facts[${f}].k`);
            text(fact.v, `${where}.facts[${f}].v`);
          }
        }
        if (!Array.isArray(node.sources) || node.sources.length === 0 || node.sources.some((source) => typeof source !== "string")) {
          at(`${where}.sources`, "must name at least one repository path");
        }
      }
    }
  }
  for (const [l, link] of (Array.isArray(raw.links) ? raw.links : []).entries()) {
    if (!Array.isArray(link) || link.length !== 2) at(`links[${l}]`, "must be [from, to]");
    else for (const end of link) if (!cards.has(end as string)) at(`links[${l}]`, `unknown card ${JSON.stringify(end)}`);
  }
  if (!Array.isArray(raw.links)) at("links", "must be an array");
  if (typeof raw.initial !== "string" || !nodes.has(raw.initial)) at("initial", "must name a node");
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Tokens

/** The product's light and dark token blocks (Spec 023/024), so the docs look like the product. */
export function productTokens(stylesCss: string): { readonly light: string; readonly dark: string } {
  const block = (selector: string) => {
    const start = stylesCss.indexOf(`${selector} {`);
    if (start < 0) throw new DocsError([`apps/web/styles.css has no "${selector} {" block`]);
    const open = stylesCss.indexOf("{", start);
    const close = stylesCss.indexOf("}", open);
    return stylesCss.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\s*\n\s*/gu, "").trim();
  };
  const light = block(":root");
  const dark = block(':root[data-theme="dark"]');
  for (const token of ["--surface-page", "--surface-card", "--text-body", "--accent", "--font-sans"]) {
    if (!light.includes(`${token}:`)) throw new DocsError([`apps/web/styles.css :root lacks ${token}`]);
  }
  return { light, dark };
}

// ---------------------------------------------------------------------------------------------
// Pages

export interface DocsInput {
  readonly repository: string;
  readonly commit: { readonly sha: string; readonly date: string };
  readonly pages: Readonly<Record<Locale, Readonly<Record<string, string>>>>;
  readonly flows: Readonly<Record<string, unknown>>;
  readonly stylesCss: string;
  /** Whether a repository path exists: "file", "dir", or null. */
  readonly exists: (path: string) => "file" | "dir" | null;
  readonly values: Readonly<Record<string, string>>;
}

interface Rendered {
  readonly title: string;
  readonly lede: string;
  readonly body: string;
  readonly toc: readonly { readonly id: string; readonly title: string }[];
}

const pageFile = (page: PageId) => `${page}.html`;
const short = (sha: string) => sha.slice(0, 7);

export function buildDocsSite(input: DocsInput): Map<string, string> {
  const problems: string[] = [];
  for (const locale of LOCALES) {
    for (const name of Object.keys(input.pages[locale] ?? {})) {
      if (!(PAGES as readonly string[]).includes(name)) problems.push(`docs/site/${locale}/${name}.md is not a registered page (PAGES in scripts/docs-site/generate.ts)`);
    }
    for (const page of PAGES) {
      if (input.pages[locale]?.[page] === undefined) problems.push(`docs/site/${locale}/${page}.md is missing (every page exists in every locale)`);
    }
  }
  const flows = new Map<string, Flow>();
  for (const [name, raw] of Object.entries(input.flows)) {
    const found = flowProblems(name, raw);
    problems.push(...found);
    if (found.length === 0) flows.set(name, raw as Flow);
  }
  if (problems.length > 0) throw new DocsError(problems);

  const tokens = productTokens(input.stylesCss);
  const files = new Map<string, string>();
  for (const locale of LOCALES) {
    for (const page of PAGES) {
      const where = `docs/site/${locale}/${page}.md`;
      const rendered = renderPage(input, flows, locale, input.pages[locale]![page]!, (problem) => problems.push(`${where}: ${problem}`));
      files.set(`${locale}/${pageFile(page)}`, pageHtml(input, tokens, locale, page, rendered));
    }
  }
  if (problems.length > 0) throw new DocsError(problems);
  files.set("index.html", rootHtml(tokens));
  files.set("404.html", notFoundHtml(tokens));
  files.set("build.json", `${JSON.stringify({
    schema: "docs-site.build.v1",
    repository: input.repository,
    commit: input.commit.sha,
    commitDate: input.commit.date,
    locales: LOCALES,
    pages: PAGES,
  }, null, 2)}\n`);
  return files;
}

function renderPage(input: DocsInput, flows: ReadonlyMap<string, Flow>, locale: Locale, source: string, problem: (message: string) => void): Rendered {
  const markdown = source.replace(/\{\{value:([a-zA-Z0-9-]+)\}\}/gu, (whole, name: string) => {
    const value = input.values[name];
    if (value === undefined) {
      problem(`unknown value {{value:${name}}}`);
      return whole;
    }
    return value;
  });
  const resolve = linkResolver(input, problem);
  const inline = (text: string) => renderInline(text, resolve);
  const sections = parseMarkdown(markdown);
  const first = sections[0];
  if (first === undefined || first.level !== 1) {
    problem("must start with one level-1 heading (the page title)");
    return { title: "", lede: "", body: "", toc: [] };
  }
  const [ledeBlock, ...introBlocks] = first.blocks;
  if (ledeBlock?.type !== "paragraph") problem("the title must be followed by a lede paragraph");
  const toc: { id: string; title: string }[] = [];
  const ids = new Set<string>();
  let body = introBlocks.map((block) => renderBlock(block, inline, flows, locale, input, problem)).join("\n");
  for (const section of sections.slice(1)) {
    if (section.level === 1) problem(`a second level-1 heading: ${section.title}`);
    const explicit = /\s*\{#([a-z0-9][a-z0-9-]*)\}\s*$/u.exec(section.title);
    const title = explicit === null ? section.title : section.title.slice(0, explicit.index);
    if (section.level === 2 && explicit === null) problem(`level-2 heading needs an explicit {#id}: ${section.title}`);
    const id = explicit?.[1] ?? `${toc.at(-1)?.id ?? "s"}-${section.anchor}`;
    if (ids.has(id)) problem(`duplicate heading id ${id}`);
    ids.add(id);
    if (section.level === 2) toc.push({ id, title: inline(title) });
    const level = Math.min(Math.max(section.level, 2), 4);
    body += `\n<h${level} id="${escapeHtml(id)}">${inline(title)}<a class="anchor" href="#${escapeHtml(id)}" aria-hidden="true" tabindex="-1">#</a></h${level}>\n`;
    body += section.blocks.map((block) => renderBlock(block, inline, flows, locale, input, problem)).join("\n");
  }
  return {
    title: first.title,
    lede: ledeBlock?.type === "paragraph" ? ledeBlock.text : "",
    body,
    toc,
  };
}

/** Link targets: http(s) as written; `<page>.html[#id]` within the locale; `#id` on the page; any other relative path is a repository file, linked on GitHub at the commit, and must exist. */
function linkResolver(input: DocsInput, problem: (message: string) => void): (url: string) => string | null {
  return (url) => {
    if (/^https?:\/\//u.test(url)) return url;
    if (/^[a-z][a-z0-9+.-]*:/iu.test(url)) {
      problem(`link with a disallowed scheme: ${url}`);
      return null;
    }
    if (url.startsWith("#")) return url;
    const [path, fragment] = url.split("#", 2) as [string, string | undefined];
    const page = /^([a-z]+)\.html$/u.exec(path);
    if (page !== null && (PAGES as readonly string[]).includes(page[1]!)) return url;
    const repoPath = path.replace(/^\.?\//u, "").replace(/\/$/u, "");
    if (repoPath === "" || repoPath.split("/").includes("..")) {
      problem(`link outside the repository: ${url}`);
      return null;
    }
    const kind = input.exists(repoPath);
    if (kind === null) {
      problem(`link to a repository path that does not exist: ${repoPath}`);
      return null;
    }
    return githubUrl(input, repoPath, kind) + (fragment === undefined ? "" : `#${fragment}`);
  };
}

const githubUrl = (input: Pick<DocsInput, "repository" | "commit">, path: string, kind: "file" | "dir") =>
  `https://github.com/${input.repository}/${kind === "dir" ? "tree" : "blob"}/${input.commit.sha}/${path}`;

function renderBlock(block: Block, inline: (text: string) => string, flows: ReadonlyMap<string, Flow>, locale: Locale, input: DocsInput, problem: (message: string) => void): string {
  switch (block.type) {
    case "paragraph": {
      const flow = /^\{\{flow:([a-z0-9-]+)\}\}$/u.exec(block.text.trim());
      if (flow !== null) {
        const found = flows.get(flow[1]!);
        if (found === undefined) {
          problem(`unknown flow ${flow[1]}`);
          return "";
        }
        return renderFlow(found, locale, input, problem);
      }
      if (block.text.includes("{{")) problem(`unknown directive in: ${block.text.slice(0, 60)}`);
      return `<p>${inline(block.text)}</p>`;
    }
    case "table":
      return `<div class="table-wrap"><table><thead><tr>${block.headers.map((cell) => `<th scope="col">${inline(cell)}</th>`).join("")}</tr></thead><tbody>${
        block.rows.map((row) => `<tr>${row.map((cell, index) => (index === 0 ? `<th scope="row">${inline(cell)}</th>` : `<td>${inline(cell)}</td>`)).join("")}</tr>`).join("")
      }</tbody></table></div>`;
    case "list":
      return renderList(block.items, inline);
    case "quote":
      return `<aside class="note"><p>${inline(block.text)}</p></aside>`;
    case "code":
      return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
  }
}

function renderList(items: readonly ListItem[], inline: (text: string) => string): string {
  let html = "";
  const stack: ("ul" | "ol")[] = [];
  for (const item of items) {
    const tag = item.ordered ? "ol" : "ul";
    while (stack.length > item.depth + 1) html += `</li></${stack.pop()}>`;
    if (stack.length === item.depth + 1) html += "</li>";
    while (stack.length < item.depth + 1) {
      stack.push(tag);
      html += `<${tag}>`;
    }
    html += `<li>${inline(item.text)}`;
  }
  while (stack.length > 0) html += `</li></${stack.pop()}>`;
  return html;
}

function renderFlow(flow: Flow, locale: Locale, input: DocsInput, problem: (message: string) => void): string {
  const t = (text: Text) => text[locale];
  const resolve = linkResolver(input, problem);
  const inline = (text: string) => renderInline(text, resolve);
  const cardId = (card: string) => `${flow.id}-card-${card}`;
  const nodeId = (node: string) => `${flow.id}-${node}`;
  const columns = flow.columns.map((column) => `<div class="flow-col"><p class="flow-col-title">${escapeHtml(t(column.title))}</p>${
    column.cards.map((card) => `<div class="flow-card" id="${cardId(card.id)}"><div class="flow-card-h">${escapeHtml(t(card.title))}${card.count === undefined ? "" : ` <span class="count">${escapeHtml(card.count)}</span>`}</div>${
      card.nodes.map((node) => `<a class="flow-node" href="#${nodeId(node.id)}" data-node="${nodeId(node.id)}"><span class="ic ic-${node.kind}" aria-hidden="true">${escapeHtml(node.icon)}</span><span class="nm"><b>${escapeHtml(t(node.title))}</b>${node.meta === undefined ? "" : `<small>${escapeHtml(t(node.meta))}</small>`}</span>${node.tag === undefined ? "" : `<span class="tag tag-${node.tag.kind}">${escapeHtml(t(node.tag.text))}</span>`}</a>`).join("")
    }</div>`).join("")
  }</div>`).join("");
  const details = flow.columns.flatMap((column) => column.cards.flatMap((card) => card.nodes)).map((node) => `<section class="flow-detail" id="${nodeId(node.id)}" tabindex="-1"><h3>${escapeHtml(t(node.title))}${node.tag === undefined ? "" : ` <span class="tag tag-${node.tag.kind}">${escapeHtml(t(node.tag.text))}</span>`}</h3><p class="lead">${inline(t(node.lead))}</p>${
    node.facts === undefined || node.facts.length === 0 ? "" : `<dl class="kv">${node.facts.map((fact) => `<dt>${inline(t(fact.k))}</dt><dd>${inline(t(fact.v))}</dd>`).join("")}</dl>`
  }<p class="flow-src">${UI[locale].flowSources}: ${node.sources.map((source) => {
    const target = resolve(source);
    return target === null ? escapeHtml(source) : `<a href="${escapeHtml(target)}"><code>${escapeHtml(source)}</code></a>`;
  }).join(", ")}</p></section>`).join("");
  const links = flow.links.map(([from, to]) => [cardId(from), cardId(to)]);
  return `<figure class="flow" id="flow-${flow.id}" data-initial="${nodeId(flow.initial)}" style="--flow-cols:${flow.columns.length}">
<figcaption>${escapeHtml(t(flow.label))} <span class="hint">${UI[locale].flowHint}</span></figcaption>
<div class="flow-legend" aria-hidden="true">${legend(locale)}</div>
<div class="flow-graph"><div class="flow-cols"><svg class="flow-links" aria-hidden="true"><defs><marker id="ah-${flow.id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M1 1l6 3-6 3" fill="none" stroke="currentColor" stroke-width="1.25"/></marker></defs><g></g></svg>${columns}</div></div>
<div class="flow-details" aria-live="polite">${details}</div>
${flow.note === undefined ? "" : `<p class="hint">${inline(t(flow.note))}</p>`}
<script type="application/json" class="flow-data">${JSON.stringify(links)}</script>
</figure>`;
}

function legend(locale: Locale): string {
  const names: Record<Locale, Record<NodeKind, string>> = {
    en: { src: "External source", r2: "R2 storage", ai: "AI model", rule: "Rules and code (no model)", web: "Web, schedule and API" },
    "zh-Hant": { src: "外部來源", r2: "R2 儲存", ai: "AI 模型", rule: "規則與程式（不用模型）", web: "網站、排程與 API" },
  };
  return KINDS.map((kind) => `<span><i class="dot ic-${kind}"></i>${names[locale][kind]}</span>`).join("");
}

// ---------------------------------------------------------------------------------------------
// HTML shells

const FONTS = "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap";
const FONTS_TC = "https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&display=swap";

const THEME_SCRIPT = `(function(){var r=document.documentElement,q=window.matchMedia?matchMedia("(prefers-color-scheme: dark)"):null,K="osskb-docs.theme";function c(){try{var v=localStorage.getItem(K);return v==="light"||v==="dark"?v:null}catch(e){return null}}function a(){var v=c();r.dataset.theme=v||(q&&q.matches?"dark":"light")}r.classList.add("js");a();if(q&&q.addEventListener)q.addEventListener("change",a);window.__docsTheme=function(){var n=r.dataset.theme==="dark"?"light":"dark";try{localStorage.setItem(K,n)}catch(e){}r.dataset.theme=n}})();`;

function head(tokens: { light: string; dark: string }, locale: Locale | null, title: string, description: string, extra = ""): string {
  return `<!doctype html>
<html lang="${locale ?? "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<script>${THEME_SCRIPT}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">${locale === "zh-Hant" ? `\n<link rel="stylesheet" href="${FONTS_TC}">` : ""}
${extra}<style>:root{${tokens.light}}:root[data-theme="dark"]{${tokens.dark}}@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${tokens.dark}}}${CSS}</style>
</head>`;
}

function pageHtml(input: DocsInput, tokens: { light: string; dark: string }, locale: Locale, page: PageId, rendered: Rendered): string {
  const ui = UI[locale];
  const other = locale === "en" ? "zh-Hant" : "en";
  const plain = (text: string) => text.replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1").replace(/\*\*|`/gu, "");
  const title = page === "index" ? ui.site : `${plain(rendered.title)} · ${ui.site}`;
  const alternates = LOCALES.map((l) => `<link rel="alternate" hreflang="${l}" href="${SITE_URL}/${l}/${pageFile(page)}">`).join("\n") + "\n";
  const nav = PAGES.map((p) => `<a href="${pageFile(p)}"${p === page ? ' aria-current="page"' : ""}>${ui.nav[p]}</a>`).join("");
  const toc = rendered.toc.length === 0 ? "" : `<nav class="toc" aria-label="${ui.toc}"><p>${ui.toc}</p>${rendered.toc.map((entry) => `<a href="#${entry.id}">${entry.title}</a>`).join("")}</nav>`;
  const resolve = linkResolver(input, () => undefined);
  return `${head(tokens, locale, title, plain(rendered.lede), alternates)}
<body>
<a class="skip" href="#content">${ui.skip}</a>
<header class="top"><div class="top-in">
<a class="brand" href="index.html"><span class="mark" aria-hidden="true"></span>${ui.site}</a>
<nav class="nav" aria-label="${ui.site}">${nav}</nav>
<div class="tools"><a class="locale" href="../${other}/${pageFile(page)}" hreflang="${other}" lang="${other}" title="${ui.otherTitle}" data-locale="${other}">${ui.other}</a><button class="theme" type="button" onclick="__docsTheme()" aria-label="${ui.theme}" title="${ui.theme}"><span aria-hidden="true">◐</span></button></div>
</div></header>
<div class="layout">
${toc}
<main id="content">
<h1>${renderInline(rendered.title, resolve)}</h1>
<p class="lede">${renderInline(rendered.lede, resolve)}</p>
${rendered.body}
</main>
</div>
<footer class="foot"><p>${ui.built} <a href="https://github.com/${input.repository}/commit/${input.commit.sha}"><code>${short(input.commit.sha)}</code></a> (${input.commit.date.slice(0, 10)}) ${ui.of} <a href="https://github.com/${input.repository}">${input.repository}</a>. ${ui.sources}</p></footer>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
}

function rootHtml(tokens: { light: string; dark: string }): string {
  return `${head(tokens, null, "OSS Knowledge Base · Docs", "Documentation of the OSS Knowledge Base: system, search, digest, process and cost.",
    `<script>(function(){var l="en";try{var s=localStorage.getItem("osskb-docs.locale");if(s==="en"||s==="zh-Hant")l=s;else{var n=(navigator.languages||[navigator.language||""]).join(",").toLowerCase();if(/zh-(tw|hant|hk|mo)/.test(n))l="zh-Hant"}}catch(e){}location.replace(l+"/index.html")})();</script>
<noscript><meta http-equiv="refresh" content="0; url=en/index.html"></noscript>
`)}
<body><main id="content" class="root"><h1>OSS Knowledge Base · Docs</h1><p><a href="en/index.html" hreflang="en">English</a> · <a href="zh-Hant/index.html" hreflang="zh-Hant" lang="zh-Hant">繁體中文</a></p></main></body>
</html>
`;
}

function notFoundHtml(tokens: { light: string; dark: string }): string {
  return `${head(tokens, null, "Not found · OSS Knowledge Base · Docs", "Page not found.")}
<body><main id="content" class="root"><h1>${UI.en.notFound} · <span lang="zh-Hant">${UI["zh-Hant"].notFound}</span></h1><p><a href="/en/index.html">${UI.en.home}</a> · <a href="/zh-Hant/index.html" lang="zh-Hant">${UI["zh-Hant"].home}</a></p></main></body>
</html>
`;
}

/** Flow selection, connector drawing, and keeping the URL fragment when switching locale. */
const PAGE_SCRIPT = `(function(){
function show(fig,id,focus){var d=fig.querySelector('.flow-detail[id="'+id+'"]');if(!d)return false;fig.querySelectorAll('.flow-detail').forEach(function(x){x.classList.toggle('is-active',x===d)});fig.querySelectorAll('.flow-node').forEach(function(n){n.setAttribute('aria-current',n.dataset.node===id?'true':'false')});if(focus)d.focus({preventScroll:true});return true}
function draw(fig){var cols=fig.querySelector('.flow-cols'),svg=fig.querySelector('.flow-links'),g=svg.querySelector('g');if(getComputedStyle(svg).display==='none'){g.innerHTML='';return}var links=JSON.parse(fig.querySelector('.flow-data').textContent),o=cols.getBoundingClientRect(),H=20,m=svg.querySelector('marker').id;
g.innerHTML=links.map(function(l){var a=document.getElementById(l[0]),b=document.getElementById(l[1]);if(!a||!b)return'';var A=a.getBoundingClientRect(),B=b.getBoundingClientRect();
if(Math.abs(A.left-B.left)<4){var x=A.left+A.width/2-o.left;return'<path d="M'+x+' '+(A.bottom-o.top)+'V'+(B.top-o.top-2)+'" marker-end="url(#'+m+')"/>'}
var back=B.left<A.left,x1=(back?A.left:A.right)-o.left,y1=A.top-o.top+H,x2=(back?B.right+2:B.left-2)-o.left,y2=B.top-o.top+H,mx=x1+(x2-x1)/2,r=Math.min(8,Math.abs(y2-y1)/2),dy=y2>y1?r:-r,sx=x2>x1?1:-1;
var d=Math.abs(y2-y1)<1?'M'+x1+' '+y1+'H'+x2:'M'+x1+' '+y1+'H'+(mx-sx*r)+'Q'+mx+' '+y1+' '+mx+' '+(y1+dy)+'V'+(y2-dy)+'Q'+mx+' '+y2+' '+(mx+sx*r)+' '+y2+'H'+x2;return'<path d="'+d+'" marker-end="url(#'+m+')"/>'}).join('')}
var figs=[].slice.call(document.querySelectorAll('figure.flow'));
figs.forEach(function(fig){var h=location.hash.slice(1);if(!(h&&show(fig,h,false)))show(fig,fig.dataset.initial,false);
fig.querySelectorAll('.flow-node').forEach(function(n){n.addEventListener('click',function(e){e.preventDefault();show(fig,n.dataset.node,false);history.replaceState(null,'','#'+n.dataset.node);var d=fig.querySelector('.flow-details');if(d.getBoundingClientRect().top>innerHeight)d.scrollIntoView({block:'nearest',behavior:'smooth'})})})});
function all(){figs.forEach(draw)}addEventListener('resize',all);(document.fonts?document.fonts.ready:Promise.resolve()).then(all);all();
var loc=document.querySelector('a.locale');if(loc)loc.addEventListener('click',function(){try{localStorage.setItem('osskb-docs.locale',loc.dataset.locale)}catch(e){}if(location.hash)loc.href=loc.getAttribute('href').split('#')[0]+location.hash});
})();`;

const CSS = `
:root{--wa-fuji:#8a7cc0;--wa-fuji-t:rgba(138,124,192,.12);--wa-seiji:#4f9a82;--wa-seiji-t:rgba(79,154,130,.12);--wa-wasure:#4f8fbf;--wa-wasure-t:rgba(79,143,191,.12);--wa-koke:#7d8048;--wa-koke-t:rgba(125,128,72,.14);--wa-beni:#b0485a;--wa-beni-t:rgba(176,72,90,.10);--wa-ai:#3a53b0;--wa-ai-t:rgba(58,83,176,.10)}
:root[data-theme="dark"]{--wa-fuji:#ada2dc;--wa-fuji-t:rgba(173,162,220,.14);--wa-seiji:#7cc3aa;--wa-seiji-t:rgba(124,195,170,.13);--wa-wasure:#8ebfe4;--wa-wasure-t:rgba(142,191,228,.13);--wa-koke:#b7ba84;--wa-koke-t:rgba(183,186,132,.13);--wa-beni:#e3909e;--wa-beni-t:rgba(227,144,158,.12);--wa-ai:#8c9be8;--wa-ai-t:rgba(140,155,232,.12)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--wa-fuji:#ada2dc;--wa-fuji-t:rgba(173,162,220,.14);--wa-seiji:#7cc3aa;--wa-seiji-t:rgba(124,195,170,.13);--wa-wasure:#8ebfe4;--wa-wasure-t:rgba(142,191,228,.13);--wa-koke:#b7ba84;--wa-koke-t:rgba(183,186,132,.13);--wa-beni:#e3909e;--wa-beni-t:rgba(227,144,158,.12);--wa-ai:#8c9be8;--wa-ai-t:rgba(140,155,232,.12)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-top:72px}
body{margin:0;background:var(--surface-page);color:var(--text-body);font:var(--fs-md)/1.7 var(--font-sans)}
html[lang="zh-Hant"] body{font-family:"IBM Plex Sans","Noto Sans TC","PingFang TC",system-ui,sans-serif}
a{color:var(--accent);text-underline-offset:2px}
code{font:400 .86em var(--font-mono);background:var(--surface-chip);border:1px solid var(--border-default);border-radius:var(--radius-sm);padding:0 4px;overflow-wrap:anywhere}
pre{background:var(--surface-sunken);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:12px 14px;overflow-x:auto}
pre code{background:none;border:0;padding:0}
.skip{position:absolute;left:-9999px}.skip:focus{left:16px;top:8px;z-index:20;background:var(--surface-card);padding:6px 10px}
.top{position:sticky;top:0;z-index:10;background:var(--surface-inverse);border-bottom:1px solid var(--border-inverse-strong)}
.top-in{max-width:1360px;margin:0 auto;display:flex;align-items:center;gap:8px 20px;padding:10px 16px;flex-wrap:wrap}
.brand{color:var(--text-inverse);text-decoration:none;font-weight:600;display:flex;align-items:center;gap:8px;white-space:nowrap}
.mark{width:12px;height:12px;border-radius:3px;background:var(--wa-fuji-t);border:1.5px solid var(--wa-fuji)}
.nav{display:flex;gap:4px;flex-wrap:wrap;flex:1}
.nav a,.tools a,.tools button{color:var(--text-inverse-muted);text-decoration:none;font-size:var(--fs-sm);padding:4px 8px;border-radius:var(--radius-md);border:1px solid transparent;background:none;font-family:inherit;cursor:pointer}
.nav a:hover,.tools a:hover,.tools button:hover{color:var(--text-inverse);background:var(--surface-inverse-raised)}
.nav a[aria-current="page"]{color:var(--text-inverse);border-color:var(--border-inverse)}
.tools{display:flex;gap:6px;align-items:center}
.tools .locale{border-color:var(--border-inverse)}
a:focus-visible,button:focus-visible,.flow-node:focus-visible{outline:2px solid var(--focus-ring-inverse);outline-offset:1px}
.layout{max-width:1360px;margin:0 auto;padding:28px 16px 48px;display:grid;grid-template-columns:180px minmax(0,1fr);gap:32px}
.toc{position:sticky;top:76px;align-self:start;display:grid;gap:2px;font-size:var(--fs-sm)}
.toc p{margin:0 0 6px;font-size:var(--fs-2xs);letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted)}
.toc a{color:var(--text-secondary);text-decoration:none;padding:3px 8px;border-left:2px solid var(--border-default)}
.toc a:hover{color:var(--accent);border-left-color:var(--wa-fuji)}
main{min-width:0}
main>p,main>ul,main>ol,main>aside,main>h2,main>h3,main>h4,main>pre,.lede{max-width:76ch}
h1{font:600 var(--fs-display)/1.25 var(--font-sans);color:var(--text-strong);margin:0 0 10px;text-wrap:balance}
.lede{font-size:var(--fs-lg);color:var(--text-secondary);margin:0 0 28px}
h2{font:600 var(--fs-2xl)/1.3 var(--font-sans);color:var(--text-strong);margin:44px 0 10px;padding-top:14px;border-top:1px solid var(--border-default)}
h3{font:600 var(--fs-xl)/1.35 var(--font-sans);color:var(--text-primary);margin:28px 0 6px}
h4{font:600 var(--fs-lg)/1.4 var(--font-sans);margin:20px 0 4px}
.anchor{margin-left:8px;color:var(--icon-muted);text-decoration:none;opacity:0;font-weight:400}
h2:hover .anchor,h3:hover .anchor,h4:hover .anchor{opacity:1}
li{margin:3px 0}
strong{color:var(--text-strong);font-weight:600}
.note{background:var(--wa-seiji-t);border:1px solid var(--wa-seiji);border-radius:var(--radius-lg);padding:2px 14px;margin:16px 0}
.note p{margin:10px 0}
.table-wrap{overflow-x:auto;margin:14px 0;border:1px solid var(--border-default);border-radius:var(--radius-lg);background:var(--surface-card)}
table{border-collapse:collapse;width:100%;font-size:var(--fs-sm)}
th,td{text-align:left;vertical-align:top;padding:8px 12px;border-bottom:1px solid var(--border-subtle)}
thead th{background:var(--surface-sunken);color:var(--text-secondary);font-weight:600;font-size:var(--fs-xs);white-space:nowrap}
tbody th{font-weight:500;color:var(--text-primary)}
tbody tr:last-child>*{border-bottom:0}
td{font-variant-numeric:tabular-nums}
.foot{border-top:1px solid var(--border-default);color:var(--text-muted);font-size:var(--fs-xs)}
.foot p{max-width:1360px;margin:0 auto;padding:16px}
.root{max-width:640px;margin:15vh auto;padding:0 16px}
.flow{margin:18px 0 26px;display:grid;gap:12px}
.flow figcaption{font-weight:600;color:var(--text-strong)}
.hint{color:var(--text-muted);font-size:var(--fs-xs);font-weight:400}
.flow-legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:var(--fs-xs);color:var(--text-secondary)}
.flow-legend span{display:inline-flex;align-items:center;gap:6px}
.dot{width:10px;height:10px;border-radius:3px;border:1px solid}
.flow-graph{background:var(--surface-card);border:1px solid var(--border-default);border-radius:var(--radius-xl);padding:20px;overflow-x:auto}
.flow-cols{position:relative;display:grid;grid-template-columns:repeat(var(--flow-cols),minmax(200px,270px));column-gap:clamp(36px,4vw,110px);justify-content:space-between;justify-content:safe center;align-items:start;min-width:calc(var(--flow-cols)*200px + (var(--flow-cols) - 1)*36px)}
.flow-links{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;color:var(--icon-muted)}
.flow-links path{fill:none;stroke:currentColor;stroke-width:1.25}
.flow-col{display:grid;gap:28px;position:relative;z-index:1}
.flow-col-title{margin:0 0 -16px;font-size:var(--fs-2xs);letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted)}
.flow-card{background:var(--surface-card);border:1px solid var(--border-strong);border-radius:var(--radius-xl);overflow:hidden}
.flow-card-h{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border-default);font-weight:600;font-size:var(--fs-sm);color:var(--text-strong);min-height:40px}
.count{font:500 var(--fs-2xs) var(--font-mono);background:var(--surface-sunken);border:1px solid var(--border-default);border-radius:5px;padding:0 6px;color:var(--text-muted)}
.flow-node{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;padding:7px 12px;color:inherit;text-decoration:none;border-top:1px solid var(--border-subtle)}
.flow-card-h+.flow-node{border-top:0}
.flow-node:hover{background:var(--surface-chip)}
.flow-node[aria-current="true"]{background:var(--wa-fuji-t);box-shadow:inset 3px 0 0 var(--wa-fuji)}
.ic{width:24px;height:22px;border-radius:6px;display:grid;place-items:center;font:500 10.5px var(--font-mono);border:1px solid}
.ic-src{color:var(--wa-wasure);background:var(--wa-wasure-t);border-color:var(--wa-wasure)}
.ic-r2{color:var(--wa-koke);background:var(--wa-koke-t);border-color:var(--wa-koke)}
.ic-ai{color:var(--wa-fuji);background:var(--wa-fuji-t);border-color:var(--wa-fuji)}
.ic-rule{color:var(--wa-seiji);background:var(--wa-seiji-t);border-color:var(--wa-seiji)}
.ic-web{color:var(--wa-ai);background:var(--wa-ai-t);border-color:var(--wa-ai)}
.nm b{display:block;font-weight:500;font-size:var(--fs-sm);line-height:1.35;color:var(--text-primary)}
.nm small{display:block;color:var(--text-muted);font:400 var(--fs-2xs)/1.4 var(--font-mono);overflow-wrap:anywhere}
.tag{font-size:10.5px;font-weight:500;border-radius:999px;padding:0 7px;white-space:nowrap;border:1px solid;line-height:1.6;vertical-align:middle}
.tag-dev{color:var(--wa-beni);background:var(--wa-beni-t)}
.tag-on{color:var(--wa-seiji);background:var(--wa-seiji-t)}
.tag-off{color:var(--text-muted);background:var(--surface-sunken)}
.flow-details{display:grid;gap:10px}
.flow-detail{background:var(--surface-card);border:1px solid var(--border-default);border-left:3px solid var(--wa-fuji);border-radius:var(--radius-lg);padding:12px 16px;display:grid;gap:8px}
.js .flow-detail{display:none}.js .flow-detail.is-active{display:grid}
.flow-detail h3{margin:0;font-size:var(--fs-lg)}
.flow-detail .lead{margin:0;max-width:80ch}
.kv{display:grid;grid-template-columns:minmax(7em,max-content) 1fr;gap:4px 16px;margin:0;font-size:var(--fs-sm)}
.kv dt{color:var(--text-muted)}
.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.flow-src{margin:0;font-size:var(--fs-xs);color:var(--text-muted)}
@media (max-width:1060px){.layout{grid-template-columns:minmax(0,1fr)}.toc{display:none}}
@media (max-width:760px){
.flow-cols{grid-template-columns:minmax(0,1fr);min-width:0;row-gap:18px}
.flow-col{gap:12px}.flow-col-title{margin:6px 0 0}
.flow-links{display:none}
.flow-graph{padding:12px}
.kv{grid-template-columns:1fr}.kv dt{margin-top:4px}
h2{font-size:var(--fs-xl)}
.layout{padding-top:20px}
.top{position:static}.top-in{gap:6px 10px;padding:8px 12px}.brand{order:1}.tools{order:2;margin-left:auto}.nav{order:3;flex:1 1 100%;flex-wrap:nowrap;overflow-x:auto}.nav a{white-space:nowrap}
html{scroll-padding-top:8px}
}
@media (prefers-reduced-motion:no-preference){.flow-node{transition:background .15s}}
`;

// ---------------------------------------------------------------------------------------------
// Audit of the built site

const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["an email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[A-Za-z]{2,}/u],
  ["a GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/u],
  ["an AWS key id", /\bAKIA[0-9A-Z]{16}\b/u],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
  ["a bearer credential", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/u],
  ["a secret assignment", /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*[=:]\s*["']?[A-Za-z0-9_\-./+]{12,}/u],
];

/** Cost-bearing or write endpoints the docs must not advertise (Spec 025 Behavior 9). */
export const UNADVERTISED: readonly (readonly [string, RegExp])[] = [
  ["a Worker hostname (its POST routes spend money)", /\.workers\.dev\b/u],
  ["a manual trigger route", /\/(?:digest|search-embedding|review-queue|github-reviews)\/(?:run|backfill|refresh-areas)(?![\w.])|\bPOST\s+\/run\b/u],
  ["the manual trigger secret", /MANUAL_TRIGGER_TOKEN/u],
  ["a link to a Dev API", /oss-knowledge-base-dev\.pages\.dev\/api\//u],
];

export function auditSite(files: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const idsOf = new Map<string, Set<string>>();
  const ids = (path: string) => {
    let found = idsOf.get(path);
    if (found === undefined) {
      found = new Set([...(files.get(path) ?? "").matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]!));
      idsOf.set(path, found);
    }
    return found;
  };
  for (const [path, content] of files) {
    for (const [what, pattern] of SECRET_PATTERNS) {
      const match = pattern.exec(content);
      if (match !== null) problems.push(`${path}: contains ${what}: ${match[0].slice(0, 12)}…`);
    }
    for (const [what, pattern] of UNADVERTISED) {
      const match = pattern.exec(content);
      if (match !== null) problems.push(`${path}: advertises ${what}: ${match[0]}`);
    }
    if (!path.endsWith(".html")) continue;
    const scripts = content.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, (tag) => tag.startsWith("<script src") || /<script[^>]*\ssrc=/u.test(tag.slice(0, tag.indexOf(">") + 1)) ? tag : "<script></script>");
    for (const match of scripts.matchAll(/<(link|script|img|iframe|source|video|audio|embed|object)\b[^>]*?\s(?:href|src|data)="([^"]*)"/gu)) {
      const [tag, url] = [match[1]!, match[2]!];
      if (tag === "link" && /\srel="(?:alternate|preconnect)"/u.test(match[0])) continue;
      if (/^(?:https?:)?\/\//u.test(url)) {
        const host = new URL(url, "https://x.invalid").hostname;
        if (!(ALLOWED_RESOURCE_HOSTS as readonly string[]).includes(host)) problems.push(`${path}: loads an external resource from ${host}`);
      } else if (!files.has(resolveRelative(path, url).file)) problems.push(`${path}: <${tag}> points to a missing file ${url}`);
    }
    for (const match of scripts.matchAll(/url\(\s*["']?([^"')]+)/gu)) {
      if (/^(?:https?:)?\/\//u.test(match[1]!)) problems.push(`${path}: CSS loads an external resource ${match[1]}`);
    }
    for (const match of scripts.matchAll(/<a\b[^>]*?\shref="([^"]*)"/gu)) {
      const url = match[1]!.replaceAll("&amp;", "&");
      if (/^(?:https?:|mailto:)/u.test(url)) continue;
      if (/^[a-z][a-z0-9+.-]*:/iu.test(url)) {
        problems.push(`${path}: link with a disallowed scheme ${url}`);
        continue;
      }
      const target = resolveRelative(path, url);
      if (!files.has(target.file)) problems.push(`${path}: broken link ${url}`);
      else if (target.fragment !== "" && !ids(target.file).has(decodeURIComponent(target.fragment))) problems.push(`${path}: link ${url} names a missing anchor`);
    }
  }
  problems.push(...parityProblems(files));
  return problems;
}

function resolveRelative(from: string, url: string): { file: string; fragment: string } {
  const [pathAndQuery, fragment = ""] = url.split("#", 2) as [string, string | undefined];
  const path = pathAndQuery.split("?")[0]!;
  if (path === "") return { file: from, fragment };
  const parts = path.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  let file = parts.join("/");
  if (path.endsWith("/") || file === "") file = file === "" ? "index.html" : `${file}/index.html`;
  return { file, fragment };
}

/** Same page in both locales: present, toggles to its counterpart, same section ids, same flows, same sources. */
export function parityProblems(files: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const facts = (html: string) => ({
    lang: /<html lang="([^"]+)"/u.exec(html)?.[1],
    toggle: /<a class="locale" href="([^"]+)"/u.exec(html)?.[1],
    sections: [...html.matchAll(/<h2 id="([^"]+)"/gu)].map((match) => match[1]!).join(","),
    flows: [...html.matchAll(/<figure class="flow" id="([^"]+)"/gu)].map((match) => match[1]!).join(","),
    sources: [...new Set([...html.matchAll(/href="https:\/\/github\.com\/[^/]+\/[^/]+\/(?:blob|tree)\/[0-9a-f]+\/([^"#]+)/gu)].map((match) => match[1]!))].sort().join(","),
  });
  for (const page of PAGES) {
    const [en, zh] = LOCALES.map((locale) => files.get(`${locale}/${pageFile(page)}`));
    if (en === undefined || zh === undefined) {
      problems.push(`${page}: missing in ${en === undefined ? "en" : "zh-Hant"}`);
      continue;
    }
    const [a, b] = [facts(en), facts(zh)];
    if (a.lang !== "en" || b.lang !== "zh-Hant") problems.push(`${page}: wrong lang attribute`);
    if (a.toggle !== `../zh-Hant/${pageFile(page)}`) problems.push(`en/${page}: locale toggle points to ${a.toggle}`);
    if (b.toggle !== `../en/${pageFile(page)}`) problems.push(`zh-Hant/${page}: locale toggle points to ${b.toggle}`);
    if (a.sections !== b.sections) problems.push(`${page}: section ids differ between locales (en: ${a.sections}; zh-Hant: ${b.sections})`);
    if (a.flows !== b.flows) problems.push(`${page}: flows differ between locales`);
    if (a.sources !== b.sources) {
      const [left, right] = [new Set(a.sources.split(",")), new Set(b.sources.split(","))];
      problems.push(`${page}: cited sources differ between locales (only en: ${[...left].filter((s) => !right.has(s)).join(" ") || "—"}; only zh-Hant: ${[...right].filter((s) => !left.has(s)).join(" ") || "—"})`);
    }
  }
  return problems;
}
