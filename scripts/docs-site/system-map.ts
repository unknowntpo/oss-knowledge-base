/**
 * Spec 033: the system map. Pure functions over `docs/site/flows/system.json`, the Deployed
 * configuration table of `docs/feature-map.md` and the release read from git by build.ts:
 *
 * - which environments a node is live in (Behavior 1–2: its `gate` rows), the badge the system flow
 *   shows for it (Behavior 3);
 * - the build-time data of the `{{map:system}}` block (Behavior 6, 10–14): nodes, stages, runs-on,
 *   health bindings, links out, and the changes since the newest `v*` tag.
 *
 * The browser part (fetching `/health`, drawing) is `system-map-client.ts`.
 */
import { escapeHtml, parseMarkdown, plainText } from "../feature-map-site/markdown";
import { sectionNamed, tableOf } from "../feature-map-site/generate";
import type { Flow, FlowNode, Locale, Text } from "./generate";
import { COMPONENT_IDS } from "../../apps/data-publisher-worker/src/signals/profile";

export type Env = "dev" | "prod";
export const ENVS: readonly Env[] = ["dev", "prod"];
export type RunsOn = "cloudflare" | "github-actions" | "manual";
export const RUNS_ON: readonly RunsOn[] = ["github-actions", "manual"];

/** The only URLs the page's script may fetch (Behavior 15). */
export const HEALTH_URLS: Readonly<Record<Env, string>> = {
  dev: "https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/health",
  prod: "https://oss-knowledge-base-data-prod.unknowntpo.workers.dev/health",
};

/** The `/health` `components` ids the Worker can emit (Behavior 7), from the Worker's own list. */
export const HEALTH_COMPONENT_IDS: readonly string[] = COMPONENT_IDS;

const CLOUDFLARE = "https://dash.cloudflare.com/?to=/:account";

// ---------------------------------------------------------------------------------------------
// Deployed configuration → stages

export interface DeployedRow {
  /** The first column as written (Markdown). */
  readonly label: string;
  readonly names: readonly string[];
  readonly dev: string;
  readonly prod: string;
}

/** The rows each backticked first-column name appears in; a name in more than one row is ambiguous as a gate. */
export type DeployedRows = ReadonlyMap<string, readonly DeployedRow[]>;

/** Rows of the Deployed configuration table, keyed by every backticked name of their first column. */
export function deployedRows(featureMap: string): DeployedRows {
  const result = new Map<string, DeployedRow[]>();
  const table = tableOf(sectionNamed(parseMarkdown(featureMap), "Deployed configuration"));
  if (table === null) return result;
  const column = (name: string) => table.headers.findIndex((header) => plainText(header).trim().toLowerCase() === name);
  const [dev, prod] = [column("dev"), column("prod")];
  if (dev < 0 || prod < 0) return result;
  for (const cells of table.rows) {
    const label = cells[0] ?? "";
    const names = [...label.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!);
    const row = { label, names, dev: cells[dev] ?? "", prod: cells[prod] ?? "" };
    for (const name of names) result.set(name, [...(result.get(name) ?? []), row]);
  }
  return result;
}

/** Behavior 2: a cell is off when its text, without backticks, starts with `unset`, `none`, `off` or `no `. */
export function cellIsOff(cell: string): boolean {
  const text = cell.replaceAll("`", "").trim().toLowerCase();
  return ["unset", "none", "off", "no "].some((prefix) => text.startsWith(prefix));
}

