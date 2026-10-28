import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { readRelease, readRepository } from "../docs-site/build";
import { auditSite, buildDocsSite, DocsError, LOCALES, PUBLIC_PAGES, type DocsInput, type Flow, type FlowNode } from "../docs-site/generate";
import { badgeOf, cellIsOff, cellMode, deployedRows, HEALTH_COMPONENT_IDS, HEALTH_URLS, healthIds, nodeStages, type MapData } from "../docs-site/system-map";
import { COMPONENT_IDS } from "../../apps/data-publisher-worker/src/signals/profile";
import { testPlanRows } from "./system-map.cases";

/** Spec 033 slice 1: gates, badges, and the system map page built from repository data. */
const root = join(import.meta.dir, "../..");
const repo = () => readRepository(root, "unknowntpo/oss-knowledge-base") as { -readonly [K in keyof DocsInput]: DocsInput[K] };
const system = (input: DocsInput) => input.flows.system as Flow;
const nodesOf = (flow: Flow): FlowNode[] => flow.columns.flatMap((column) => column.cards.flatMap((card) => card.nodes));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function problemsOf(run: () => unknown): string[] {
  try {
    run();
    return [];
  } catch (error) {
    if (error instanceof DocsError) return [...error.problems];
    throw error;
  }
}

/** The badge `[kind, text]` the overview's system flow shows for a node, or undefined. */
function badgeInHtml(html: string, node: string): string[] | undefined {
  return new RegExp(`data-node="system-${node}">[\\s\\S]*?</a>`, "u").exec(html)?.[0].match(/class="tag tag-(\w+)">([^<]+)</u)?.slice(1);
}

type Fetch = (url: string) => Promise<Response>;
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Mounts a built page's map in happy-dom by running the page's own inline map script, with `fetch` stubbed. */
async function mount(html: string, fetch: Fetch) {
  const win = new Window({ url: "https://oss-knowledge-base-docs.pages.dev/en/system-map.html", width: 1440, height: 900 });
  const main = /<main id="content">([\s\S]*?)<\/main>/u.exec(html)![1]!;
  win.document.body.innerHTML = `<main id="content">${main}</main>`;
  const calls: string[] = [];
  (win as unknown as { fetch: Fetch }).fetch = (url: string) => {
    calls.push(url);
    return fetch(url);
  };
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1]!).find((body) => body.includes("mountSystemMap"));
  expect(script).toBeDefined();
  new Function("window", "document", script!)(win, win.document);
  await flush();
  const doc = win.document;
  const click = async (selector: string) => {
    (doc.querySelector(selector) as unknown as HTMLElement | null)?.click();
    await flush();
  };
  const ids = (selector: string) => [...doc.querySelectorAll(selector)].map((element) => (element as unknown as HTMLElement).dataset.id!);
  return { win, doc, calls, click, ids };
}

const site = (input: DocsInput = repo()) => buildDocsSite(input);
const dataOf = (html: string) => JSON.parse(/<script type="application\/json" class="smap-data">([\s\S]*?)<\/script>/u.exec(html)![1]!) as MapData;

