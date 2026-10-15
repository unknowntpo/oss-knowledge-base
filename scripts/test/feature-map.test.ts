import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * docs/feature-map.md drifts when a change forgets it. These checks catch the mechanical part:
 * a route without a row in its API table, a deployed variable or binding, a verification command,
 * or a spec's newest acceptance ID that the map does not name. They cannot tell whether what the map says about it is true.
 */
const root = join(import.meta.dir, "..", "..");
const read = (path: string) => Bun.file(join(root, path)).text();
const map = await read("docs/feature-map.md");
const rows = map.split("\n").filter((line) => line.startsWith("| "));

describe("feature map", () => {
  test("has a row for every Pages Function route", async () => {
    const routes: string[] = [];
    for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: join(root, "apps/web/functions/api") })) {
      // Pages routing: `index.ts` serves its directory, and every `[param]` segment is a parameter.
      routes.push(`/api/${file.replace(/\.ts$/u, "").replace(/\/?\bindex$/u, "").replace(/\[(\w+)\]/gu, ":$1")}`.replace(/\/$/u, ""));
    }
    expect(routes.length).toBeGreaterThanOrEqual(5);
    // The row itself, in the Web API table: a mention elsewhere in the map is not enough.
    const hasRow = (route: string) => rows.some((row) => row.startsWith(`| \`${route}`) && !/[\w-]/u.test(row.charAt(route.length + 3)));
    expect(routes.filter((route) => !hasRow(route))).toEqual([]);
    // Positive control: a route that shares a prefix with a listed one has no row of its own.
    expect(hasRow("/api/search-det")).toBe(false);
  });

  test("has a row for every public route of the data Worker", async () => {
    const source = await read("apps/data-publisher-worker/src/index.ts");
    // The default export's handlers; the Durable Object classes below it have internal routes.
    const handler = source.slice(source.indexOf("export default {"), source.indexOf("satisfies ExportedHandler"));
    const routes = [...new Set([...handler.matchAll(/url\.pathname === "([^"]+)"/gu)].map((match) => match[1]!))];
    expect(routes).toContain("/health");
    expect(routes.length).toBeGreaterThanOrEqual(5);
    expect(routes.filter((route) => !rows.some((row) => new RegExp(`^\\| \`(GET|POST) ${route}[\`\\[]`, "u").test(row)))).toEqual([]);
  });

  test("names every variable and binding of the deployed configurations", async () => {
    const names = new Set<string>();
    for (const path of [
      "apps/data-publisher-worker/wrangler.development.jsonc",
      "apps/data-publisher-worker/wrangler.production.jsonc",
      "apps/web/wrangler.development.jsonc",
      "apps/web/wrangler.production.jsonc",
    ]) {
      const config = JSON.parse(await read(path)) as {
        readonly vars?: Readonly<Record<string, string>>;
        readonly ai?: { readonly binding: string };
        readonly vectorize?: readonly { readonly binding: string; readonly index_name: string }[];
        readonly r2_buckets?: readonly { readonly binding: string; readonly bucket_name: string }[];
        readonly durable_objects?: { readonly bindings: readonly { readonly name: string; readonly class_name: string }[] };
        readonly migrations?: readonly { readonly tag: string }[];
      };
      for (const name of Object.keys(config.vars ?? {})) names.add(name);
      if (config.ai !== undefined) names.add(config.ai.binding);
      for (const index of config.vectorize ?? []) names.add(index.binding).add(index.index_name);
      for (const bucket of config.r2_buckets ?? []) names.add(bucket.binding).add(bucket.bucket_name);
      for (const binding of config.durable_objects?.bindings ?? []) names.add(binding.name).add(binding.class_name);
      for (const migration of config.migrations ?? []) names.add(migration.tag);
    }
    expect(names.size).toBeGreaterThan(15);
    expect([...names].filter((name) => !map.includes(`\`${name}\``))).toEqual([]);
  });

  test("names every verification, measurement, and gate command of the root package", async () => {
    const scripts = Object.keys((JSON.parse(await read("package.json")) as { readonly scripts: Readonly<Record<string, string>> }).scripts)
      .filter((name) => /^(verify|measure|eval|check|docs):/u.test(name) || name === "test:e2e:development");
    expect(scripts.length).toBeGreaterThan(8);
    expect(scripts.filter((name) => !map.includes(name))).toEqual([]);
  });

  test("gives each spec's newest acceptance ID in its row", async () => {
    const stale: string[] = [];
    let checked = 0;
    for await (const path of new Bun.Glob("docs/specs/[0-9]*/spec.md").scan({ cwd: root })) {
      const directory = path.slice(0, path.lastIndexOf("/"));
      const number = directory.split("/")[2]!.slice(0, 3);
      // Two styles: `- H12: …` items under `## Acceptance` of spec.md (enforced or not), and
      // `## R7 — …` headings of an older spec's acceptance.md.
      const spec = await read(path);
      const start = spec.search(/^## Acceptance\s*$/mu);
      const section = start < 0 ? "" : spec.slice(start).replace(/\n## (?!Acceptance)[\s\S]*$/u, "");
      const ids = [...section.matchAll(/^- ([A-Z]+\d+):/gmu)].map((match) => match[1]!);
      const acceptance = Bun.file(join(root, directory, "acceptance.md"));
      if (await acceptance.exists()) ids.push(...[...(await acceptance.text()).matchAll(/^#{2,3} ([A-Z]+\d+)\b/gmu)].map((match) => match[1]!));
      if (ids.length === 0) continue;
      checked += 1;
      const row = rows.find((line) => line.startsWith(`| [${number}](`));
      // The most numerous prefix is the spec's own (a spec may cite another's ID in passing).
      const prefixes = new Map<string, number[]>();
      for (const id of ids) {
        const [, prefix, digits] = /^([A-Z]+)(\d+)$/u.exec(id)!;
        prefixes.set(prefix!, [...prefixes.get(prefix!) ?? [], Number(digits)]);
      }
      const [prefix, numbers] = [...prefixes].sort((left, right) => right[1].length - left[1].length)[0]!;
      const newest = `${prefix}${Math.max(...numbers)}`;
      if (row === undefined || !new RegExp(`${prefix}1–${newest}(?!\\d)`, "u").test(row)) stale.push(`${number}: the row should read ${prefix}1–${newest}`);
    }
    // Every spec from 001 on has acceptance items in one of the two styles.
    expect(checked).toBeGreaterThanOrEqual(17);
    expect(stale).toEqual([]);
  });
});