const MODES = ["dry-run", "dry", "monitor"];
/** The mode chip of an on cell (`dry-run`, `monitor`): its leading backticked value when that is a mode. */
export function cellMode(cell: string): string | null {
  const lead = /^\s*`([^`]+)`/u.exec(cell)?.[1] ?? null;
  return lead !== null && MODES.includes(lead) ? lead : null;
}

export interface Stage {
  readonly live: boolean;
  readonly mode: string | null;
}
export type Stages = Readonly<Record<Env, Stage>>;

/** Behavior 2: live in an environment when every gate row's cell is on; ungated nodes are live in both. Unknown rows are reported. */
export function nodeStages(node: Pick<FlowNode, "id" | "gate">, rows: DeployedRows, problem: (message: string) => void = () => undefined): Stages {
  const gate = node.gate ?? [];
  const found: DeployedRow[] = [];
  for (const name of gate) {
    const matches = rows.get(name) ?? [];
    if (matches.length === 0) problem(`node ${node.id}: gate ${JSON.stringify(name)} names no row of the Deployed configuration in docs/feature-map.md`);
    else if (matches.length > 1) problem(`node ${node.id}: gate ${JSON.stringify(name)} is named by more than one row of the Deployed configuration: ${matches.map((row) => plainText(row.label).trim()).join(" | ")}`);
    found.push(...matches.slice(0, 1));
  }
  const stage = (env: Env): Stage => {
    const cells = found.map((row) => row[env]);
    const live = cells.every((cell) => !cellIsOff(cell));
    return { live, mode: live ? cells.map(cellMode).find((mode) => mode !== null) ?? null : null };
  };
  return { dev: stage("dev"), prod: stage("prod") };
}

const BADGES: Readonly<Record<"dev" | "off", Text>> = {
  dev: { en: "Dev only", "zh-Hant": "僅 Dev" },
  off: { en: "Off", "zh-Hant": "未啟用" },
};

/** Behavior 3: the badge of a node in the system flow: from its gates, or its hand tag when it has no gate. */
export function badgeOf(node: FlowNode, rows: DeployedRows): FlowNode["tag"] {
  if (node.gate === undefined) return node.tag;
  const stages = nodeStages(node, rows);
  if (stages.dev.live && !stages.prod.live) return { kind: "dev", text: BADGES.dev };
  if (!stages.dev.live && !stages.prod.live) return { kind: "off", text: BADGES.off };
  return undefined;
}

/** Checks of the Spec 033 node fields, for flowProblems. */
export function mapFieldProblems(node: Record<string, unknown>, at: (message: string) => void): void {
  if (node.gate !== undefined) {
    if (!Array.isArray(node.gate) || node.gate.length === 0 || node.gate.some((name) => typeof name !== "string" || name.trim() === "")) at("gate must be a non-empty array of Deployed configuration row names");
    const tag = node.tag as { kind?: unknown } | undefined;
    if (tag !== undefined) at(`a gated node has no hand tag (found kind ${String(tag.kind)}); its badge comes from the gate (Spec 033 Behavior 1, 3)`);
  }
  if (node.runsOn !== undefined && !(RUNS_ON as readonly unknown[]).includes(node.runsOn)) at(`runsOn must be one of ${RUNS_ON.join(", ")}`);
  if (node.health !== undefined) {
    const ids = typeof node.health === "string" ? [node.health] : node.health;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !HEALTH_COMPONENT_IDS.includes(id as string)) || new Set(ids).size !== ids.length) {
      at(`health must be one of ${HEALTH_COMPONENT_IDS.join(", ")}, or a non-empty list of distinct ones`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Build-time data of the map

export interface Deployment {
  readonly worker: string;
  readonly bucket: string;
  readonly gateways: readonly string[];
  readonly vectorIndexes: readonly string[];
}
export type Deployments = Readonly<Record<Env, Deployment>>;

export interface Release {
  readonly tag: string;
  readonly date: string;
  /** Commits in `<tag>..HEAD`. */
  readonly distance: number;
  /** Subjects in `<tag>..HEAD` ending in `(#N)`, newest first. */
  readonly pulls: readonly { readonly number: number; readonly subject: string }[];
  /** `docs/site/flows/system.json` and `docs/feature-map.md` at the tag (null when absent there). */
  readonly flow: unknown;
  readonly featureMap: string | null;
}

