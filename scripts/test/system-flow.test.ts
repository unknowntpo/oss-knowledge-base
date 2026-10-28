import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LOCALES, type Flow, type FlowNode } from "../docs-site/generate";
import { badgeOf, deployedRows } from "../docs-site/system-map";

/**
 * Spec 025 DOC20: docs/site/flows/system.json is hand-written, so it drifts when a change forgets it.
 * These checks catch the mechanical part: a cron target, a cron entry, a Worker or Pages binding, an
 * AI Gateway, a Pages Function route or a Worker route family that the diagram does not name, and a
 * Dev-only item that is not shown as Dev only (or a Prod item shown only as Dev). They cannot tell
 * whether what a step says about it is true.
 *
 * A name counts when it appears in backticks in a step's details (lead or facts) in both locales,
 * so `SEARCH_QUERY` is not satisfied by `SEARCH_QUERY_GATE`. Badges: an item deployed only on Dev
 * must be named by a step tagged `dev` or under a fact keyed "Dev"; an item deployed on Prod by an
 * untagged step or under a fact keyed "Prod". A step's badge is the one the docs site shows: computed
 * from its `gate` rows of the Deployed configuration (Spec 033 Behavior 3).
 */
const root = join(import.meta.dir, "..", "..");
const read = (path: string) => Bun.file(join(root, path)).text();

type Env = "dev" | "prod";
interface Item { readonly name: string; readonly what: string; readonly envs?: ReadonlySet<Env> }

const CONFIGS: readonly { readonly path: string; readonly env: Env }[] = [
  { path: "apps/data-publisher-worker/wrangler.development.jsonc", env: "dev" },
  { path: "apps/data-publisher-worker/wrangler.production.jsonc", env: "prod" },
  { path: "apps/web/wrangler.development.jsonc", env: "dev" },
  { path: "apps/web/wrangler.production.jsonc", env: "prod" },
];

/** Everything the code and the deployed configurations say exists. */
async function inventory(): Promise<Item[]> {
  const items: Item[] = [];
  const source = await read("apps/data-publisher-worker/src/index.ts");

  // Every target `cronTarget()` can route a tick to (its return type).
  const signature = /export function cronTarget\([^)]*\):\s*([^{]+)\{/u.exec(source)?.[1] ?? "";
  for (const match of signature.matchAll(/"([\w-]+)"/gu)) items.push({ name: match[1]!, what: "cron target" });

  // Every route family of the Worker's default handler: `/health` by name, `/run` is the publisher,
  // the rest by job (their paths are not printed: Spec 025 DOC7 forbids advertising manual triggers).
  const handler = source.slice(source.indexOf("export default {"), source.indexOf("satisfies ExportedHandler"));
  for (const match of handler.matchAll(/url\.pathname === "([^"]+)"/gu)) {
    const route = match[1]!;
    const name = route === "/health" ? "/health" : route === "/run" ? "publisher" : route.split("/")[1]!;
    items.push({ name, what: `Worker route ${route}` });
  }

  // Bindings, their resources, cron entries and AI Gateways, with the environments that deploy them.
  const deployed = new Map<string, { what: string; envs: Set<Env> }>();
  const add = (name: string, what: string, env: Env) => {
    const entry = deployed.get(name) ?? { what, envs: new Set<Env>() };
    entry.envs.add(env);
    deployed.set(name, entry);
  };
  for (const { path, env } of CONFIGS) {
    const config = JSON.parse(await read(path)) as {
      readonly vars?: Readonly<Record<string, string>>;
      readonly ai?: { readonly binding: string };
      readonly vectorize?: readonly { readonly binding: string; readonly index_name: string }[];
      readonly analytics_engine_datasets?: readonly { readonly binding: string; readonly dataset: string }[];
      readonly analytics?: { readonly binding: string };
      readonly r2_buckets?: readonly { readonly binding: string; readonly bucket_name: string }[];
      readonly durable_objects?: { readonly bindings: readonly { readonly name: string }[] };
      readonly triggers?: { readonly crons?: readonly string[] };
    };
    const app = path.split("/")[1]!;
    if (config.ai !== undefined) add(config.ai.binding, `${app} AI binding`, env);
    for (const index of config.vectorize ?? []) add(index.binding, `${app} Vectorize binding`, env), add(index.index_name, "Vectorize index", env);
    for (const dataset of config.analytics_engine_datasets ?? []) add(dataset.binding, `${app} Analytics Engine binding`, env), add(dataset.dataset, "Analytics Engine dataset", env);
    if (config.analytics !== undefined) add(config.analytics.binding, `${app} Analytics SQL binding`, env);
    for (const bucket of config.r2_buckets ?? []) add(bucket.binding, `${app} R2 binding`, env), add(bucket.bucket_name, "R2 bucket", env);
    for (const object of config.durable_objects?.bindings ?? []) add(object.name, `${app} Durable Object binding`, env);
    for (const cron of config.triggers?.crons ?? []) add(cron, `${app} cron entry`, env);
    for (const [name, value] of Object.entries(config.vars ?? {})) if (/GATEWAY/u.test(name) && value.trim() !== "") add(value, `AI Gateway (${name})`, env);
  }
  for (const [name, { what, envs }] of deployed) items.push({ name, what, envs });

  // Every Pages Function route (same derivation as scripts/test/feature-map.test.ts).
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: join(root, "apps/web/functions/api") })) {
    const route = `/api/${file.replace(/\.ts$/u, "").replace(/\/?\bindex$/u, "").replace(/\[(\w+)\]/gu, ":$1")}`.replace(/\/$/u, "");
    items.push({ name: route, what: "Pages Function route" });
  }
  return items;
}

