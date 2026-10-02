/**
 * Fails when an acceptance ID in a spec marked `Traceability: enforced` has no test whose
 * name contains `<ID>:`. Items tagged `[deploy]` or `[measure]` are proven outside tests.
 * See docs/process/workflow.md.
 */
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const testGlobs = ["apps/**/*.test.ts", "apps/**/*.spec.ts", "packages/**/*.test.ts"];

interface AcceptanceItem {
  readonly spec: string;
  readonly id: string;
  readonly tag?: "deploy" | "measure";
}

export function acceptanceItems(spec: string, markdown: string): readonly AcceptanceItem[] {
  if (!/^Traceability:\s*enforced\s*$/mu.test(markdown)) return [];
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^## Acceptance\s*$/u.test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^## /u.test(line));
  const section = lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
  return [...section.matchAll(/^- ([A-Z]+\d+):\s*(\[(deploy|measure)\])?/gmu)].map((match) => ({
    spec,
    id: match[1]!,
    ...(match[3] === undefined ? {} : { tag: match[3] as "deploy" | "measure" }),
  }));
}

export function testTitles(source: string): readonly string[] {
  return [...source.matchAll(/\b(?:test|it)(?:\.each\([^)]*\))?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/gu)]
    .map((match) => match[2]!);
}

export function untracedItems(
  items: readonly AcceptanceItem[],
  titles: readonly string[],
): readonly AcceptanceItem[] {
  return items.filter((item) => item.tag === undefined &&
    !titles.some((title) => new RegExp(`(^|[^A-Za-z0-9])${item.id}:`, "u").test(title)));
}

if (import.meta.main) {
  const items: AcceptanceItem[] = [];
  for await (const path of new Bun.Glob("docs/specs/*/spec.md").scan({ cwd: root })) {
    if (path.startsWith("docs/specs/_")) continue; // templates
    items.push(...acceptanceItems(path, await Bun.file(join(root, path)).text()));
  }
  const titles: string[] = [];
  for (const glob of testGlobs) {
    for await (const path of new Bun.Glob(glob).scan({ cwd: root })) {
      if (path.includes("node_modules")) continue;
      titles.push(...testTitles(await Bun.file(join(root, path)).text()));
    }
  }
  const missing = untracedItems(items, titles);
  for (const item of items.filter((value) => value.tag !== undefined)) {
    console.log(`${item.spec} ${item.id}: proven by [${item.tag}], list it in the PR`);
  }
  if (missing.length > 0) {
    for (const item of missing) console.error(`${relative(root, join(root, item.spec))} ${item.id}: no test name contains "${item.id}:"`);
    process.exit(1);
  }
  console.log(`traceability ok: ${items.length} acceptance items`);
}