export interface MapLink { readonly label: string; readonly url: string; readonly site: string }
export interface MapNode {
  readonly id: string;
  readonly card: string;
  readonly icon: string;
  readonly kind: string;
  readonly title: string;
  readonly meta: string;
  readonly lead: string;
  readonly stage: Stages;
  readonly runsOn: RunsOn;
  /** Behavior 5: the bound `/health` `components` ids; empty when unbound. */
  readonly health: readonly string[];
  readonly added: boolean;
  readonly links: Readonly<Record<Env, readonly MapLink[]>>;
}
export interface MapChange { readonly op: "add" | "remove" | "flag" | "risk" | "pr"; readonly html: string }
export interface MapData {
  readonly columns: readonly { readonly title: string; readonly cards: readonly { readonly id: string; readonly title: string }[] }[];
  readonly nodes: readonly MapNode[];
  readonly links: readonly (readonly [string, string])[];
  readonly initial: string | null;
  readonly commit: { readonly sha: string; readonly date: string };
  readonly release: { readonly tag: string; readonly date: string; readonly distance: number } | null;
  readonly changes: readonly MapChange[];
  readonly text: Readonly<Record<string, string>>;
}

export interface MapContext {
  readonly locale: Locale;
  readonly repository: string;
  readonly commit: { readonly sha: string; readonly date: string };
  readonly rows: DeployedRows;
  readonly deployments: Deployments;
  readonly release: Release | null;
  /** Inline Markdown → HTML with the page's link rules. */
  readonly inline: (markdown: string) => string;
}

const nodesOf = (flow: Pick<Flow, "columns">) => flow.columns.flatMap((column) => column.cards.flatMap((card) => card.nodes.map((node) => ({ node, card }))));

/** Whether `node` names `name` as a word in any of its English texts. */
function mentions(node: FlowNode, name: string): boolean {
  const texts = [node.title.en, node.meta?.en ?? "", node.lead.en, ...(node.facts ?? []).flatMap((fact) => [fact.k.en, fact.v.en])];
  const word = new RegExp(`(^|[^a-z0-9-])${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}([^a-z0-9-]|$)`, "u");
  return texts.some((text) => word.test(text));
}

/** Behavior 5: a node's bindings as a list (`"health": "id"` or `"health": ["id", …]`). */
export const healthIds = (node: Pick<FlowNode, "health">): readonly string[] =>
  node.health === undefined ? [] : typeof node.health === "string" ? [node.health] : node.health;

/** Behavior 13: links out per environment, all in the `?to=/:account/…` form (no account id). */
export function nodeLinks(node: FlowNode, env: Env, deployment: Deployment, repository: string, locale: Locale): MapLink[] {
  const zh = locale === "zh-Hant";
  const runsOn: RunsOn = node.runsOn ?? "cloudflare";
  const links: MapLink[] = [];
  if (runsOn === "cloudflare" && node.kind !== "src") {
    links.push({ label: `${zh ? "Worker 日誌" : "Worker logs"} · ${deployment.worker}`, url: `${CLOUDFLARE}/workers/services/view/${deployment.worker}/production/observability/logs`, site: "Cloudflare" });
  }
  if (node.kind === "ai") {
    for (const gateway of deployment.gateways) {
      if (mentions(node, gateway)) links.push({ label: `${zh ? "AI Gateway 日誌" : "AI Gateway logs"} · ${gateway}`, url: `${CLOUDFLARE}/ai/ai-gateway/gateways/${gateway}/logs`, site: "Cloudflare" });
    }
  }
  if (node.kind === "r2" && !deployment.vectorIndexes.some((index) => mentions(node, index))) {
    links.push({ label: `${zh ? "R2 bucket" : "R2 bucket"} · ${deployment.bucket}`, url: `${CLOUDFLARE}/r2/default/buckets/${deployment.bucket}`, site: "Cloudflare" });
  }
  if (runsOn === "github-actions") links.push({ label: zh ? "GitHub Actions 執行紀錄" : "GitHub Actions runs", url: `https://github.com/${repository}/actions`, site: "GitHub" });
  return links;
}

