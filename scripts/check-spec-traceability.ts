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
  caseIds: ReadonlySet<string> = new Set(),
): readonly AcceptanceItem[] {
  return items.filter((item) => item.tag === undefined && !caseIds.has(`${item.spec}#${item.id}`) &&
    !titles.some((title) => new RegExp(`(^|[^A-Za-z0-9])${item.id}:`, "u").test(title)));
}

/** Case files named by a spec's `<!-- test-plan:start … -->` marker (see render-test-plan.ts). */
export function testPlanCaseFiles(markdown: string): readonly string[] {
  return [...markdown.matchAll(/<!-- test-plan:start (\S+) -->/gu)].map((match) => match[1]!);
}

/** Whether a test source imports the case file and runs it with test.each. */
export function runsCaseFile(testSource: string, casePath: string): boolean {
  const module = casePath.split("/").pop()!.replace(/\.ts$/u, "");
  return new RegExp(`from ["'][^"']*/${module.replaceAll(".", "\\.")}["']`, "u").test(testSource) &&
    /\btest\.each\(/u.test(testSource);
}

if (import.meta.main) {
  const items: AcceptanceItem[] = [];
  const specCaseFiles = new Map<string, readonly string[]>();
  for await (const path of new Bun.Glob("docs/specs/*/spec.md").scan({ cwd: root })) {
    if (path.startsWith("docs/specs/_")) continue; // templates
    const markdown = await Bun.file(join(root, path)).text();
    items.push(...acceptanceItems(path, markdown));
    specCaseFiles.set(path, testPlanCaseFiles(markdown));
  }
  const titles: string[] = [];
  const sourcePaths: string[] = [];
  for (const glob of testGlobs) {
    for await (const path of new Bun.Glob(glob).scan({ cwd: root })) {
      if (path.includes("node_modules")) continue;
      sourcePaths.push(path);
      titles.push(...testTitles(await Bun.file(join(root, path)).text()));
    }
  }
  // Rows of a case file count for their spec's IDs only when some test runs that case file.
  const caseIds = new Set<string>();
  const testSources = await Promise.all(sourcePaths.map((path) => Bun.file(join(root, path)).text()));
  for (const [spec, casePaths] of specCaseFiles) {
    for (const casePath of casePaths) {
      if (!testSources.some((source) => runsCaseFile(source, casePath))) {
        console.error(`${spec}: no test runs ${casePath} with test.each`);
        process.exit(1);
      }
      const rows = (await import(join(root, casePath))).testPlanRows as readonly { readonly id: string }[];
      for (const row of rows) caseIds.add(`${spec}#${row.id}`);
    }
  }
  const missing = untracedItems(items, titles, caseIds);
  for (const item of items.filter((value) => value.tag !== undefined)) {
    console.log(`${item.spec} ${item.id}: proven by [${item.tag}], list it in the PR`);
  }
  if (missing.length > 0) {
    for (const item of missing) console.error(`${relative(root, join(root, item.spec))} ${item.id}: no test name contains "${item.id}:"`);
    process.exit(1);
  }
  console.log(`traceability ok: ${items.length} acceptance items`);
}
