/**
 * Spec 020: one ref's tree → structured data (`data.json`) → one self-contained page (`index.html`).
 * Reads only files of the tree it is given, and no clock: the same tree and metadata give the same bytes.
 */
import { posix } from "node:path";
import { escapeHtml, parseMarkdown, plainText, renderInline, type Block, type Section, type Table } from "./markdown";
import { switcherScript } from "./switcher";
import { acceptanceItems } from "../acceptance-items";

export type RefKind = "branch" | "tag";

export interface RefMeta {
  readonly name: string;
  /** Directory of the ref's page in the site. */
  readonly slug: string;
  readonly kind: RefKind;
  readonly sha: string;
  /** Commit time, ISO 8601 in UTC. */
  readonly date: string;
}

/** The files of one ref: a directory on disk or a git revision (site.ts). */
export interface TreeReader {
  /** The file's text, or null when the tree has no such file. */
  read(path: string): string | null;
  /** Names directly inside a directory, sorted; empty when it does not exist. */
  list(directory: string): readonly string[];
}

export type StatusKind = "draft" | "accepted" | "partial" | "implemented" | "other";

/**
 * Where a spec stands for a reader outside the project (the status board). Derived, never written:
 * from the spec's Status line, its `[pending]` acceptance items, whether its directory is in the
 * tree of the ref Prod runs (the newest `v*` tag), and the Deployed configuration rows that name it.
 */
export type Stage = "prod" | "dev" | "pages" | "progress" | "planned" | "other";

/** The ref Prod is deployed from: the newest `v*` tag of the site (`.github/workflows/ci.yml` deploys Prod on a `v*` tag). */
export interface ProductionRef {
  readonly name: string;
  readonly sha: string;
  readonly date: string;
  /** Spec directories in that tag's tree. */
  readonly specDirectories: readonly string[];
}

export interface SpecEntry {
  readonly number: string;
  readonly directory: string;
  readonly path: string;
  readonly title: string;
  /** The spec's `Status:` line, as written. */
  readonly status: string;
  readonly statusKind: StatusKind;
  /** From the feature map's "Acceptance IDs by spec" row, when it has one. */
  readonly acceptanceIds: string | null;
  readonly surface: string | null;
  /** The "Runs on" cell of that row (`Prod`, `Dev`, `GitHub Pages`, `none`), when the table has the column. */
  readonly runsOn: string | null;
  /** Acceptance items the traceability gate reads (enforced specs only), and how many are `[pending]`. */
  readonly acceptanceItems: number;
  readonly pending: number;
  /** Whether the spec's directory is in the production ref's tree. */
  readonly inProduction: boolean;
  /** Names of the Deployed configuration rows that name this spec and are unset (or absent) on Prod. */
  readonly offOnProd: readonly string[];
  readonly stage: Stage;
}

export interface GardeningItem {
  readonly id: string;
  readonly title: string;
  readonly anchor: string;
  readonly category: string;
  /** First words of the item's Layer field: where its fix belongs. */
  readonly layer: string | null;
  readonly fields: readonly { readonly label: string; readonly text: string }[];
}

export interface SiteData {
  readonly schema: "feature-map-site.data.v1";
  readonly repository: string;
  readonly ref: RefMeta;
  /** The ref Prod runs, or null when the site has no `v*` tag that could be read. */
  readonly production: Omit<ProductionRef, "specDirectories"> | null;
  readonly status: "ok" | "no-feature-map";
  /** What this tree does not have, in the order found. */
  readonly notes: readonly string[];
  /** "Runs on" values that claim more than the evidence (B27); the site build fails on the default ref's. */
  readonly runsOnErrors: readonly string[];
  readonly featureMap: { readonly path: string; readonly title: string | null; readonly sections: readonly Section[] } | null;
  readonly deployedConfiguration: Table | null;
  readonly schedules: Table | null;
  readonly specs: readonly SpecEntry[];
  readonly gardening: { readonly path: string; readonly lastFullPass: string | null; readonly items: readonly GardeningItem[] } | null;
  readonly counts: {
    readonly specs: number;
    readonly specsByStatus: Readonly<Record<StatusKind, number>>;
    readonly specsByStage: Readonly<Record<Stage, number>>;
    readonly gardeningItems: number;
    readonly featureMapSections: number;
    readonly schedules: number;
    readonly deployedNames: number;
  };
}

export const FEATURE_MAP = "docs/feature-map.md";
export const GARDENING = "docs/gardening.md";
export const SPECS = "docs/specs";
const DEPLOYED = "Deployed configuration";
const SCHEDULES = "Schedules";
const ACCEPTANCE = "Acceptance IDs by spec";

const sectionNamed = (sections: readonly Section[], title: string) =>
  sections.find((section) => section.title.toLowerCase() === title.toLowerCase());

function tableOf(section: Section | undefined): Table | null {
  const table = section?.blocks.find((block) => block.type === "table");
  return table === undefined || table.type !== "table" ? null : { headers: table.headers, rows: table.rows };
}

export function statusKind(status: string): StatusKind {
  if (/^implemented/iu.test(status)) return "implemented";
  if (/^partially implemented/iu.test(status)) return "partial";
  if (/^accepted/iu.test(status)) return "accepted";
  if (/^draft/iu.test(status)) return "draft";
  return "other";
}

/**
 * The board's rule (Spec 020 B19, test plan): pending work or a partial status is in progress;
 * an implemented spec is on Prod when the production tag has it and no flag naming it is off there,
 * else on Dev only (Dev deploys every push to `main`); accepted or draft is planned.
 */