/** The `{{map:system}}` data for one locale. */
export function systemMapData(flow: Flow, context: MapContext): MapData {
  const { locale } = context;
  const t = (text: Text | undefined) => (text === undefined ? "" : text[locale]);
  const before = context.release === null ? null : nodeIdsOf(context.release.flow);
  const nodes: MapNode[] = nodesOf(flow).map(({ node, card }) => ({
    id: node.id,
    card: card.id,
    icon: node.icon,
    kind: node.kind,
    title: t(node.title),
    meta: t(node.meta),
    lead: context.inline(t(node.lead)),
    stage: nodeStages(node, context.rows),
    runsOn: node.runsOn ?? "cloudflare",
    health: healthIds(node),
    added: before !== null && !before.has(node.id),
    links: { dev: nodeLinks(node, "dev", context.deployments.dev, context.repository, locale), prod: nodeLinks(node, "prod", context.deployments.prod, context.repository, locale) },
  }));
  return {
    columns: flow.columns.map((column) => ({ title: t(column.title), cards: column.cards.map((card) => ({ id: card.id, title: t(card.title) })) })),
    nodes,
    links: flow.links,
    initial: nodes.some((node) => node.id === flow.initial) ? flow.initial : null,
    commit: context.commit,
    release: context.release === null ? null : { tag: context.release.tag, date: context.release.date, distance: context.release.distance },
    changes: systemMapChanges(flow, context),
    text: MAP_TEXT[locale],
  };
}

/** Node ids (with their card and title) of a flow read from git; null when it is not a readable flow. */
function nodeIdsOf(raw: unknown): Map<string, { title: string }> | null {
  const flow = raw as { columns?: { cards?: { nodes?: { id?: unknown; title?: { en?: unknown } }[] }[] }[] } | null;
  if (flow === null || typeof flow !== "object" || !Array.isArray(flow.columns)) return null;
  const ids = new Map<string, { title: string }>();
  for (const column of flow.columns) for (const card of column.cards ?? []) for (const node of card.nodes ?? []) {
    if (typeof node.id === "string") ids.set(node.id, { title: typeof node.title?.en === "string" ? node.title.en : node.id });
  }
  return ids;
}