const nodesOf = (flow: Flow): FlowNode[] => flow.columns.flatMap((column) => column.cards.flatMap((card) => card.nodes));

/** Whether `node` names `name` in backticks, in both locales; with `factKey`, only under a fact with that English key. */
function names(node: FlowNode, name: string, factKey?: string): boolean {
  const needle = `\`${name}\``;
  return LOCALES.every((locale) => {
    const texts = factKey === undefined
      ? [node.lead[locale], ...(node.facts ?? []).flatMap((fact) => [fact.k[locale], fact.v[locale]])]
      : (node.facts ?? []).filter((fact) => fact.k.en === factKey).map((fact) => fact.v[locale]);
    return texts.some((text) => text.includes(needle));
  });
}

const rows = deployedRows(await read("docs/feature-map.md"));
const kindOf = (node: FlowNode) => badgeOf(node, rows)?.kind;

/** The problems of `flow` against `items`: one line per missing item or wrong badge. */
function systemFlowProblems(flow: Flow, items: readonly Item[]): string[] {
  const nodes = nodesOf(flow);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.name}\u0000${item.what}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const naming = nodes.filter((node) => names(node, item.name));
    if (naming.length === 0) {
      problems.push(`${item.what} \`${item.name}\` is not named in system.json`);
      continue;
    }
    if (item.envs === undefined) continue;
    if (item.envs.has("prod")) {
      if (!naming.some((node) => kindOf(node) === undefined || names(node, item.name, "Prod"))) {
        problems.push(`${item.what} \`${item.name}\` is deployed on Prod but only named by Dev-tagged steps`);
      }
    } else if (!naming.some((node) => kindOf(node) === "dev" || names(node, item.name, "Dev"))) {
      problems.push(`${item.what} \`${item.name}\` is Dev only but no step naming it is tagged Dev only`);
    }
  }
  return problems;
}

const flow = JSON.parse(await read("docs/site/flows/system.json")) as Flow;
const items = await inventory();

describe("system flow completeness", () => {
  test("DOC20: system.json names every cron target, cron entry, binding, AI Gateway, Pages route and Worker route family, with Dev/Prod badges", () => {
    // The inventory itself is not empty or truncated (a parsing regression would make the check vacuous).
    const named = new Set(items.map((item) => item.name));
    for (const name of ["publisher", "sre-agent", "retention", "review-queue", "cost-guard", "/health", "AI", "SIGNALS", "ANALYTICS_SQL", "SEARCH_VECTORS", "OSS_KB_BUCKET", "PIPELINE_STATE", "COST_GUARD_STATE", "osskb-sre-dev", "/api/search", "/api/people/:project/:id", "37 22 * * *"]) {
      expect(named.has(name)).toBe(true);
    }
    expect(systemFlowProblems(flow, items)).toEqual([]);
  });

  test("DOC20: a removed step, a near-miss name and a wrong badge are reported (positive controls)", () => {
    const clone = () => JSON.parse(JSON.stringify(flow)) as { columns: { cards: { nodes: Record<string, unknown>[] }[] }[] } & Flow;
    // Dropping every step that names `SIGNALS` reports it as missing.
    const removed = clone();
    for (const column of removed.columns) for (const card of column.cards) card.nodes = card.nodes.filter((node) => !names(node as unknown as FlowNode, "SIGNALS"));
    expect(systemFlowProblems(removed as Flow, items)).toContain("data-publisher-worker Analytics Engine binding `SIGNALS` is not named in system.json");
    // A longer name does not count for a shorter one.
    expect(systemFlowProblems(flow, [{ name: "SEARCH_QUERY", what: "probe" }])).toEqual(["probe `SEARCH_QUERY` is not named in system.json"]);
    // A Dev-only binding whose steps lose their gate is reported.
    const untagged = clone();
    for (const column of untagged.columns) for (const card of column.cards) for (const node of card.nodes) if (names(node as unknown as FlowNode, "COST_GUARD_STATE")) delete node.gate;
    expect(systemFlowProblems(untagged as Flow, items)).toContain("data-publisher-worker Durable Object binding `COST_GUARD_STATE` is Dev only but no step naming it is tagged Dev only");
    // A Prod binding named only by Dev-tagged steps is reported.
    expect(systemFlowProblems(flow, [{ name: "COST_GUARD_STATE", what: "probe", envs: new Set<Env>(["dev", "prod"]) }])).toEqual(["probe `COST_GUARD_STATE` is deployed on Prod but only named by Dev-tagged steps"]);
  });
});