export function specStage(input: {
  readonly statusKind: StatusKind; readonly pending: number; readonly inProduction: boolean; readonly offOnProd: number;
  /** A "Runs on" value that `runsOnError` accepted; a rejected one is passed as null. */
  readonly runsOn?: string | null;
  /** The feature-map-site workflow publishes this spec to GitHub Pages. */
  readonly publishedByPages?: boolean;
}): Stage {
  const { statusKind: kind, pending, inProduction, offOnProd } = input;
  if (kind === "implemented" || kind === "partial") {
    if (kind === "partial" || pending > 0) return "progress";
    // "Runs on" can only narrow what the evidence allows (runsOnError), so taking it here never widens.
    const runsOn = input.runsOn?.trim() ?? "";
    if (/^GitHub Pages\b/iu.test(runsOn)) return "pages";
    if (/^Prod\b/iu.test(runsOn)) return "prod";
    if (/^Dev\b/iu.test(runsOn)) return "dev";
    if (/^none\b/iu.test(runsOn)) return "other";
    if (input.publishedByPages === true) return "pages";
    return inProduction && offOnProd === 0 ? "prod" : "dev";
  }
  if (kind === "accepted" || kind === "draft") return "planned";
  return pending > 0 ? "progress" : "other";
}

export const RUNS_ON = ["Prod", "Dev", "GitHub Pages", "none"] as const;

/**
 * Spec 020 B27: a "Runs on" value may only narrow what the evidence allows, never widen it.
 * `Prod` needs the spec's directory in the production tag and no Deployed configuration row naming it
 * off on Prod; `GitHub Pages` needs the feature-map-site workflow to publish it; `Prod`, `Dev` and
 * `GitHub Pages` need the spec implemented (or partially) on this ref. `none` is always allowed, and so
 * is `Dev` for a spec in the Prod tag (narrowing). Returns why the value contradicts the evidence, or null.
 */
export function runsOnError(input: {
  readonly number: string; readonly claim: string | null; readonly status: string; readonly statusKind: StatusKind;
  readonly inProduction: boolean; readonly offOnProd: readonly string[]; readonly production: string | null;
  readonly pagesSpecs: readonly string[];
}): string | null {
  if (input.claim === null) return null;
  const claim = RUNS_ON.find((value) => new RegExp(`^${value}\\b`, "iu").test(input.claim!.trim()));
  const said = `Spec ${input.number}: Runs on "${input.claim}"`;
  if (claim === undefined) return `${said} is not one of ${RUNS_ON.join(", ")}`;
  if (claim === "none") return null;
  if (input.statusKind !== "implemented" && input.statusKind !== "partial") {
    return `${said} contradicts its Status, which is not implemented: "${input.status}"`;
  }
  if (claim === "Prod") {
    if (input.production === null) return `${said} cannot be confirmed: this build has no readable v* tag`;
    if (!input.inProduction) return `${said} contradicts the evidence: its directory is not in ${input.production}`;
    if (input.offOnProd.length > 0) return `${said} contradicts the evidence: Deployed configuration ${input.offOnProd.join(", ")} unset or none on Prod`;
  }
  if (claim === "GitHub Pages" && !input.pagesSpecs.includes(input.number)) {
    return `${said} contradicts the evidence: ${PAGES_WORKFLOW} publishes ${input.pagesSpecs.length === 0 ? "no spec" : input.pagesSpecs.map((number) => `Spec ${number}`).join(", ")}`;
  }
  return null;
}

/** The workflow that publishes the feature-map site to GitHub Pages; the specs its file cites are what it publishes. */
export const PAGES_WORKFLOW = ".github/workflows/feature-map-site.yml";

export function pagesSpecs(tree: TreeReader): string[] {
  const text = tree.read(PAGES_WORKFLOW);
  return text === null ? [] : [...new Set([...text.matchAll(/\bSpec (\d{3})\b/gu)].map((match) => match[1]!))].sort();
}