/** A Deployed configuration cell as a short value: the text up to its first explanation. */
export function shortCell(cell: string): string {
  const text = plainText(cell).trim().split(/\s\(|;\s|\.\s/u)[0]!.trim();
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

/** Behavior 14: what changed between the newest `v*` tag and this commit. */
export function systemMapChanges(flow: Flow, context: MapContext): MapChange[] {
  const release = context.release;
  if (release === null) return [];
  const zh = context.locale === "zh-Hant";
  const t = (text: Text) => text[context.locale];
  const code = (text: string) => `<code>${escapeHtml(text)}</code>`;
  const changes: MapChange[] = [];
  const before = nodeIdsOf(release.flow);
  if (before !== null) {
    for (const column of flow.columns) for (const card of column.cards) {
      const added = card.nodes.filter((node) => !before.has(node.id));
      if (added.length === 0) continue;
      const whole = added.length === card.nodes.length;
      const names = added.map((node) => `<b>${escapeHtml(t(node.title))}</b>`).join(zh ? "、" : ", ");
      changes.push({ op: "add", html: whole ? `${zh ? "新群組" : "New group"} <b>${escapeHtml(t(card.title))}</b>: ${names}` : `${escapeHtml(t(card.title))}: ${names}` });
    }
    const now = new Set(nodesOf(flow).map(({ node }) => node.id));
    const removed = [...before].filter(([id]) => !now.has(id));
    if (removed.length > 0) changes.push({ op: "remove", html: `${zh ? "移除" : "Removed"}: ${removed.map(([id, node]) => `<b>${escapeHtml(node.title)}</b> (${code(id)})`).join(", ")}` });
    for (const { node } of nodesOf(flow)) {
      if (node.runsOn === "manual" && !before.has(node.id)) {
        changes.push({ op: "risk", html: `${zh ? "新的手動步驟" : "New manual step"}: <b>${escapeHtml(t(node.title))}</b> · ${zh ? "沒有排程，靠人執行" : "nothing schedules it; a person runs it"}` });
      }
    }
  }
  if (release.featureMap !== null) {
    const old = deployedRows(release.featureMap);
    const label = (row: DeployedRow) => row.names[0] ?? plainText(row.label).trim();
    const envName: Record<Env, string> = { dev: "Dev", prod: "Prod" };
    for (const row of new Set([...context.rows.values()].flat())) {
      const candidates = row.names.flatMap((name) => old.get(name) ?? []);
      const was = candidates.find((candidate) => candidate.label === row.label) ?? candidates[0];
      if (was === undefined) {
        changes.push({ op: "flag", html: `${code(label(row))} ${zh ? "新增" : "added"}: Dev ${code(shortCell(row.dev))} · Prod ${code(shortCell(row.prod))}` });
        continue;
      }
      const moved = ENVS.filter((env) => shortCell(was[env]) !== shortCell(row[env]));
      if (moved.length === 0) continue;
      changes.push({ op: "flag", html: `${code(label(row))} ${moved.map((env) => `${envName[env]} ${code(shortCell(was[env]))} → ${code(shortCell(row[env]))}`).join(" · ")}` });
    }
  }
  for (const pull of release.pulls) {
    changes.push({ op: "pr", html: `<a href="https://github.com/${escapeHtml(context.repository)}/pull/${pull.number}">#${pull.number}</a> ${escapeHtml(pull.subject)}` });
  }
  return changes;
}

const MAP_TEXT: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  en: {
    env: "Environment", view: "View", flow: "Data flow", list: "List", prodTag: "Prod tag", build: "Build", sinceTag: "since the tag", noTag: "no tag",
    healthRead: "/health read", healthLoading: "reading /health…", healthError: "/health could not be read", healthNone: "the Worker does not report components; status n/a",
    tried: "tried", overall: "Overall", failed: "failed", stale: "stale", warn: "warn", ok: "ok", unknown: "unknown", na: "n/a", loading: "…", manual: "manual",
    liveCount: "live components", hidden: "not live, not shown",
    groupFailed: "Failed", groupStale: "Stale", groupWarn: "Warn", groupManual: "Manual", groupOk: "OK", groupNone: "No status",
    colComponent: "Component", colGroup: "Group", colStatus: "Status", colRunsOn: "Runs on", colMeta: "Meta",
    on: "on", off: "off", devOnly: "Dev only", both: "Dev + Prod", new: "new",
    cloudflare: "Cloudflare", "github-actions": "GitHub Actions", manualRun: "Manual (a person)",
    noSelection: "Select a component to see its details.", stage: "Stage", status: "Status", reason: "Reason", at: "At", runsOn: "Runs on",
    upstream: "Upstream", downstream: "Downstream", rawHealth: "Raw /health JSON", linksNote: "Metrics and logs stay in Cloudflare and GitHub; the map only links to them.",
    risk: "A person runs this step (a token-authenticated request or a command on a laptop); nothing schedules it, so it does not happen when nobody does it.",
    unbound: "Not on the map", unboundHint: "/health reports these components, but no node of system.json binds them.",
    changes: "Changes", changesNone: "No release tag (v*) is reachable from this build commit, so there is nothing to compare.", changesEmpty: "Nothing changed since the tag.",
    changesHint: "Everyone sees the same list: git log and the Deployed configuration, tag against this build.",
  },
  "zh-Hant": {
    env: "環境", view: "檢視", flow: "資料流", list: "清單", prodTag: "Prod tag", build: "建置", sinceTag: "（tag 之後）", noTag: "沒有 tag",
    healthRead: "/health 讀取於", healthLoading: "正在讀取 /health…", healthError: "無法讀取 /health", healthNone: "Worker 沒有回報 components；狀態為 n/a",
    tried: "嘗試於", overall: "整體", failed: "失敗", stale: "過期", warn: "警告", ok: "正常", unknown: "未知", na: "n/a", loading: "…", manual: "手動",
    liveCount: "個已上線元件", hidden: "個未上線，不顯示",
    groupFailed: "失敗", groupStale: "過期", groupWarn: "警告", groupManual: "手動", groupOk: "正常", groupNone: "無狀態",
    colComponent: "元件", colGroup: "群組", colStatus: "狀態", colRunsOn: "跑在哪", colMeta: "說明",
    on: "開", off: "關", devOnly: "僅 Dev", both: "Dev + Prod", new: "新",
    cloudflare: "Cloudflare", "github-actions": "GitHub Actions", manualRun: "手動（靠人）",
    noSelection: "點選元件查看細節。", stage: "階段", status: "狀態", reason: "原因", at: "時間", runsOn: "跑在哪",
    upstream: "上游", downstream: "下游", rawHealth: "/health 原始 JSON", linksNote: "指標與日誌留在 Cloudflare 與 GitHub，地圖只放連結。",
    risk: "這一步靠人執行（帶 token 的請求或筆電上的指令）；沒有排程，沒人做就不會發生。",
    unbound: "不在地圖上", unboundHint: "/health 回報了這些元件，但 system.json 沒有節點綁定它們。",
    changes: "變更", changesNone: "這個建置 commit 找不到可達的 release tag（v*），沒有可比較的版本。", changesEmpty: "tag 之後沒有變更。",
    changesHint: "每個人看到同一份：git log 與 Deployed configuration，tag 對照這次建置。",
  },
};

/** The `{{map:system}}` block: a static shell, the build data, and the client mounted by the page script. */
export function renderSystemMap(flow: Flow, context: MapContext): string {
  const data = systemMapData(flow, context);
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  const text = MAP_TEXT[context.locale];
  return `<section class="smap" id="smap-${flow.id}" aria-label="${escapeHtml(text.flow)}">
<div class="smap-hdr"></div>
<div class="smap-main"><div class="smap-box"><div class="smap-box-h"><h3 class="smap-title"></h3></div><div class="smap-flow"><div class="smap-cols"><svg class="smap-wires" aria-hidden="true"></svg></div></div><div class="smap-list" hidden></div></div>
<aside class="smap-side"><div class="smap-detail" aria-live="polite"></div><div class="smap-unbound" hidden></div></aside></div>
<div class="smap-changes"><h3>${escapeHtml(text.changes)} · ${escapeHtml(data.release === null ? text.noTag : `${data.release.tag} → ${context.commit.sha.slice(0, 7)}`)}</h3><p class="hint">${escapeHtml(text.changesHint)}</p>${
    data.release === null ? `<p class="smap-nochanges">${escapeHtml(text.changesNone)}</p>` : data.changes.length === 0 ? `<p class="smap-nochanges">${escapeHtml(text.changesEmpty)}</p>`
      : `<ul class="smap-chg">${data.changes.map((change) => `<li data-op="${change.op}"><span class="op op-${change.op}" aria-hidden="true">${{ add: "+", remove: "−", flag: "⚑", risk: "!", pr: "#" }[change.op]}</span><span>${change.html}</span></li>`).join("")}</ul>`
  }</div>
<script type="application/json" class="smap-data">${json}</script>
</section>`;
}

export const MAP_CSS = `
:root{--wa-kariyasu:#9c861a;--wa-kariyasu-t:rgba(179,154,31,.16)}
:root[data-theme="dark"]{--wa-kariyasu:#e3cb5a;--wa-kariyasu-t:rgba(227,203,90,.15)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--wa-kariyasu:#e3cb5a;--wa-kariyasu-t:rgba(227,203,90,.15)}}
.layout.wide{grid-template-columns:minmax(0,1fr)}.layout.wide .toc{display:none}
.smap{margin:8px 0 28px;display:grid;gap:14px;font-size:var(--fs-sm)}
.smap h3{margin:0;font-size:var(--fs-md)}
.smap [hidden]{display:none!important}
.smap-hdr{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center}
.seg{display:inline-flex;border:1px solid var(--border-default);border-radius:var(--radius-md);overflow:hidden;background:var(--surface-card)}
.seg button{border:0;background:none;color:var(--text-secondary);padding:4px 12px;font:inherit;cursor:pointer}
.seg button[aria-pressed="true"]{background:var(--wa-ai-t);color:var(--wa-ai);font-weight:600}
.smap-kv{display:flex;flex-direction:column;line-height:1.3}
.smap-kv small{color:var(--text-muted);font-size:var(--fs-2xs)}
.smap-kv span{font:400 var(--fs-xs) var(--font-mono)}
.smap-overall{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;border:1px solid var(--border-default);background:var(--surface-card)}
.smap-overall[data-status="failed"]{background:var(--wa-beni-t);border-color:var(--wa-beni)}
.smap-overall[data-status="warn"],.smap-overall[data-status="stale"]{background:var(--wa-kariyasu-t);border-color:var(--wa-kariyasu)}
.smap-overall[data-status="ok"]{background:var(--wa-seiji-t);border-color:var(--wa-seiji)}
.smap-healthnote{flex-basis:100%;margin:0;color:var(--text-muted);font-size:var(--fs-xs)}
.smap-healthnote[data-kind="error"]{color:var(--wa-beni)}
.smap-main{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:14px;align-items:start}
.smap-box{background:var(--surface-card);border:1px solid var(--border-default);border-radius:var(--radius-xl);min-width:0}
.smap-box-h{padding:10px 14px;border-bottom:1px solid var(--border-default)}
.smap-flow{overflow-x:auto}
.smap-cols{position:relative;display:grid;grid-template-columns:repeat(var(--smap-cols,5),minmax(150px,1fr));column-gap:34px;padding:14px;min-width:calc(var(--smap-cols,5)*150px + (var(--smap-cols,5) - 1)*34px + 28px)}
.smap-wires{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;color:var(--icon-muted)}
.smap-wires path{fill:none;stroke:currentColor;stroke-width:1.2;opacity:.75}
.smap-wires path.hi{color:var(--wa-ai);stroke-width:2;opacity:1}
.smap-wires path.dim{opacity:.2}
.smap-wires path.long{display:none}.smap-wires path.long.hi{display:inline}
.smap-col{position:relative;z-index:1;display:grid;gap:18px;align-content:start}
.smap-col-t{margin:0;font-size:var(--fs-2xs);letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted)}
.smap-card{background:var(--surface-card);border:1px solid var(--border-strong);border-radius:var(--radius-lg);overflow:hidden;transition:opacity .15s}
.smap-card.dim{opacity:.45}.smap-card.focus{border-color:var(--wa-ai);box-shadow:0 0 0 1px var(--wa-ai)}
.smap-card-h{display:flex;align-items:center;gap:6px;width:100%;padding:7px 9px;border:0;border-bottom:1px solid var(--border-default);background:none;font:600 var(--fs-xs) var(--font-sans);color:var(--text-strong);text-align:left;cursor:pointer}
.smap-card-h .cnt{font-weight:500;color:var(--text-muted)}.smap-card-h .sdot{margin-left:auto}
.smap-node{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:2px 6px;align-items:center;width:100%;padding:6px 9px;border:0;border-top:1px solid var(--border-subtle);background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}
.smap-card-h+.smap-node{border-top:0}
.smap-node:hover{background:var(--surface-chip)}
.smap-node[aria-pressed="true"]{background:var(--wa-ai-t);box-shadow:inset 3px 0 0 var(--wa-ai)}
.smap-node .ic{width:22px;height:20px;font-size:9.5px}
.smap-node .nm{font-size:var(--fs-xs);font-weight:500;line-height:1.3;color:var(--text-primary);min-width:0;overflow-wrap:anywhere}
.smap-node .sub{grid-column:2/4;display:flex;flex-wrap:wrap;gap:3px;align-items:center;font-size:10.5px;color:var(--text-muted);min-width:0}
.smap-node .sub>span:last-child{overflow-wrap:anywhere}
.sdot{flex:none;width:9px;height:9px;border-radius:50%;display:inline-block;border:1.5px solid var(--text-muted);background:transparent}
.sdot.st-ok{background:var(--wa-seiji);border-color:var(--wa-seiji)}
.sdot.st-warn{background:var(--wa-kariyasu);border-color:var(--wa-kariyasu)}
.sdot.st-stale{background:var(--wa-fuji);border-color:var(--wa-fuji)}
.sdot.st-failed{background:var(--wa-beni);border-color:var(--wa-beni)}
.sdot.st-unknown{border-style:dashed}
.chip{font-size:10px;line-height:15px;padding:0 5px;border-radius:4px;white-space:nowrap;border:1px solid transparent}
.chip-mode{background:var(--wa-koke-t);color:var(--wa-koke)}
.chip-gha{background:var(--wa-ai-t);color:var(--wa-ai)}
.chip-manual{background:var(--wa-beni-t);color:var(--wa-beni);border:1px dashed var(--wa-beni);font-weight:600}
.chip-new{background:var(--wa-wasure-t);color:var(--wa-wasure)}
.chip-off{background:var(--surface-sunken);color:var(--text-muted)}
.chip-on{background:var(--wa-seiji-t);color:var(--wa-seiji)}
.smap-list{padding:4px 12px 12px;overflow-x:auto}
.smap-list table{min-width:640px;font-size:var(--fs-xs)}
.smap-list tr.grp td{background:var(--surface-sunken);font-weight:600;color:var(--text-secondary)}
.smap-list tr.row{cursor:pointer}.smap-list tr.row:hover{background:var(--surface-chip)}
.smap-list tr.row[aria-selected="true"]{background:var(--wa-ai-t)}
.smap-list td{vertical-align:middle}
.smap-side{display:grid;gap:14px;min-width:0;position:sticky;top:76px;max-height:calc(100vh - 90px);overflow:auto}
.smap-detail,.smap-unbound,.smap-changes{background:var(--surface-card);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:12px 14px;display:grid;gap:8px;min-width:0}
.smap-detail{border-left:3px solid var(--wa-ai)}
.smap-detail h3{display:flex;align-items:center;gap:8px}.smap-detail h3 .sdot{margin-left:auto}
.smap-detail .lead{margin:0}
.smap-detail .kv{grid-template-columns:minmax(6em,max-content) 1fr}
.smap-rel{display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:var(--fs-xs);color:var(--text-muted)}
.smap-rel button{font:inherit;border:1px solid var(--border-default);background:var(--surface-sunken);color:var(--text-secondary);border-radius:999px;padding:0 8px;cursor:pointer}
.smap-links{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.smap-links a{display:flex;justify-content:space-between;gap:8px;padding:5px 9px;border-radius:var(--radius-md);background:var(--surface-sunken);text-decoration:none;font-size:var(--fs-xs);overflow-wrap:anywhere}
.smap-links a:hover{background:var(--wa-ai-t)}
.smap-links .ext{color:var(--text-muted);white-space:nowrap}
.smap-risk{margin:0;padding:8px 10px;border-radius:var(--radius-md);background:var(--wa-beni-t);color:var(--wa-beni);font-size:var(--fs-xs)}
.smap-chg{list-style:none;margin:0;padding:0}
.smap-chg{columns:2 360px;column-gap:28px}.smap-chg li{break-inside:avoid;display:grid;grid-template-columns:20px minmax(0,1fr);gap:8px;padding:6px 0;border-bottom:1px solid var(--border-subtle);font-size:var(--fs-xs);overflow-wrap:anywhere}
.smap-chg li:last-child{border-bottom:0}
.op{width:20px;height:20px;border-radius:5px;display:grid;place-items:center;font-weight:700}
.op-add{background:var(--wa-seiji-t);color:var(--wa-seiji)}.op-remove{background:var(--surface-sunken);color:var(--text-muted)}
.op-flag{background:var(--wa-fuji-t);color:var(--wa-fuji)}.op-risk{background:var(--wa-beni-t);color:var(--wa-beni)}.op-pr{background:var(--wa-ai-t);color:var(--wa-ai)}
.smap-nochanges{margin:0;color:var(--text-muted)}
@media (max-width:1180px){.smap-main{grid-template-columns:minmax(0,1fr)}.smap-side{position:static;max-height:none}}
@media (max-width:760px){.smap-cols{grid-template-columns:minmax(0,1fr);min-width:0;row-gap:14px}.smap-wires{display:none}.smap-detail .kv{grid-template-columns:1fr}}
`;