describe("Spec 033 system map, slice 1", () => {
  test.each(testPlanRows)("$id: Deployed configuration cell $cell → live $live, mode $mode", (row) => {
    expect(cellIsOff(row.cell)).toBe(!row.live);
    const stages = nodeStages({ id: "probe", gate: ["X"] }, new Map([["X", [{ label: "`X`", names: ["X"], dev: row.cell, prod: "unset" }]]]));
    expect(stages.dev.live).toBe(row.live);
    expect(stages.dev.mode ?? "—").toBe(row.mode);
    expect(cellMode(row.cell) ?? "—").toBe(row.mode);
  });

  test("SM1: a node gated by SRE_AGENT (Dev `live`, Prod `off`) is live on Dev only and the system flow shows \"Dev only\"", () => {
    const input = repo();
    const rows = deployedRows(input.featureMap);
    const node = nodesOf(system(input)).find((candidate) => candidate.id === "sre-diag")!;
    expect(node.gate).toEqual(["SRE_AGENT"]);
    expect(rows.get("SRE_AGENT")![0]!.dev.startsWith("`live`")).toBe(true);
    expect(rows.get("SRE_AGENT")![0]!.prod.startsWith("`off`")).toBe(true);
    expect(nodeStages(node, rows)).toEqual({ dev: { live: true, mode: null }, prod: { live: false, mode: null } });
    const files = site(input);
    expect(badgeInHtml(files.get("en/overview.html")!, "sre-diag")).toEqual(["dev", "Dev only"]);
    expect(badgeInHtml(files.get("zh-Hant/overview.html")!, "sre-diag")).toEqual(["dev", "僅 Dev"]);
    // Positive control: the same row turned on for Prod removes the badge; off on Dev too makes it "Off".
    const both = repo();
    both.featureMap = both.featureMap.replace(/(\| `SRE_AGENT`, [^\n]*\| )`off`; no cron/u, "$1`live`");
    expect(both.featureMap).not.toBe(input.featureMap);
    expect(badgeInHtml(site(both).get("en/overview.html")!, "sre-diag")).toBeUndefined();
    const none = repo();
    none.featureMap = none.featureMap.replace(/(\| `SRE_AGENT`, [^|]*\| [^|]*\| )`live` \(owner decision 2026-10-25[^|]*\|/u, "$1unset |");
    expect(none.featureMap).not.toBe(input.featureMap);
    expect(badgeOf(node, deployedRows(none.featureMap))?.kind).toBe("off");
  });

  test("SM3: no system.json node keeps a dev or off hand tag, every badge follows its gates, rq-trig is off everywhere, and j-rq is live everywhere and manual", () => {
    const input = repo();
    const rows = deployedRows(input.featureMap);
    const nodes = nodesOf(system(input));
    expect(nodes.filter((node) => node.tag !== undefined && node.tag.kind !== "on").map((node) => node.id)).toEqual([]);
    const html = site(input).get("en/overview.html")!;
    for (const node of nodes) {
      const stages = nodeStages(node, rows);
      const expected = stages.dev.live && !stages.prod.live ? ["dev", "Dev only"] : !stages.dev.live && !stages.prod.live ? ["off", "Off"] : node.tag === undefined ? undefined : [node.tag.kind, node.tag.text.en];
      expect([node.id, badgeInHtml(html, node.id)]).toEqual([node.id, expected]);
    }
    const trigger = nodes.find((candidate) => candidate.id === "rq-trig")!;
    expect([nodeStages(trigger, rows).dev.live, nodeStages(trigger, rows).prod.live]).toEqual([false, false]);
    expect(badgeInHtml(html, "rq-trig")?.[0]).toBe("off");
    // Owner decision 2026-10-26: the review-queue job runs on a token-authenticated request in both environments.
    const job = nodes.find((candidate) => candidate.id === "j-rq")!;
    expect([job.gate, job.runsOn, nodeStages(job, rows).dev.live, nodeStages(job, rows).prod.live]).toEqual([undefined, "manual", true, true]);
    expect(badgeInHtml(html, "j-rq")).toBeUndefined();
    // No workflow runs verify:health; a person runs it.
    expect(nodes.find((candidate) => candidate.id === "verify")!.runsOn).toBe("manual");
  });

  test("SM3: a gated node with a hand tag of any kind, kind on included, fails the build", () => {
    const input = repo();
    const flow = clone(system(input)) as unknown as { columns: { cards: { nodes: Record<string, unknown>[] }[] }[] };
    const node = flow.columns.flatMap((column) => column.cards.flatMap((card) => card.nodes)).find((candidate) => candidate.id === "sre-diag")!;
    node.tag = { kind: "on", text: { en: "On", "zh-Hant": "開" } };
    input.flows = { ...input.flows, system: flow };
    expect(problemsOf(() => buildDocsSite(input)).some((problem) => problem.includes("node sre-diag") && problem.includes("a gated node has no hand tag"))).toBe(true);
  });

  test("SM12: a gate name found in more than one Deployed configuration row fails the build, naming the rows", () => {
    const input = repo();
    const flow = clone(system(input)) as unknown as { columns: { cards: { nodes: Record<string, unknown>[] }[] }[] };
    flow.columns[0]!.cards[0]!.nodes[0]!.gate = ["SEARCH_QUERY_GATE"];
    input.flows = { ...input.flows, system: flow };
    const problems = problemsOf(() => buildDocsSite(input));
    expect(problems.some((problem) => problem.includes("node cron-pub") && problem.includes("SEARCH_QUERY_GATE") && problem.includes("more than one row") && problem.includes("Pages binding"))).toBe(true);
  });

  test("SM15: every /health component id the Worker can emit is bound by at least one system.json node", () => {
    const bound = new Set(nodesOf(system(repo())).flatMap((node) => healthIds(node)));
    // The list is the Worker's own (apps/data-publisher-worker/src/signals/profile.ts), not a copy.
    expect(HEALTH_COMPONENT_IDS).toBe(COMPONENT_IDS);
    expect(HEALTH_COMPONENT_IDS.length).toBe(12);
    expect(HEALTH_COMPONENT_IDS.filter((id) => !bound.has(id))).toEqual([]);
  });

  test("SM15: a health binding naming an id the Worker cannot emit, an empty list or a repeated id fails the build; a list of ids is accepted", () => {
    const withBinding = (health: unknown) => {
      const input = repo();
      const flow = clone(system(input)) as unknown as { columns: { cards: { nodes: Record<string, unknown>[] }[] }[] };
      flow.columns.flatMap((column) => column.cards.flatMap((card) => card.nodes)).find((candidate) => candidate.id === "j-people")!.health = health;
      input.flows = { ...input.flows, system: flow };
      return problemsOf(() => buildDocsSite(input)).filter((problem) => problem.includes("j-people") && problem.includes("health must be"));
    };
    for (const bad of ["kip-page", ["kip-pages", "nope"], [], ["kip-pages", "kip-pages"], 7]) expect([bad, withBinding(bad).length]).toEqual([bad, 1]);
    // Positive control: one id and a list of distinct ids both build.
    expect(withBinding("kip-pages")).toEqual([]);
    expect(withBinding(["identity-links", "kip-pages", "identity-backfill"])).toEqual([]);
  });

  test("SM12: a gate naming a row that does not exist fails the docs build, naming the node and the row", () => {
    const input = repo();
    const flow = clone(system(input)) as unknown as { columns: { cards: { nodes: Record<string, unknown>[] }[] }[] };
    flow.columns[0]!.cards[0]!.nodes[0]!.gate = ["NO_SUCH_ROW"];
    input.flows = { ...input.flows, system: flow };
    const problems = problemsOf(() => buildDocsSite(input));
    expect(problems.some((problem) => problem.includes("node cron-pub") && problem.includes("NO_SUCH_ROW"))).toBe(true);
    // Positive control: the repository's gates all name rows.
    expect(problemsOf(() => buildDocsSite(repo()))).toEqual([]);
  });

  test("SM4: with Prod selected, the data flow and the list hold exactly the nodes live on Prod; the SRE agent group and its links are absent; the title counts the hidden nodes", async () => {
    const input = repo();
    const html = site(input).get("en/system-map.html")!;
    const rows = deployedRows(input.featureMap);
    const nodes = nodesOf(system(input));
    const prodLive = nodes.filter((node) => nodeStages(node, rows).prod.live).map((node) => node.id).sort();
    const devLive = nodes.filter((node) => nodeStages(node, rows).dev.live).map((node) => node.id).sort();
    expect(prodLive.length).toBeLessThan(devLive.length);
    const map = await mount(html, () => json({ status: "ok" }));
    expect(map.ids(".smap-node").sort()).toEqual(devLive);
    expect(map.doc.querySelector('.smap-card[data-card="sre"]') !== null).toBe(true);
    await map.click('[data-env="prod"]');
    expect(map.ids(".smap-node").sort()).toEqual(prodLive);
    expect(map.doc.querySelector('.smap-card[data-card="sre"]') === null).toBe(true);
    expect(map.doc.querySelector('.smap-card[data-card="ai"]') === null).toBe(true);
    const links = [...map.doc.querySelectorAll(".smap-wires path[data-link]")].map((path) => path.getAttribute("data-link")!);
    expect(links.length).toBeGreaterThan(5);
    expect(links.filter((link) => link.split(" ").some((card) => card === "sre" || card === "ai"))).toEqual([]);
    expect(map.doc.querySelector(".smap-title")!.textContent).toBe(`Data flow · Prod · ${prodLive.length} live components (${nodes.length - prodLive.length} not live, not shown)`);
    await map.click('[data-view="list"]');
    expect(map.ids(".smap-list tr.row").sort()).toEqual(prodLive);
    expect(map.calls).toEqual([HEALTH_URLS.dev, HEALTH_URLS.prod]);
  });

  test("SM5: a failed kip-pages component marks every node bound to it failed with the reason, and their group's summary failed", async () => {
    const html = site().get("en/system-map.html")!;
    const bound = dataOf(html).nodes.filter((node) => node.health.includes("kip-pages") && node.stage.dev.live);
    expect(bound.map((node) => node.id).sort()).toEqual(["cron-people", "j-people", "src-asf"]);
    const reason = "cwiki.apache.org answered 503";
    const map = await mount(html, () => json({ components: [
      { id: "publication", status: "ok", at: "2026-10-25T22:19:42.397Z" },
      { id: "kip-pages", status: "failed", at: "2026-10-26T01:49:47.939Z", reason },
    ] }));
    for (const node of bound) {
      expect(map.doc.querySelector(`.smap-node[data-id="${node.id}"]`)!.getAttribute("data-status")).toBe("failed");
      expect(map.doc.querySelector(`.smap-card[data-card="${node.card}"]`)!.getAttribute("data-status")).toBe("failed");
      await map.click(`.smap-node[data-id="${node.id}"]`);
      expect(map.doc.querySelector('.smap-detail [data-field="status"]')!.textContent).toContain("failed");
      // A node bound to several components names the one the reason is from.
      expect(map.doc.querySelector('.smap-detail [data-field="reason"]')!.textContent).toBe(node.health.length > 1 ? `kip-pages: ${reason}` : reason);
    }
    // An ok binding stays ok; the header counts the failures.
    expect(map.doc.querySelector('.smap-node[data-id="p-commit"]')!.getAttribute("data-status")).toBe("ok");
    expect(map.doc.querySelector('.smap-overall [data-count="failed"]')!.textContent).toBe("3");
    await map.click('[data-view="list"]');
    expect(map.ids('.smap-list tr.row[data-status="failed"]').sort()).toEqual(["cron-people", "j-people", "src-asf"]);
  });

  test("SM5: a node bound to several components (j-people) shows the worst of them; a missing one counts as unknown", async () => {
    const html = site().get("en/system-map.html")!;
    expect(dataOf(html).nodes.find((node) => node.id === "j-people")!.health).toEqual(["identity-links", "kip-pages", "identity-backfill"]);
    const at = "2026-10-26T02:17:53.919Z";
    const statusWith = async (components: readonly Record<string, string>[]) => {
      const map = await mount(html, () => json({ components }));
      await map.click('.smap-node[data-id="j-people"]');
      return [map.doc.querySelector('.smap-node[data-id="j-people"]')!.getAttribute("data-status"), map.doc.querySelector('.smap-detail [data-field="reason"]')?.textContent ?? null];
    };
    const ok = (id: string) => ({ id, status: "ok", at });
    expect(await statusWith([ok("identity-links"), ok("kip-pages"), ok("identity-backfill")])).toEqual(["ok", null]);
    expect(await statusWith([ok("identity-links"), ok("kip-pages"), { id: "identity-backfill", status: "warn", at, reason: "late: no run for 25.0 h" }]))
      .toEqual(["warn", "identity-backfill: late: no run for 25.0 h"]);
    expect(await statusWith([{ id: "identity-links", status: "stale", at, reason: "no run for 28.0 h" }, ok("kip-pages"), { id: "identity-backfill", status: "warn", at, reason: "late" }]))
      .toEqual(["stale", "identity-links: no run for 28.0 h"]);
    expect(await statusWith([ok("identity-links"), ok("kip-pages")])).toEqual(["unknown", null]);
  });

  test("SM6: a manual node carries the manual chip in both views, counts in the header's manual total, and its detail shows the risk note", async () => {
    const html = site().get("en/system-map.html")!;
    const manual = dataOf(html).nodes.filter((node) => node.runsOn === "manual" && node.stage.dev.live).map((node) => node.id).sort();
    expect(manual).toEqual(["j-rq", "manual", "sre-drill", "verify"]);
    const map = await mount(html, () => json({ components: [] }));
    expect(map.ids('.smap-node:has([data-chip="manual"])').sort()).toEqual(manual);
    expect(map.doc.querySelector('.smap-overall [data-count="manual"]')!.textContent).toBe("4");
    await map.click('.smap-node[data-id="sre-drill"]');
    expect(map.doc.querySelector('.smap-detail [data-risk="manual"]') !== null).toBe(true);
    await map.click('.smap-node[data-id="p-commit"]');
    expect(map.doc.querySelector('.smap-detail [data-risk="manual"]') === null).toBe(true);
    await map.click('[data-view="list"]');
    expect(map.ids('.smap-list tr.row:has([data-chip="manual"])').sort()).toEqual(manual);
    expect(map.ids('.smap-list tr.grp[data-group="manual"] ~ tr.row').length).toBeGreaterThan(0);
    await map.click('[data-env="prod"]');
    expect(map.doc.querySelector('.smap-overall [data-count="manual"]')!.textContent).toBe("3");
  });

  test("SM7: links point to the Cloudflare dashboard in the ?to=/:account/ form for the Worker, gateway or bucket, and no link contains an account id", () => {
    for (const locale of LOCALES) {
      const data = dataOf(site().get(`${locale}/system-map.html`)!);
      const node = (id: string) => data.nodes.find((candidate) => candidate.id === id)!;
      const urls = (id: string, env: "dev" | "prod") => node(id).links[env].map((link) => link.url);
      expect(urls("p-commit", "dev")).toEqual(["https://dash.cloudflare.com/?to=/:account/workers/services/view/oss-knowledge-base-data-dev/production/observability/logs"]);
      expect(urls("p-commit", "prod")).toEqual(["https://dash.cloudflare.com/?to=/:account/workers/services/view/oss-knowledge-base-data-prod/production/observability/logs"]);
      expect(urls("sre-diag", "dev")).toContain("https://dash.cloudflare.com/?to=/:account/ai/ai-gateway/gateways/osskb-sre-dev/logs");
      expect(urls("r2-feed", "prod")).toContain("https://dash.cloudflare.com/?to=/:account/r2/default/buckets/oss-knowledge-base-prod");
      expect(urls("src-ci", "dev")).toEqual(["https://github.com/unknowntpo/oss-knowledge-base/actions"]);
      expect(urls("verify", "dev")).toEqual([]);
      for (const link of data.nodes.flatMap((candidate) => [...candidate.links.dev, ...candidate.links.prod])) {
        expect(link.url).toMatch(/^https:\/\/(dash\.cloudflare\.com\/\?to=\/:account\/|github\.com\/unknowntpo\/oss-knowledge-base\/)/u);
        expect(link.url).not.toMatch(/[0-9a-f]{32}/u);
      }
    }
  });

  test("SM8: against tag v0.3.2, the changes list names the added nodes, each Deployed configuration cell change as old → new, and the merged PRs in v0.3.2..HEAD", () => {
    const dir = mkdtempSync(join(tmpdir(), "smap-"));
    try {
      const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-24T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-24T00:00:00Z" } }).toString();
      git("init", "-q", "-b", "main");
      git("config", "user.email", "test@example.invalid");
      git("config", "user.name", "test");
      const input = repo();
      const flow = clone(system(input)) as Flow & { columns: { cards: { id: string; nodes: unknown[] }[] }[] };
      const before = clone(flow);
      for (const column of before.columns) column.cards = column.cards.filter((card) => card.id !== "sre");
      before.links = before.links.filter(([a, b]) => a !== "sre" && b !== "sre");
      const write = (flowValue: unknown, featureMap: string) => {
        mkdirSync(join(dir, "docs/site/flows"), { recursive: true });
        writeFileSync(join(dir, "docs/site/flows/system.json"), JSON.stringify(flowValue));
        writeFileSync(join(dir, "docs/feature-map.md"), featureMap);
      };
      const old = input.featureMap.replace(/(\| `SRE_AGENT`, [^|]*\| [^|]*\| )`live` \(owner decision 2026-10-25[^|]*\|/u, "$1`off` |")
        .replace(/(\| `R2_RETENTION`, `RETENTION_CRON` \| [^|]*\| )`dry-run`;[^|]*\|/u, "$1unset |");
      expect(old).not.toBe(input.featureMap);
      write(before, old);
      git("add", ".");
      git("commit", "-q", "-m", "release");
      git("tag", "v0.3.2");
      write(flow, input.featureMap);
      git("add", ".");
      git("commit", "-q", "-m", "feat(sre-agent): the SRE agent (#151)");
      git("commit", "-q", "--allow-empty", "-m", "docs: no pull request number");
      git("commit", "-q", "--allow-empty", "-m", "fix: path URLs (#150)");
      const release = readRelease(dir)!;
      expect(release).toMatchObject({ tag: "v0.3.2", distance: 3, pulls: [{ number: 150, subject: "fix: path URLs" }, { number: 151, subject: "feat(sre-agent): the SRE agent" }] });
      input.release = release;
      const html = site(input).get("en/system-map.html")!;
      const changes = dataOf(html).changes;
      const text = (op: string) => changes.filter((change) => change.op === op).map((change) => change.html.replace(/<[^>]+>/gu, ""));
      expect(text("add")).toEqual(["New group SRE agent: Collect firings, Diagnose, Record the run, Fault drill"]);
      expect(text("flag")).toEqual(expect.arrayContaining(["SRE_AGENT Dev off → live", "R2_RETENTION Dev unset → dry-run"]));
      expect(text("risk")).toEqual(["New manual step: Fault drill · nothing schedules it; a person runs it"]);
      expect(text("pr")).toEqual(["#150 fix: path URLs", "#151 feat(sre-agent): the SRE agent"]);
      expect(html).toContain('href="https://github.com/unknowntpo/oss-knowledge-base/pull/151"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SM16: with no v* tag reachable, the changes section says no release tag was found and the build does not fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "smap-"));
    try {
      execFileSync("git", ["-C", dir, "init", "-q"]);
      execFileSync("git", ["-C", dir, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
      expect(readRelease(dir)).toBeNull();
      const input = repo();
      input.release = null;
      const files = site(input);
      const html = files.get("en/system-map.html")!;
      expect(html).toContain('<p class="smap-nochanges">No release tag (v*) is reachable from this build commit');
      expect(html).toContain("<h3>Changes · no tag</h3>");
      expect(dataOf(html).release).toBeNull();
      expect(auditSite(files)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [what, fetch] of [
    ["unreachable", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a 503 answer", () => json({ error: "down" }, 503)],
    ["invalid JSON", () => Promise.resolve(new Response("<html>", { status: 200 }))],
  ] as const) {
    test(`SM13: /health ${what} → the map renders from build data, every node unknown, the header says it could not be read and when`, async () => {
      const map = await mount(site().get("en/system-map.html")!, fetch);
      const statuses = new Set([...map.doc.querySelectorAll(".smap-node")].map((node) => node.getAttribute("data-status")));
      expect(map.doc.querySelectorAll(".smap-node").length).toBeGreaterThan(30);
      expect([...statuses]).toEqual(["unknown"]);
      expect(map.doc.querySelector(".smap-healthnote")!.textContent).toMatch(/^\/health could not be read \(.+\) · tried \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/u);
    });
  }

  test("SM14: a /health without components (today's Prod) → every node n/a and the header says the Worker does not report components", async () => {
    const map = await mount(site().get("en/system-map.html")!, () => json({ lastRun: { status: "failed" }, kipPages: { lastRun: { status: "failed" } } }));
    expect(new Set([...map.doc.querySelectorAll(".smap-node")].map((node) => node.getAttribute("data-status")))).toEqual(new Set(["na"]));
    expect(map.doc.querySelector(".smap-healthnote")!.textContent).toContain("the Worker does not report components");
    expect(map.doc.querySelector('.smap-overall [data-count="failed"]')!.textContent).toBe("0");
  });

  test("SM15: a components id that no node binds is listed as not on the map", async () => {
    const map = await mount(site().get("en/system-map.html")!, () => json({ components: [{ id: "kip-pages", status: "ok", at: "2026-10-26T01:49:47.939Z" }, { id: "source:apache-wiki", status: "stale", at: "2026-10-20T00:00:00.000Z", reason: "no run" }] }));
    const unbound = map.doc.querySelector(".smap-unbound") as unknown as HTMLElement;
    expect(unbound.hidden).toBe(false);
    expect(unbound.textContent).toContain("Not on the map");
    expect([...unbound.querySelectorAll("[data-unbound]")].map((item) => item.getAttribute("data-unbound"))).toEqual(["source:apache-wiki"]);
  });

  test("SM17: a Dev fetch still pending when the reader switches to Prod is not applied; only the Prod answer is", async () => {
    let releaseDev: (response: Response) => void = () => undefined;
    const map = await mount(site().get("en/system-map.html")!, (url) => url === HEALTH_URLS.dev
      ? new Promise<Response>((resolve) => { releaseDev = resolve; })
      : json({ components: [{ id: "publication", status: "ok", at: "2026-10-25T22:37:00.000Z" }] }));
    await map.click('[data-env="prod"]');
    expect(map.doc.querySelector('.smap-node[data-id="p-commit"]')!.getAttribute("data-status")).toBe("ok");
    releaseDev(new Response(JSON.stringify({ components: [{ id: "publication", status: "failed", at: "2026-10-26T00:00:00.000Z", reason: "late Dev answer" }] }), { status: 200 }));
    await flush();
    expect(map.doc.querySelector('.smap-node[data-id="p-commit"]')!.getAttribute("data-status")).toBe("ok");
    expect(map.doc.querySelector('[data-env="prod"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(map.calls).toEqual([HEALTH_URLS.dev, HEALTH_URLS.prod]);
  });

  test("SM23: auditSite reports an inline script naming a URL other than the two /health URLs, and accepts the built map page", () => {
    const files = site();
    expect(auditSite(files)).toEqual([]);
    const page = files.get("en/system-map.html")!;
    expect(page).toContain(HEALTH_URLS.dev);
    expect(page).toContain(HEALTH_URLS.prod);
    files.set("en/system-map.html", page.replace("</body>", '<script>fetch("https://example.com/collect")</script></body>'));
    expect(auditSite(files)).toContain("en/system-map.html: an inline script names a URL other than the publisher /health: https://example.com/collect");
    // A protocol-relative URL in a script, and a URL in an inline event handler, are reported too.
    files.set("en/system-map.html", page.replace("</body>", '<script>fetch("//example.com/beacon")</script></body>'));
    expect(auditSite(files)).toContain("en/system-map.html: an inline script names a URL other than the publisher /health: //example.com/beacon");
    files.set("en/system-map.html", page.replace("</main>", `<button onclick="fetch('https://example.com/x')">x</button><img alt="" src="" onerror="fetch('//example.com/y')"></main>`));
    const handlers = auditSite(files);
    expect(handlers).toContain("en/system-map.html: an inline event handler names a URL other than the publisher /health: https://example.com/x");
    expect(handlers).toContain("en/system-map.html: an inline event handler names a URL other than the publisher /health: //example.com/y");
    // The two /health URLs outside a script are still a Worker hostname advertised (Spec 025 DOC7).
    files.set("en/system-map.html", page.replace("</main>", `<p>${HEALTH_URLS.dev}</p></main>`));
    expect(auditSite(files).some((problem) => problem.includes("advertises a Worker hostname"))).toBe(true);
  });

  test("the public docs build (rule 17, decision 5 as amended) has no map page, no map output and no link to the map", () => {
    const files = buildDocsSite(repo(), PUBLIC_PAGES);
    expect(auditSite(files)).toEqual([]);
    for (const locale of LOCALES) expect(files.has(`${locale}/system-map.html`)).toBe(false);
    for (const [path, content] of files) {
      expect(content, path).not.toContain("system-map.html");
      expect(content, path).not.toContain('class="smap"');
      expect(content, path).not.toContain("mountSystemMap");
    }
    expect(JSON.parse(files.get("build.json")!).pages).not.toContain("system-map");
  });
});