/** Spec number → names of the Deployed configuration rows that cite `Spec <number>` and whose Prod cell is unset or none. */
export function offOnProd(deployed: Table | null): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  const prod = deployed?.headers.findIndex((header) => plainText(header).trim().toLowerCase() === "prod") ?? -1;
  if (deployed === null || prod < 0) return result;
  for (const row of deployed.rows) {
    if (!/^(unset|none)\b/iu.test(plainText(row[prod] ?? "").trim())) continue;
    const names = [...(row[0] ?? "").matchAll(/`([^`]+)`/gu)].map((match) => match[1]!);
    if (names.length === 0) names.push(plainText(row[0] ?? "").trim());
    for (const number of new Set([...row.join(" ").matchAll(/\bSpecs? (\d{3})\b/gu)].map((match) => match[1]!))) {
      const list = result.get(number) ?? [];
      for (const name of names) if (!list.includes(name)) list.push(name);
      result.set(number, list);
    }
  }
  return result;
}

function readSpecs(tree: TreeReader, acceptance: Table | null, deployed: Table | null, production: ProductionRef | null, errors: string[]): SpecEntry[] {
  const off = offOnProd(deployed);
  const published = pagesSpecs(tree);
  const runsOnColumn = acceptance?.headers.findIndex((header) => plainText(header).trim().toLowerCase() === "runs on") ?? -1;
  const rows = new Map<string, readonly string[]>();
  for (const row of acceptance?.rows ?? []) {
    const number = /^\[(\d{3})\]\(/u.exec(row[0] ?? "")?.[1];
    if (number !== undefined) rows.set(number, row);
  }
  const specs: SpecEntry[] = [];
  for (const directory of [...tree.list(SPECS)].sort()) {
    const number = /^(\d{3})-/u.exec(directory)?.[1];
    if (number === undefined) continue;
    const path = `${SPECS}/${directory}/spec.md`;
    const text = tree.read(path);
    if (text === null) continue;
    const head = text.split("\n", 40);
    const heading = head.find((line) => /^#\s+/u.test(line))?.replace(/^#\s+/u, "").trim() ?? directory;
    const status = head.map((line) => /^(?:[-*]\s+)?(?:\*\*)?Status(?:\*\*)?:\s*(?:\*\*)?\s*(.+?)\s*$/iu.exec(line)?.[1])
      .find((value) => value !== undefined) ?? "";
    const row = rows.get(number);
    const items = acceptanceItems(path, text);
    const pending = items.filter((item) => item.tag === "pending").length;
    const kind = statusKind(status);
    const inProduction = production?.specDirectories.includes(directory) ?? false;
    const offNames = off.get(number) ?? [];
    const claim = runsOnColumn < 0 || row === undefined ? null : plainText(row[runsOnColumn] ?? "").trim() || null;
    const error = runsOnError({ number, claim, status, statusKind: kind, inProduction, offOnProd: offNames, production: production?.name ?? null, pagesSpecs: published });
    if (error !== null) errors.push(error);
    specs.push({
      number, directory, path,
      title: heading.replace(/^Spec\s+\d+\s*[:—-]\s*/iu, ""),
      status, statusKind: kind,
      acceptanceIds: row?.[1] ?? null,
      surface: row?.[2] ?? null,
      runsOn: claim,
      acceptanceItems: items.length,
      pending,
      inProduction,
      offOnProd: offNames,
      stage: specStage({ statusKind: kind, pending, inProduction, offOnProd: offNames.length, runsOn: error === null ? claim : null, publishedByPages: published.includes(number) }),
    });
  }
  return specs;
}

function readGardening(text: string): NonNullable<SiteData["gardening"]> {
  const sections = parseMarkdown(text);
  const items: GardeningItem[] = [];
  let category = "";
  let lastFullPass: string | null = null;
  for (const section of sections) {
    if (section.level === 2) category = section.title;
    if (section.level <= 1) {
      for (const block of section.blocks) {
        const pass = block.type === "paragraph" ? /^Last full pass:\s*(.*?\.)(?:\s|$)/u.exec(block.text)?.[1] : undefined;
        if (pass !== undefined) lastFullPass = pass;
      }
    }
    const item = /^(G\d+)\.\s+(.*)$/u.exec(section.title);
    if (section.level !== 3 || item === null) continue;
    const fields: { label: string; text: string }[] = [];
    for (const block of section.blocks) {
      if (block.type !== "list") continue;
      for (const entry of block.items) {
        const field = /^\*\*([^*:]+):\*\*\s*(.*)$/u.exec(entry.text);
        if (field !== null && entry.depth === 0) fields.push({ label: field[1]!, text: field[2]! });
        else if (fields.length > 0) fields[fields.length - 1]!.text += ` ${entry.text}`;
      }
    }
    const layerText = fields.find((field) => field.label === "Layer")?.text;
    const layer = layerText === undefined ? null : plainText(layerText).split(/ \(|[,;:.]| plus | then /u)[0]!.trim().toLowerCase();
    items.push({ id: item[1]!, title: item[2]!, anchor: section.anchor, category, layer: layer === "" ? null : layer, fields });
  }
  return { path: GARDENING, lastFullPass, items };
}

export function buildData(input: { readonly repository: string; readonly ref: RefMeta; readonly tree: TreeReader; readonly production?: ProductionRef | null }): SiteData {
  const { repository, ref, tree } = input;
  const production = input.production ?? null;
  const notes: string[] = [];
  const mapText = tree.read(FEATURE_MAP);
  let featureMap: SiteData["featureMap"] = null;
  let deployedConfiguration: Table | null = null;
  let schedules: Table | null = null;
  let acceptance: Table | null = null;
  if (mapText === null) {
    notes.push(`${FEATURE_MAP} is not in this tree`);
  } else {
    const sections = parseMarkdown(mapText);
    featureMap = { path: FEATURE_MAP, title: sections.find((section) => section.level === 1)?.title ?? null, sections };
    deployedConfiguration = tableOf(sectionNamed(sections, DEPLOYED));
    schedules = tableOf(sectionNamed(sections, SCHEDULES));
    acceptance = tableOf(sectionNamed(sections, ACCEPTANCE));
    if (deployedConfiguration === null) notes.push(`${FEATURE_MAP} has no "${DEPLOYED}" table`);
    if (schedules === null) notes.push(`${FEATURE_MAP} has no "${SCHEDULES}" table`);
  }
  const gardeningText = tree.read(GARDENING);
  if (gardeningText === null) notes.push(`${GARDENING} is not in this tree`);
  const gardening = gardeningText === null ? null : readGardening(gardeningText);
  const runsOnErrors: string[] = [];
  const specs = readSpecs(tree, acceptance, deployedConfiguration, production, runsOnErrors);
  if (specs.length === 0) notes.push(`${SPECS} has no spec`);
  const specsByStatus: Record<StatusKind, number> = { draft: 0, accepted: 0, partial: 0, implemented: 0, other: 0 };
  const specsByStage: Record<Stage, number> = { prod: 0, dev: 0, pages: 0, progress: 0, planned: 0, other: 0 };
  for (const spec of specs) {
    specsByStatus[spec.statusKind] += 1;
    specsByStage[spec.stage] += 1;
  }
  return {
    schema: "feature-map-site.data.v1",
    repository,
    ref: { name: ref.name, slug: ref.slug, kind: ref.kind, sha: ref.sha, date: ref.date },
    production: production === null ? null : { name: production.name, sha: production.sha, date: production.date },
    status: featureMap === null ? "no-feature-map" : "ok",
    notes,
    runsOnErrors,
    featureMap,
    deployedConfiguration,
    schedules,
    specs,
    gardening,
    counts: {
      specs: specs.length,
      specsByStatus,
      specsByStage,
      gardeningItems: gardening?.items.length ?? 0,
      featureMapSections: featureMap?.sections.filter((section) => section.level >= 2).length ?? 0,
      schedules: schedules?.rows.length ?? 0,
      deployedNames: deployedConfiguration?.rows.length ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Page

type Resolve = (url: string) => string | null;

/** Links of a source file: absolute ones as they are, relative ones to the file on GitHub at the page's commit. */
function linker(repository: string, sha: string, sourcePath: string): Resolve {
  const base = `https://github.com/${repository}/blob/${sha}/`;
  return (url) => {
    if (/^(https?:\/\/|mailto:)/iu.test(url)) return url;
    if (/^[a-z][a-z0-9+.-]*:/iu.test(url) || url.startsWith("//")) return null;
    if (url.startsWith("#")) return `${base}${sourcePath}${url}`;
    const [path, hash] = url.split("#", 2) as [string, string | undefined];
    const target = posix.normalize(posix.join(posix.dirname(sourcePath), path));
    if (target.startsWith("..")) return null;
    return `${base}${target}${hash === undefined ? "" : `#${hash}`}`;
  };
}

