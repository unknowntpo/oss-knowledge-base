/**
 * Spec 033: the system map in the browser. `mountSystemMap` is self-contained (no imports, no module
 * state): the page inlines its source (`mountSystemMap.toString()`) and calls it with the window, the
 * map's root element and the two `/health` URLs, which are the only URLs it fetches (Behavior 15).
 *
 * It reads the build data from `script.smap-data`, draws the selected environment's live nodes as the
 * data flow or the list (Behavior 10–12), and fetches that environment's `/health` once on load and
 * on each environment switch (Behavior 9), ignoring answers to an earlier switch (SM17).
 */
import type { MapData, MapNode } from "./system-map";

export function mountSystemMap(win: Window, root: HTMLElement, healthUrls: { readonly dev: string; readonly prod: string }): void {
  type Env = "dev" | "prod";
  type Status = "ok" | "warn" | "failed" | "stale" | "unknown" | "na" | "loading";
  interface Component { readonly status: Status; readonly at: string; readonly reason: string }
  type Health =
    | { readonly kind: "loading"; readonly tried: string }
    | { readonly kind: "error"; readonly tried: string; readonly reason: string }
    | { readonly kind: "none"; readonly at: string }
    | { readonly kind: "ok"; readonly at: string; readonly components: ReadonlyMap<string, Component> };

  const doc = win.document;
  const data = JSON.parse(root.querySelector("script.smap-data")!.textContent!) as MapData;
  const t = data.text as Readonly<Record<string, string>>;
  const byId = new Map(data.nodes.map((node) => [node.id, node] as const));
  const colOf = new Map<string, number>();
  const cardTitle = new Map<string, string>();
  data.columns.forEach((column, index) => column.cards.forEach((card) => {
    colOf.set(card.id, index);
    cardTitle.set(card.id, card.title);
  }));
  const state: { env: Env; view: "flow" | "list"; sel: string | null; seq: number; health: Health } = {
    env: "dev", view: "flow", sel: data.initial, seq: 0, health: { kind: "loading", tried: "" },
  };
  const STATUSES: readonly Status[] = ["ok", "warn", "failed", "stale", "unknown"];
  const RANK: Readonly<Record<Status, number>> = { failed: 0, stale: 1, warn: 2, unknown: 3, ok: 4, na: 5, loading: 6 };

  const esc = (text: unknown) => String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
  const $ = (selector: string) => root.querySelector(selector) as HTMLElement;
  const time = (iso: string) => (iso === "" ? "" : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`);
  const live = (node: MapNode) => node.stage[state.env].live;
  const liveNodes = () => data.nodes.filter(live);
  const cardLive = (card: string) => data.nodes.some((node) => node.card === card && live(node));

  function statusOf(node: MapNode): Status {
    const health = state.health;
    if (health.kind === "loading") return "loading";
    if (health.kind === "error") return "unknown";
    if (health.kind === "none" || node.health === null) return "na";
    return health.components.get(node.health)?.status ?? "unknown";
  }
  const componentOf = (node: MapNode): Component | undefined =>
    state.health.kind === "ok" && node.health !== null ? state.health.components.get(node.health) : undefined;
  const worst = (statuses: readonly Status[]) => statuses.reduce<Status>((a, b) => (RANK[b] < RANK[a] ? b : a), "loading");
  const dot = (status: Status) => `<span class="sdot st-${status}" title="${esc(t[status])}" aria-label="${esc(t[status])}"></span>`;
  const stageChip = (node: MapNode, env: Env) => {
    const stage = node.stage[env];
    return stage.live ? `<span class="chip ${stage.mode === null ? "chip-on" : "chip-mode"}">${esc(stage.mode ?? t.on)}</span>` : `<span class="chip chip-off">${esc(t.off)}</span>`;
  };
  const chips = (node: MapNode) => {
    const mode = node.stage[state.env].mode;
    return (mode === null ? "" : `<span class="chip chip-mode">${esc(mode)}</span>`)
      + (node.runsOn === "github-actions" ? `<span class="chip chip-gha">GitHub Actions</span>` : "")
      + (node.runsOn === "manual" ? `<span class="chip chip-manual" data-chip="manual">${esc(t.manual)} ⚠</span>` : "")
      + (node.added ? `<span class="chip chip-new">${esc(t.new)}</span>` : "");
  };
  const icon = (node: MapNode) => `<span class="ic ic-${esc(node.kind)}" aria-hidden="true">${esc(node.icon)}</span>`;

  function renderHeader() {
    const nodes = liveNodes();
    const count = (status: Status) => nodes.filter((node) => statusOf(node) === status).length;
    const manual = nodes.filter((node) => node.runsOn === "manual").length;
    const [failed, stale, warn] = [count("failed"), count("stale"), count("warn")];
    const overall: Status = failed > 0 ? "failed" : stale > 0 ? "stale" : warn > 0 ? "warn" : state.health.kind === "ok" ? "ok" : "na";
    const seg = (name: string, label: string, options: readonly (readonly [string, string])[], current: string) =>
      `<div class="seg" role="group" aria-label="${esc(label)}">${options.map(([value, text]) => `<button type="button" data-${name}="${value}" aria-pressed="${value === current}">${esc(text)}</button>`).join("")}</div>`;
    const health = state.health;
    const note = health.kind === "loading" ? t.healthLoading
      : health.kind === "error" ? `${t.healthError} (${health.reason}) · ${t.tried} ${time(health.tried)}`
        : health.kind === "none" ? `${t.healthRead} ${time(health.at)} · ${t.healthNone}`
          : `${t.healthRead} ${time(health.at)}`;
    $(".smap-hdr").innerHTML = seg("env", t.env, [["dev", "Dev"], ["prod", "Prod"]], state.env)
      + seg("view", t.view, [["flow", t.flow], ["list", t.list]], state.view)
      + `<div class="smap-kv"><small>${esc(t.prodTag)}</small><span>${data.release === null ? esc(t.noTag) : `${esc(data.release.tag)} · ${esc(data.release.date.slice(0, 10))}`}</span></div>`
      + `<div class="smap-kv"><small>${esc(t.build)}</small><span>${esc(data.commit.sha.slice(0, 7))}${data.release === null ? "" : ` · +${data.release.distance} ${esc(t.sinceTag)}`}</span></div>`
      + `<div class="smap-kv"><small>/health</small><span class="smap-readat">${esc(health.kind === "ok" || health.kind === "none" ? time(health.at) : health.kind === "error" ? "—" : "…")}</span></div>`
      + `<span class="smap-overall" data-status="${overall}">${dot(overall)}${esc(t.overall)}: <b data-count="failed">${failed}</b> ${esc(t.failed)} · <b data-count="stale">${stale}</b> ${esc(t.stale)} · <b data-count="warn">${warn}</b> ${esc(t.warn)} · <b data-count="manual">${manual}</b> ${esc(t.manual)}</span>`
      + `<p class="smap-healthnote" data-kind="${health.kind}">${esc(note)}</p>`;
    const hidden = data.nodes.length - nodes.length;
    $(".smap-title").textContent = `${state.view === "flow" ? t.flow : t.list} · ${state.env === "dev" ? "Dev" : "Prod"} · ${nodes.length} ${t.liveCount} (${hidden} ${t.hidden})`;
  }

  function renderFlow() {
    const cols = $(".smap-cols");
    cols.style.setProperty("--smap-cols", String(data.columns.length));
    const svg = cols.querySelector("svg")!;
    cols.innerHTML = "";
    cols.appendChild(svg);
    cols.insertAdjacentHTML("beforeend", data.columns.map((column) => {
      const cards = column.cards.map((card) => {
        const nodes = data.nodes.filter((node) => node.card === card.id && live(node));
        if (nodes.length === 0) return "";
        const summary = worst(nodes.map(statusOf));
        return `<div class="smap-card" data-card="${esc(card.id)}" data-status="${summary}"><button type="button" class="smap-card-h" data-card="${esc(card.id)}">${esc(card.title)} <span class="cnt">${nodes.length}</span>${dot(summary)}</button>${
          nodes.map((node) => `<button type="button" class="smap-node" data-id="${esc(node.id)}" data-status="${statusOf(node)}" aria-pressed="${state.sel === node.id}">${icon(node)}<span class="nm">${esc(node.title)}</span>${dot(statusOf(node))}<span class="sub">${chips(node)}<span>${esc(node.meta)}</span></span></button>`).join("")
        }</div>`;
      }).join("");
      return cards === "" ? "" : `<div class="smap-col"><p class="smap-col-t">${esc(column.title)}</p>${cards}</div>`;
    }).join(""));
    drawWires();
  }

  function drawWires() {
    if (state.view !== "flow") return;
    const cols = $(".smap-cols");
    const svg = cols.querySelector("svg")!;
    const focus = state.sel !== null && byId.has(state.sel) && live(byId.get(state.sel)!) ? byId.get(state.sel)!.card : null;
    const links = data.links.filter(([a, b]) => cardLive(a) && cardLive(b));
    const origin = cols.getBoundingClientRect();
    const box = (id: string) => {
      const r = (cols.querySelector(`.smap-card[data-card="${id}"]`) as HTMLElement).getBoundingClientRect();
      return { l: r.left - origin.left, r: r.right - origin.left, t: r.top - origin.top, b: r.bottom - origin.top };
    };
    const outs = new Map<string, string[]>();
    const ins = new Map<string, string[]>();
    for (const [a, b] of links) {
      outs.set(a, [...(outs.get(a) ?? []), b]);
      ins.set(b, [...(ins.get(b) ?? []), a]);
    }
    const slot = (list: readonly string[] | undefined, id: string) => ((list ?? []).indexOf(id) + 1) / ((list ?? []).length + 1);
    svg.innerHTML = `<defs><marker id="smap-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1l6 3-6 3" fill="none" stroke="currentColor" stroke-width="1.25"/></marker></defs>` + links.map(([a, b]) => {
      const [A, B, ca, cb] = [box(a), box(b), colOf.get(a)!, colOf.get(b)!];
      let d: string;
      if (ca === cb) {
        const x = A.r + 8 + 5 * (outs.get(a) ?? []).indexOf(b);
        d = `M${A.r} ${A.b - 12}H${x}V${B.t + 14}H${B.r + 2}`;
      } else if (cb > ca) {
        const ya = A.t + 14 + Math.max(0, A.b - A.t - 28) * slot(outs.get(a), b);
        const yb = B.t + 14 + Math.min(120, Math.max(0, B.b - B.t - 28)) * slot(ins.get(b), a);
        const mx = A.r + 10 + Math.max(0, B.l - A.r - 20) * slot(outs.get(a), b);
        d = `M${A.r} ${ya}H${mx}V${yb}H${B.l - 2}`;
      } else {
        const y = Math.max(A.b, B.b) + 8;
        d = `M${A.l} ${A.b - 12}H${A.l - 10}V${y}H${B.r + 10}V${B.b - 12}H${B.r + 2}`;
      }
      const hi = focus !== null && (a === focus || b === focus);
      const cls = [hi ? "hi" : focus !== null ? "dim" : "", Math.abs(cb - ca) > 1 ? "long" : ""].filter(Boolean).join(" ");
      return `<path data-link="${esc(a)} ${esc(b)}" class="${cls}" d="${d}" marker-end="url(#smap-arrow)"/>`;
    }).join("");
    root.querySelectorAll<HTMLElement>(".smap-card").forEach((card) => {
      const id = card.dataset.card!;
      card.classList.toggle("focus", id === focus);
      card.classList.toggle("dim", focus !== null && id !== focus && !links.some(([a, b]) => (a === focus && b === id) || (b === focus && a === id)));
    });
  }

  function renderList() {
    const bucket = (node: MapNode) => {
      const status = statusOf(node);
      if (status === "failed" || status === "stale" || status === "warn") return status;
      if (node.runsOn === "manual") return "manual";
      return status === "ok" ? "ok" : "none";
    };
    const groups: readonly (readonly [string, string])[] = [["failed", t.groupFailed], ["stale", t.groupStale], ["warn", t.groupWarn], ["manual", t.groupManual], ["ok", t.groupOk], ["none", t.groupNone]];
    const nodes = liveNodes();
    $(".smap-list").innerHTML = `<table><thead><tr><th scope="col">${esc(t.colComponent)}</th><th scope="col">${esc(t.colGroup)}</th><th scope="col">Dev</th><th scope="col">Prod</th><th scope="col">${esc(t.colStatus)}</th><th scope="col">${esc(t.colRunsOn)}</th><th scope="col">${esc(t.colMeta)}</th></tr></thead><tbody>${
      groups.map(([group, label]) => {
        const rows = nodes.filter((node) => bucket(node) === group);
        if (rows.length === 0) return "";
        return `<tr class="grp" data-group="${group}"><td colspan="7">${esc(label)} · ${rows.length}</td></tr>${rows.map((node) => `<tr class="row" data-id="${esc(node.id)}" data-status="${statusOf(node)}" aria-selected="${state.sel === node.id}"><td><b>${esc(node.title)}</b> ${chips(node)}</td><td>${esc(cardTitle.get(node.card) ?? "")}</td><td>${stageChip(node, "dev")}</td><td>${stageChip(node, "prod")}</td><td>${dot(statusOf(node))} ${esc(t[statusOf(node)])}</td><td>${esc(node.runsOn === "manual" ? t.manualRun : t[node.runsOn])}</td><td class="hint">${esc(node.meta)}</td></tr>`).join("")}`;
      }).join("")
    }</tbody></table>`;
  }

  function renderDetail() {
    const node = state.sel === null ? undefined : byId.get(state.sel);
    const detail = $(".smap-detail");
    if (node === undefined || !live(node)) {
      detail.innerHTML = `<p class="hint">${esc(t.noSelection)}</p>`;
    } else {
      const status = statusOf(node);
      const component = componentOf(node);
      const related = (cards: readonly string[]) => cards.length === 0 ? "—" : cards.map((card) => `<button type="button" data-card="${esc(card)}">${esc(cardTitle.get(card) ?? card)}</button>`).join("");
      const up = data.links.filter(([a, b]) => b === node.card && cardLive(a)).map(([a]) => a);
      const down = data.links.filter(([a, b]) => a === node.card && cardLive(b)).map(([, b]) => b);
      const stage = (env: Env) => (node.stage[env].live ? node.stage[env].mode ?? t.on : t.off);
      const links = [...node.links[state.env], { label: t.rawHealth, url: healthUrls[state.env], site: "/health" }];
      detail.innerHTML = `<h3>${icon(node)}<span>${esc(node.title)}</span>${dot(status)}</h3>`
        + `<div class="smap-rel">${esc(cardTitle.get(node.card) ?? "")} ${chips(node)}</div>`
        + `<p class="lead">${node.lead}</p>`
        + `<dl class="kv"><dt>${esc(t.stage)}</dt><dd>Dev ${esc(stage("dev"))} · Prod ${esc(stage("prod"))}</dd>`
        + `<dt>${esc(t.status)}</dt><dd data-field="status">${esc(t[status])}${component === undefined ? "" : ` · ${esc(t.at)} ${esc(time(component.at))}`}</dd>`
        + (component !== undefined && component.reason !== "" ? `<dt>${esc(t.reason)}</dt><dd data-field="reason">${esc(component.reason)}</dd>` : "")
        + `<dt>${esc(t.runsOn)}</dt><dd>${esc(node.runsOn === "manual" ? t.manualRun : t[node.runsOn])}</dd></dl>`
        + `<div class="smap-rel">${esc(t.upstream)} ${related(up)}</div><div class="smap-rel">${esc(t.downstream)} ${related(down)}</div>`
        + `<ul class="smap-links">${links.map((link) => `<li><a href="${esc(link.url)}" target="_blank" rel="noopener"><span>${esc(link.label)}</span><span class="ext">${esc(link.site)} ↗</span></a></li>`).join("")}</ul>`
        + `<p class="hint">${esc(t.linksNote)}</p>`
        + (node.runsOn === "manual" ? `<p class="smap-risk" data-risk="manual">⚠ ${esc(t.risk)}</p>` : "");
    }
    const unbound = $(".smap-unbound");
    const bound = new Set(data.nodes.map((node) => node.health));
    const ids = state.health.kind === "ok" ? [...state.health.components.keys()].filter((id) => !bound.has(id)) : [];
    unbound.hidden = ids.length === 0;
    unbound.innerHTML = ids.length === 0 ? "" : `<h3>${esc(t.unbound)}</h3><p class="hint">${esc(t.unboundHint)}</p><ul>${ids.map((id) => {
      const component = (state.health as { components: ReadonlyMap<string, Component> }).components.get(id)!;
      return `<li data-unbound="${esc(id)}"><code>${esc(id)}</code> ${dot(component.status)} ${esc(t[component.status])}${component.reason === "" ? "" : ` · ${esc(component.reason)}`}</li>`;
    }).join("")}</ul>`;
  }

  function render() {
    renderHeader();
    ($(".smap-flow")).hidden = state.view !== "flow";
    ($(".smap-list")).hidden = state.view !== "list";
    if (state.view === "flow") renderFlow();
    else renderList();
    renderDetail();
  }

  function parseComponents(body: unknown): Map<string, Component> | null {
    const list = (body as { components?: unknown }).components;
    if (!Array.isArray(list)) return null;
    const components = new Map<string, Component>();
    for (const entry of list as { id?: unknown; status?: unknown; at?: unknown; reason?: unknown }[]) {
      if (entry === null || typeof entry !== "object" || typeof entry.id !== "string") continue;
      const status = (STATUSES as readonly unknown[]).includes(entry.status) ? entry.status as Status : "unknown";
      components.set(entry.id, { status, at: typeof entry.at === "string" ? entry.at : "", reason: typeof entry.reason === "string" ? entry.reason : "" });
    }
    return components;
  }

  function load() {
    const seq = ++state.seq;
    const env = state.env;
    const tried = new Date().toISOString();
    state.health = { kind: "loading", tried };
    render();
    const settle = (health: Health) => {
      if (seq !== state.seq) return;
      state.health = health;
      render();
    };
    Promise.resolve()
      .then(() => win.fetch(healthUrls[env], { headers: { accept: "application/json" } }))
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((body) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          throw new Error("invalid JSON");
        }
        if (parsed === null || typeof parsed !== "object") throw new Error("invalid JSON");
        const components = parseComponents(parsed);
        const at = new Date().toISOString();
        settle(components === null ? { kind: "none", at } : { kind: "ok", at, components });
      })
      .catch((error: unknown) => settle({ kind: "error", tried, reason: error instanceof Error ? error.message : String(error) }));
  }

  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const env = target.closest<HTMLElement>("[data-env]");
    if (env !== null) {
      if (env.dataset.env !== state.env) {
        state.env = env.dataset.env as Env;
        load();
      }
      return;
    }
    const view = target.closest<HTMLElement>("[data-view]");
    if (view !== null) {
      state.view = view.dataset.view as "flow" | "list";
      render();
      return;
    }
    const node = target.closest<HTMLElement>(".smap-node, tr.row");
    if (node !== null) {
      state.sel = state.sel === node.dataset.id ? null : node.dataset.id!;
      render();
      const detail = $(".smap-detail");
      if (state.sel !== null && detail.getBoundingClientRect().top > win.innerHeight) detail.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    const card = target.closest<HTMLElement>("[data-card]");
    if (card !== null && card.tagName === "BUTTON") {
      const first = data.nodes.find((candidate) => candidate.card === card.dataset.card && live(candidate));
      if (first === undefined) return;
      state.sel = first.id;
      state.view = "flow";
      render();
    }
  });
  win.addEventListener("resize", () => drawWires());
  const fonts = (doc as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
  if (fonts !== undefined) fonts.ready.then(() => drawWires(), () => undefined);
  load();
}