const LONG_CELL = 240;
const TEASER = 150;

/** A long cell folds to its first words; the whole text is one click away and always in the page. */
function cell(text: string, resolve: Resolve): string {
  const html = renderInline(text, resolve);
  const plain = plainText(text);
  if (plain.length <= LONG_CELL) return html;
  return `<details class="more"><summary><span class="teaser">${escapeHtml(plain.slice(0, TEASER))}…</span><span class="less">收合</span></summary><div>${html}</div></details>`;
}

function renderTable(table: Table, resolve: Resolve): string {
  const head = table.headers.map((header) => `<th>${renderInline(header, resolve)}</th>`).join("");
  const body = table.rows.map((row) =>
    `<tr>${row.map((value, index) => `<td data-label="${escapeHtml(plainText(table.headers[index] ?? ""))}">${cell(value, resolve)}</td>`).join("")}</tr>`).join("\n");
  return `<div class="tw"><table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table></div>`;
}

function renderBlocks(blocks: readonly Block[], resolve: Resolve): string {
  return blocks.map((block) => {
    switch (block.type) {
      case "paragraph": return `<p>${renderInline(block.text, resolve)}</p>`;
      case "quote": return `<blockquote>${renderInline(block.text, resolve)}</blockquote>`;
      case "code": return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
      case "table": return renderTable(block, resolve);
      case "list": {
        const tag = block.items[0]?.ordered === true ? "ol" : "ul";
        return `<${tag}>${block.items.map((item) => `<li class="d${Math.min(item.depth, 3)}">${renderInline(item.text, resolve)}</li>`).join("")}</${tag}>`;
      }
    }
  }).join("\n");
}

const KIND_LABEL: Readonly<Record<RefKind, string>> = { branch: "分支", tag: "標籤" };
const STATUS_LABEL: Readonly<Record<StatusKind, string>> = { draft: "草稿", accepted: "已接受", partial: "部分實作", implemented: "已實作", other: "其他" };

/** The board's groups, in reading order: zh-Hant first, English after, so a reader of either can follow. */
const STAGES: readonly { readonly stage: Stage; readonly zh: string; readonly en: string; readonly rule: string }[] = [
  { stage: "prod", zh: "在 Prod 標籤中", en: "In the Prod tag", rule: "已實作，且在 Prod 部署的標籤中，沒有在 Prod 關閉的設定；Prod 實際提供什麼見下方。Implemented, in the tag Prod is deployed from, and no flag of it is off on Prod; what Prod actually serves is below." },
  { stage: "dev", zh: "僅 Dev", en: "Live on Dev only", rule: "已實作，但 Prod 沒有（在標籤之後才做，或設定只在 Dev 開啟）。Dev 在每次推送到 main 後部署。Implemented, but not on Prod: built after the tag, or switched on for Dev only. Dev deploys every push to main." },
  { stage: "pages", zh: "發佈於 GitHub Pages", en: "Published on GitHub Pages", rule: "已實作，發佈在 GitHub Pages，而不是 Cloudflare 的 Dev 或 Prod（feature map 的 Runs on 欄）。Implemented and published on GitHub Pages, not on the Cloudflare Dev or Prod (the feature map's Runs on column)." },
  { stage: "progress", zh: "進行中", en: "In progress", rule: "部分實作，或仍有標為 [pending] 的驗收項目。Partially implemented, or acceptance items still tagged [pending]." },
  { stage: "planned", zh: "規劃中", en: "Planned", rule: "已接受或草稿，尚未實作。Accepted or draft, not built yet." },
  { stage: "other", zh: "其他", en: "Other", rule: "Status 行不是以 Implemented、Partially implemented、Accepted 或 Draft 開頭，例如已完成的 spike。The Status line starts with none of Implemented, Partially implemented, Accepted or Draft, e.g. a finished spike." },
];

const sentence = (zh: string, en: string) => `${zh} · ${en}`;

function stageReason(spec: SpecEntry, production: SiteData["production"]): string {
  switch (spec.stage) {
    case "pages": return sentence("發佈於 GitHub Pages", "published on GitHub Pages");
    case "prod": if (production === null) return sentence("feature map 標為 Prod", "the feature map says Prod");
      return sentence(`在 <code>${escapeHtml(production!.name)}</code> 中`, `in <code>${escapeHtml(production!.name)}</code>`);
    case "dev": {
      if (spec.offOnProd.length > 0) {
        const names = spec.offOnProd.map((name) => `<code>${escapeHtml(name)}</code>`).join(", ");
        return sentence(`Prod 未開啟 ${names}`, `off on Prod`);
      }
      if (production !== null && !spec.inProduction) return sentence(`<code>${escapeHtml(production.name)}</code> 之後才實作`, `built after <code>${escapeHtml(production.name)}</code>`);
      if (spec.runsOn !== null && /^Dev\b/iu.test(spec.runsOn)) return sentence("feature map 標為 Dev", "runs on Dev");
      if (production === null) return sentence("沒有 v* 標籤", "no v* tag in this build");
      return sentence(`<code>${escapeHtml(production.name)}</code> 之後才實作`, `built after <code>${escapeHtml(production.name)}</code>`);
    }
    case "progress": return spec.pending > 0
      ? sentence(`${spec.pending} / ${spec.acceptanceItems} 項驗收待做`, `${spec.pending} of ${spec.acceptanceItems} acceptance items pending`)
      : sentence("部分實作", "partially implemented");
    case "planned": return sentence("尚未實作", "not built");
    case "other": return renderInline(spec.status.split(/[(:;]/u)[0]!.trim(), () => null);
  }
}

function renderBoard(data: SiteData, sections: readonly Section[], mapLinks: Resolve): string {
  const { repository, ref, production, counts } = data;
  const blob = `https://github.com/${repository}/blob/${ref.sha}/`;
  const shownStages = STAGES.filter(({ stage }) => (stage !== "other" && stage !== "pages") || counts.specsByStage[stage] > 0)
    .map((entry) => entry.stage === "prod" && production !== null ? { ...entry, en: `${entry.en} (${production.name})` } : entry);
  const tiles = shownStages.map(({ stage, zh, en }) =>
    `<a class="tile stage-${stage}" href="#stage-${stage}"><b>${counts.specsByStage[stage]}</b><span>${zh}</span><em>${en}</em></a>`);
  tiles.push(`<a class="tile stage-gaps" href="#stage-gaps"><b>${counts.gardeningItems}</b><span>已知缺口</span><em>Known gaps</em></a>`);
  const groups = shownStages.map(({ stage, zh, en, rule }) => {
    const specs = data.specs.filter((spec) => spec.stage === stage);
    const items = specs.map((spec) => {
      const links = linker(repository, ref.sha, spec.path);
      return `<li><a class="num" href="${escapeHtml(blob + spec.path)}">${spec.number}</a> <span class="t">${renderInline(spec.title, links)}</span> <span class="why">${stageReason(spec, production)}</span></li>`;
    }).join("\n");
    let note = "";
    if (stage === "prod") {
      const environments = tableOf(sectionNamed(sections, "Environments"));
      // The map's "Prod today:" paragraph, printed as it is: what Prod serves, beside the tag's specs.
      const prodToday = sections.flatMap((section) => section.blocks)
        .map((block) => block.type === "paragraph" && /^Prod today:/u.test(block.text) ? block.text : null).find((text) => text !== null) ?? null;
      const row = environments?.rows.find((cells) => /^prod\b/iu.test(plainText(cells[0] ?? "").trim()));
      const describe = row === undefined ? "" : row.slice(1).map((value, index) =>
        `<li><b>${escapeHtml(plainText(environments!.headers[index + 1] ?? ""))}</b>：${renderInline(value, mapLinks)}</li>`).join("");
      note = `<p class="rule">${production === null ? "此建置沒有可讀的 <code>v*</code> 標籤，因此無法判斷 Prod。This build has no readable <code>v*</code> tag, so nothing counts as on Prod." :
        `Prod 由標籤 <code>${escapeHtml(production.name)}</code>（${escapeHtml(formatTime(production.date))}）部署。Prod runs tag <code>${escapeHtml(production.name)}</code>, committed ${escapeHtml(formatTime(production.date))}.`}</p>` +
        (prodToday === null ? "" : `<p class="caveat">${renderInline(prodToday, mapLinks)}</p>`) +
        (describe === "" ? "" : `<details class="more env"><summary>Prod 環境 · Prod environment</summary><ul>${describe}</ul></details>`);
    }
    return `<section class="stage" id="stage-${stage}">
<h3><span class="dot ${stage}"></span>${zh}<small>${en} · ${specs.length}</small></h3>
<p class="rule">${escapeHtml(rule)}</p>${note}
${specs.length === 0 ? `<p class="rule">（無 · none）</p>` : `<ul class="specs-list">
${items}
</ul>`}
</section>`;
  });
  const categories = [...new Set(data.gardening?.items.map((item) => item.category) ?? [])];
  const gaps = categories.map((category, index) => {
    const count = data.gardening!.items.filter((item) => item.category === category).length;
    return `<li><a href="#g-cat-${index + 1}">${renderInline(category, mapLinks)}</a> <span class="why">${count}</span></li>`;
  }).join("\n");
  groups.push(`<section class="stage" id="stage-gaps">
<h3><span class="dot gaps"></span>已知缺口<small>Known gaps · ${counts.gardeningItems}</small></h3>
<p class="rule">尚未處理的 workaround、測試缺口與後續工作，取自 <code>${GARDENING}</code>。Open workarounds, test gaps and follow-ups from the gardening list.</p>
${data.gardening === null ? `<p class="rule">（此版本沒有 · none in this ref）</p>` : `<ul class="specs-list">
${gaps}
</ul>`}
</section>`);
  return `<section id="status">
<h2>現況<small>What is built, in progress and planned</small></h2>
<p class="lede">由各 spec 的 <code>Status:</code> 行、標為 <code>[pending]</code> 的驗收項目、feature map 的 Runs on 欄、Prod 部署的 <code>v*</code> 標籤，以及 Deployed configuration 自動推導，此頁沒有手寫的狀態。Derived on every push from each spec's Status line, its <code>[pending]</code> acceptance items, the feature map's Runs on column, the <code>v*</code> tag Prod is deployed from, and the Deployed configuration; nothing on this page is written by hand.</p>
<div class="tiles board">${tiles.join("")}</div>
<div class="stages">
${groups.join("\n")}
</div>
</section>`;
}
const FIELD_LABEL: Readonly<Record<string, string>> = { Where: "位置", Why: "原因", Fix: "修法", Layer: "防線", Source: "來源" };

export const formatTime = (iso: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso;

const style = `
:root{color-scheme:light dark;--bg:#f6f6f3;--panel:#fff;--ink:#1b1d1f;--mute:#5b6067;--line:#e2e2dc;--accent:#0a6a94;--code:#efefea;
--draft:#8a5a00;--draft-bg:#fbefd2;--accepted:#0b5a8a;--accepted-bg:#dcedf8;--implemented:#1d6b3a;--implemented-bg:#dbf1e2;--other:#555a61;--other-bg:#e8e8e4;--warn-bg:#fff4d6;--warn:#6b4a00;--progress:#6b5a9e}
@media (prefers-color-scheme:dark){:root{--bg:#111315;--panel:#191c1f;--ink:#e7e7e4;--mute:#a1a6ad;--line:#2b3036;--accent:#6fc4e8;--code:#23272b;
--draft:#f0c674;--draft-bg:#3a2e12;--accepted:#8cc8f0;--accepted-bg:#12303f;--implemented:#8fd6a5;--implemented-bg:#143222;--other:#b5bac1;--other-bg:#2a2e33;--warn-bg:#3a2e12;--warn:#f0c674;--progress:#b9a8e6}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI","PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif;overflow-wrap:anywhere}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code,pre{font:0.88em/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
code{background:var(--code);padding:.08em .32em;border-radius:4px}
pre{background:var(--code);padding:12px;border-radius:8px;overflow-x:auto;overflow-wrap:normal}pre code{background:none;padding:0}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px}
header.top{background:var(--panel);border-bottom:1px solid var(--line);padding:18px 0 12px}
.top-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 20px}
h1{font-size:20px;margin:0;font-weight:650}h1 span{color:var(--mute);font-weight:500;margin-left:.4em;white-space:nowrap}
.switch{display:flex;align-items:center;gap:8px;color:var(--mute);font-size:13px}
select{font:inherit;font-size:14px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 10px;max-width:60vw}
.stamp{margin:10px 0 0;color:var(--mute);font-size:13px}.stamp code{color:var(--ink)}
#ref-note{margin-left:.6em}
.banner,.notice{background:var(--warn-bg);color:var(--warn);border-radius:8px;padding:10px 14px;margin:12px 0 0;font-size:14px}
.notice{margin:0 0 14px}
nav.toc{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:12px;font-size:14px}
main{padding:8px 0 40px}
section{margin-top:30px}
h2{font-size:18px;margin:0 0 4px}h2 small,h3 small{color:var(--mute);font-weight:400;font-size:13px;margin-left:.5em}
h3{font-size:15px;margin:20px 0 8px}
.lede{color:var(--mute);margin:0 0 14px;font-size:14px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.tiles.board{grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px}.tiles.board .tile{padding:10px 12px}
a.tile{color:inherit;text-decoration:none;border-top:4px solid var(--line)}a.tile:hover{border-color:var(--accent)}
.tile.stage-prod{border-top-color:var(--implemented)}.tile.stage-dev{border-top-color:var(--accepted)}.tile.stage-progress{border-top-color:var(--progress)}.tile.stage-planned,.tile.stage-other{border-top-color:var(--other)}.tile.stage-gaps{border-top-color:var(--mute)}
.stages{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,460px),1fr));gap:12px;margin-top:14px}
.stage{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 16px}
.stage h3{margin:0 0 4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dot{width:10px;height:10px;border-radius:50%;background:var(--other);flex:none}.dot.prod{background:var(--implemented)}.dot.dev{background:var(--accepted)}.dot.progress{background:var(--progress)}.dot.gaps{background:var(--mute)}
.rule{color:var(--mute);font-size:13px;margin:0 0 8px}
.caveat{font-size:13px;margin:0 0 8px;padding:6px 10px;border-left:3px solid var(--mute);background:var(--bg);border-radius:4px}
.tile.stage-pages{border-top-color:var(--accent)}.dot.pages{background:var(--accent)}
.specs-list{list-style:none;padding:0;margin:6px 0 0}.specs-list li{padding:6px 0;border-top:1px solid var(--line)}
.specs-list .num{font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;margin-right:.3em}
.specs-list .why{display:block;color:var(--mute);font-size:13px}
details.env{font-size:13px;color:var(--mute);margin:0 0 8px}details.env ul{margin:6px 0;padding-left:1.1em}
.tile b{display:block;font-size:26px;line-height:1.2;font-variant-numeric:tabular-nums}
.tile span{color:var(--mute);font-size:13px}.tile em{display:block;font-style:normal;color:var(--mute);font-size:12px;margin-top:4px}
.tw{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow-x:auto;margin:10px 0}
table{border-collapse:collapse;width:100%;font-size:14px;overflow-wrap:break-word}
th,td{text-align:left;vertical-align:top;padding:9px 12px;border-bottom:1px solid var(--line)}
th{font-size:12px;color:var(--mute);font-weight:600;white-space:nowrap;background:var(--bg)}
tbody tr:last-child td{border-bottom:0}
td:first-child{min-width:8em}
table.specs td:nth-child(1){min-width:0;white-space:nowrap}table.specs td:nth-child(2){min-width:13em}table.specs td:nth-child(3){min-width:15em}table.specs td:nth-child(4){min-width:9em}
.badge{display:inline-block;font-size:12px;line-height:1.5;padding:0 8px;border-radius:999px;white-space:nowrap;background:var(--other-bg);color:var(--other)}
.badge.draft{background:var(--draft-bg);color:var(--draft)}.badge.accepted{background:var(--accepted-bg);color:var(--accepted)}.badge.implemented{background:var(--implemented-bg);color:var(--implemented)}
details.more>summary{cursor:pointer;list-style:none}details.more>summary::-webkit-details-marker{display:none}
details.more>summary::after{content:" 展開";color:var(--accent);font-size:12px;white-space:nowrap}
details.more[open]>summary .teaser{display:none}details.more[open]>summary::after{content:""}
details.more .less{display:none;color:var(--accent);font-size:12px}details.more[open] .less{display:inline}
details.sec,details.g{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin:8px 0}
details.sec>summary,details.g>summary{cursor:pointer;padding:10px 14px;font-weight:600}
details.g>summary{font-weight:500}
details.sec>div,details.g>dl{padding:0 14px 12px;margin:0}
details.sec .tw{border-radius:8px}
.crumb{color:var(--mute);font-weight:400}
.gid{font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;margin-right:.5em}
dl{display:grid;grid-template-columns:5em 1fr;gap:6px 12px;font-size:14px}dt{color:var(--mute)}dd{margin:0}
ul,ol{padding-left:1.3em;margin:8px 0}li.d1{margin-left:1.3em}li.d2{margin-left:2.6em}li.d3{margin-left:3.9em}
blockquote{margin:10px 0;padding:6px 14px;border-left:3px solid var(--line);color:var(--mute)}
footer{color:var(--mute);font-size:13px;padding:18px 0 40px;border-top:1px solid var(--line)}
@media (max-width:720px){
.wrap{padding:0 14px}
.tw{border:0;background:none;overflow:visible}
table,tbody,tr,td{display:block;width:100%}table{overflow-wrap:anywhere}thead{display:none}
tr{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin:0 0 10px;padding:4px 0}
td{border:0;padding:6px 12px}td:first-child,table.specs td:nth-child(n){min-width:0}
td::before{content:attr(data-label);display:block;font-size:11px;color:var(--mute);font-weight:600}
td:empty{display:none}
dl{grid-template-columns:1fr;gap:2px 0}dd{margin-bottom:8px}
}
`.trim();

interface Shell {
  readonly repository: string;
  readonly ref: RefMeta;
  readonly defaultSlug: string;
  readonly status: string;
  readonly toc: readonly (readonly [string, string])[];
  readonly body: string;
}

function shell({ repository, ref, defaultSlug, status, toc, body }: Shell): string {
  const commit = `https://github.com/${repository}/commit/${ref.sha}`;
  const banner = ref.slug === defaultSlug ? "" :
    `\n<p class="banner">你正在看 <code>${escapeHtml(ref.name)}</code>（${KIND_LABEL[ref.kind]}）在該 commit 的內容，不是最新狀態。<a href="../${defaultSlug}/">看最新版本</a></p>`;
  return `<!doctype html>
<html lang="zh-Hant" data-ref="${escapeHtml(ref.name)}" data-kind="${ref.kind}" data-sha="${escapeHtml(ref.sha)}" data-status="${status}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>功能地圖 · ${escapeHtml(ref.name)} · ${escapeHtml(repository)}</title>
<style>
${style}
</style>
</head>
<body>
<header class="top"><div class="wrap">
<div class="top-row">
<h1>${escapeHtml(repository.split("/").pop() ?? repository)}<span>功能地圖 · Feature map</span></h1>
<label class="switch">版本<select id="ref-select" data-current="${escapeHtml(ref.slug)}" aria-label="切換版本"><option value="${escapeHtml(ref.slug)}" selected>${escapeHtml(ref.name)}</option></select></label>
</div>
<p class="stamp">建置自 <code>${escapeHtml(ref.name)}</code>（${KIND_LABEL[ref.kind]}）· commit <a href="${escapeHtml(commit)}"><code>${escapeHtml(ref.sha.slice(0, 7))}</code></a> · commit 時間 ${escapeHtml(formatTime(ref.date))}<span id="ref-note" hidden></span></p>${banner}
<nav class="toc" aria-label="章節">${toc.map(([id, label]) => `<a href="#${id}">${label}</a>`).join("")}</nav>
</div></header>
<main><div class="wrap">
${body}
</div></main>
<footer><div class="wrap">此頁由 <code>${FEATURE_MAP}</code>、<code>${GARDENING}</code>、<code>${SPECS}/*/spec.md</code> 自動產生，請勿手動編輯；要改內容請改來源檔。結構化資料：<a href="data.json">data.json</a>。</div></footer>
<script>
${switcherScript}
</script>
</body>
</html>
`;
}

export function renderPage(data: SiteData, options: { readonly defaultSlug: string }): string {
  const { repository, ref, counts } = data;
  const blob = `https://github.com/${repository}/blob/${ref.sha}/`;
  const mapLinks = linker(repository, ref.sha, FEATURE_MAP);
  const gardeningLinks = linker(repository, ref.sha, GARDENING);
  const toc: (readonly [string, string])[] = [["status", "現況 Status"], ["overview", "總覽"], ["specs", "規格 Specs"]];
  const parts: string[] = [];
  const sections = data.featureMap?.sections ?? [];

  if (data.featureMap === null) {
    parts.push(`<p class="notice">此版本沒有 feature map（<code>${FEATURE_MAP}</code> 不在這個 commit 的檔案樹中），以下只列出此版本有的資料。</p>`);
  }
  if (data.runsOnErrors.length > 0) {
    parts.push(`<p class="notice">feature map 的 Runs on 與證據不符，現況以推導結果為準。Runs on contradicts the evidence; the board shows the derived group instead:</p><ul class="notice-list">${data.runsOnErrors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>`);
  }
  parts.push(renderBoard(data, sections, mapLinks));
  const by = counts.specsByStatus;
  parts.push(`<section id="overview">
<h2>總覽</h2>
<div class="tiles">
<div class="tile"><b>${counts.specs}</b><span>規格（Specs）</span><em>已實作 ${by.implemented} · 部分實作 ${by.partial} · 已接受 ${by.accepted} · 草稿 ${by.draft} · 其他 ${by.other}</em></div>
<div class="tile"><b>${counts.gardeningItems}</b><span>待處理事項（Gardening）</span></div>
<div class="tile"><b>${counts.deployedNames}</b><span>部署設定項目</span></div>
<div class="tile"><b>${counts.schedules}</b><span>排程</span></div>
<div class="tile"><b>${counts.featureMapSections}</b><span>Feature map 章節</span></div>
</div>
</section>`);

  // Specs: each spec's own first lines, joined with its row of the feature map.
  const specRows = data.specs.map((spec) => {
    const links = linker(repository, ref.sha, spec.path);
    return `<tr><td data-label="編號"><a href="${escapeHtml(blob + spec.path)}">${spec.number}</a></td>` +
      `<td data-label="標題">${renderInline(spec.title, links)}</td>` +
      `<td data-label="狀態"><span class="badge ${spec.statusKind}">${STATUS_LABEL[spec.statusKind]}</span> ${cell(spec.status, links)}</td>` +
      `<td data-label="Acceptance IDs">${spec.acceptanceIds === null ? "" : cell(spec.acceptanceIds, mapLinks)}</td>` +
      `<td data-label="涵蓋範圍">${spec.surface === null ? "" : cell(spec.surface, mapLinks)}</td></tr>`;
  }).join("\n");
  parts.push(`<section id="specs">
<h2>規格<small>${counts.specs} 份 · 狀態取自各 spec 的 <code>Status:</code> 行</small></h2>
${data.specs.length === 0 ? `<p class="notice">此版本沒有 <code>${SPECS}/*/spec.md</code>。</p>` :
    `<div class="tw"><table class="specs">\n<thead><tr><th>編號</th><th>標題</th><th>狀態</th><th>Acceptance IDs</th><th>涵蓋範圍</th></tr></thead>\n<tbody>\n${specRows}\n</tbody>\n</table></div>`}
</section>`);

  if (data.featureMap !== null) {
    for (const [id, label, title] of [["deployed", "部署設定", DEPLOYED], ["schedules", "排程", SCHEDULES]] as const) {
      const section = sectionNamed(sections, title);
      const table = id === "deployed" ? data.deployedConfiguration : data.schedules;
      toc.push([id, label]);
      parts.push(`<section id="${id}">
<h2>${label}<small>${title}</small></h2>
${table === null || section === undefined ? `<p class="notice">此版本的 feature map 沒有「${title}」表格。</p>` : renderBlocks(section.blocks, mapLinks)}
</section>`);
    }
  }

  toc.push(["gardening", "待處理事項"]);
  if (data.gardening === null) {
    parts.push(`<section id="gardening">\n<h2>待處理事項</h2>\n<p class="notice">此版本沒有 <code>${GARDENING}</code>。</p>\n</section>`);
  } else {
    const categories = [...new Set(data.gardening.items.map((item) => item.category))];
    const groups = categories.map((category, index) => {
      const items = data.gardening!.items.filter((item) => item.category === category);
      return `<h3 id="g-cat-${index + 1}">${renderInline(category, gardeningLinks)}<small>${items.length}</small></h3>\n` + items.map((item) =>
        `<details class="g" id="${item.id}"><summary><span class="gid">${item.id}</span>${renderInline(item.title, gardeningLinks)}${item.layer === null ? "" : ` <span class="badge">${escapeHtml(item.layer)}</span>`}</summary><dl>` +
        item.fields.map((field) => `<dt>${FIELD_LABEL[field.label] ?? escapeHtml(field.label)}</dt><dd>${renderInline(field.text, gardeningLinks)}</dd>`).join("") +
        `<dt>原文</dt><dd><a href="${escapeHtml(`${blob}${GARDENING}#${item.anchor}`)}">${GARDENING}</a></dd></dl></details>`).join("\n");
    }).join("\n");
    parts.push(`<section id="gardening">
<h2>待處理事項<small>${counts.gardeningItems} 項 · Gardening</small></h2>
<p class="lede">已知的 workaround、過期文字、延後的 follow-up 與測試缺口。${data.gardening.lastFullPass === null ? "" : `上次完整整理：${renderInline(data.gardening.lastFullPass, gardeningLinks)}`}</p>
${groups}
</section>`);
  }

  if (data.featureMap !== null) {
    // Everything else of the feature map, in its own order. The three sections shown above are not repeated.
    const shown = new Set([DEPLOYED, SCHEDULES, ...(data.specs.some((spec) => spec.acceptanceIds !== null) ? [ACCEPTANCE] : [])].map((title) => title.toLowerCase()));
    let parent = "";
    const rest: string[] = [];
    for (const section of sections) {
      if (section.level <= 1) {
        if (section.blocks.length > 0) rest.push(renderBlocks(section.blocks, mapLinks));
        continue;
      }
      if (section.level === 2) parent = section.title;
      if (shown.has(section.title.toLowerCase()) || section.blocks.length === 0) continue;
      const crumb = section.level > 2 && parent !== "" ? `<span class="crumb">${renderInline(parent, mapLinks)} › </span>` : "";
      rest.push(`<details class="sec"><summary>${crumb}${renderInline(section.title, mapLinks)}</summary><div>\n${renderBlocks(section.blocks, mapLinks)}\n</div></details>`);
    }
    toc.push(["map", "Feature map 全文"]);
    parts.push(`<section id="map">
<h2>Feature map 全文<small><a href="${escapeHtml(blob + FEATURE_MAP)}">${FEATURE_MAP}</a></small></h2>
${rest.join("\n")}
</section>`);
  }

  return shell({ repository, ref, defaultSlug: options.defaultSlug, status: data.status, toc, body: parts.join("\n") });
}

/** The page of a ref whose generation threw (Spec 020 Behavior 12): the reason, and the way back. */
export function renderErrorPage(input: { readonly repository: string; readonly ref: RefMeta; readonly defaultSlug: string; readonly reason: string }): string {
  return shell({
    repository: input.repository, ref: input.ref, defaultSlug: input.defaultSlug, status: "error", toc: [],
    body: `<section><p class="notice">此版本無法產生功能地圖。原因：<code>${escapeHtml(input.reason)}</code></p></section>`,
  });
}
