/**
 * Fails when an acceptance ID in a spec marked `Traceability: enforced` has no test whose
 * name contains `<ID>:`. Items tagged `[deploy]` or `[measure]` are proven outside tests.
 * Items tagged `[pending]` (and case files marked `[pending]`) belong to a planned later slice:
 * they are listed, not failed, but a pending item that already has a test is a stale tag, and a
 * spec whose Status starts with "Implemented" may not keep anything pending.
 * See docs/process/workflow.md.
 */
import { dirname, join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const testGlobs = ["apps/**/*.test.ts", "apps/**/*.spec.ts", "packages/**/*.test.ts"];

interface AcceptanceItem {
  readonly spec: string;
  readonly id: string;
  readonly tag?: "deploy" | "measure" | "pending";
}

export function acceptanceItems(spec: string, markdown: string): readonly AcceptanceItem[] {
  if (!/^Traceability:\s*enforced\s*$/mu.test(markdown)) return [];
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^## Acceptance\s*$/u.test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^## /u.test(line));
  const section = lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
  return [...section.matchAll(/^- ([A-Z]+\d+):\s*(\[(deploy|measure|pending)\])?/gmu)].map((match) => ({
    spec,
    id: match[1]!,
    ...(match[3] === undefined ? {} : { tag: match[3] as "deploy" | "measure" | "pending" }),
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
    !hasTest(titles, item.id));
}

export interface CaseFileRef {
  readonly path: string;
  readonly pending: boolean;
}

/** Case files named by a spec's `<!-- test-plan:start <path> [pending]? -->` marker (see render-test-plan.ts). */
export function testPlanCaseFiles(markdown: string): readonly CaseFileRef[] {
  return [...markdown.matchAll(/<!-- test-plan:start (\S+)( \[pending\])? -->/gu)]
    .map((match) => ({ path: match[1]!, pending: match[2] !== undefined }));
}

function hasTest(titles: readonly string[], id: string): boolean {
  return titles.some((title) => new RegExp(`(^|[^A-Za-z0-9])${id}:`, "u").test(title));
}

export interface TraceabilityInput {
  readonly specs: readonly { readonly path: string; readonly markdown: string }[];
  readonly tests: readonly { readonly path: string; readonly source: string }[];
  readonly rows: (casePath: string) => readonly { readonly id: string }[] | Promise<readonly { readonly id: string }[]>;
}

export interface TraceabilityResult {
  readonly errors: readonly string[];
  readonly pending: readonly string[];
  readonly proven: readonly string[];
  readonly items: number;
}

export async function checkTraceability(input: TraceabilityInput): Promise<TraceabilityResult> {
  const errors: string[] = [];
  const pendingFiles: string[] = [];
  const titles = input.tests.flatMap((test) => testTitles(test.source));
  const items: AcceptanceItem[] = [];
  const caseIds = new Set<string>();
  for (const { path: spec, markdown } of input.specs) {
    errors.push(...markerErrors(markdown).map((error) => `${spec}: ${error}`), ...acceptanceErrors(spec, markdown));
    const specItems = acceptanceItems(spec, markdown);
    if (specItems.length === 0) continue;
    items.push(...specItems);
    const implemented = /^Status:\s*Implemented/mu.test(markdown);
    // Rows of a case file count for their spec's IDs only when some test runs that case file.
    for (const caseFile of testPlanCaseFiles(markdown)) {
      const run = input.tests.some((test) => runsCaseFile(test.source, caseFile.path, test.path));
      if (caseFile.pending) {
        pendingFiles.push(`${spec} ${caseFile.path}: [pending] case file`);
        if (run) errors.push(`${spec}: ${caseFile.path} is marked [pending] but a test runs it`);
        if (implemented) errors.push(`${spec}: ${caseFile.path} is [pending] in a spec whose Status is Implemented`);
        continue;
      }
      if (!run) {
        errors.push(`${spec}: no test runs ${caseFile.path} with test.each`);
        continue;
      }
      for (const row of await input.rows(caseFile.path)) caseIds.add(`${spec}#${row.id}`);
    }
    for (const item of specItems.filter((value) => value.tag === "pending")) {
      if (implemented) errors.push(`${spec} ${item.id}: [pending] in a spec whose Status is Implemented`);
      if (hasTest(titles, item.id) || caseIds.has(`${spec}#${item.id}`)) {
        errors.push(`${spec} ${item.id}: tagged [pending] but a test name contains "${item.id}:"`);
      }
    }
  }
  for (const item of untracedItems(items, titles, caseIds)) errors.push(`${item.spec} ${item.id}: no test name contains "${item.id}:"`);
  return {
    errors,
    pending: [...items.filter((item) => item.tag === "pending").map((item) => `${item.spec} ${item.id}: [pending]`), ...pendingFiles],
    proven: items.filter((item) => item.tag === "deploy" || item.tag === "measure").map((item) => `${item.spec} ${item.id}: proven by [${item.tag}], list it in the PR`),
    items: items.length,
  };
}

/**
 * Whether a test source runs the whole case file: a top-level value import of `testPlanRows`
 * whose specifier resolves (from `testPath`, when given) to `casePath`, and
 * `test.each(testPlanRows)` or `test.each([...testPlanRows] …)` outside comments. A filtered or
 * sliced call runs only some rows, so it does not count.
 */
export function runsCaseFile(testSource: string, casePath: string, testPath?: string): boolean {
  const code = testSource.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/(^|[^:"'`])\/\/.*$/gmu, "$1");
  const module = casePath.split("/").pop()!.replace(/\.ts$/u, "");
  const imports = [...code.matchAll(/^import\s+\{([^}]*)\}\s+from\s+["']([^"']+)["'];?\s*$/gmu)].filter((match) =>
    /(?<!type\s)\btestPlanRows\b/u.test(match[1]!) &&
    (testPath === undefined
      ? match[2]!.replace(/\.js$/u, "").endsWith(`/${module}`)
      : join(dirname(testPath), match[2]!).replace(/\.[jt]s$/u, "") === casePath.replace(/\.ts$/u, "")));
  // The whole array, optionally spread into a copy, optionally cast; never filtered or sliced.
  const runsAll = /\btest\.each\(\s*(?:testPlanRows|\[\s*\.\.\.testPlanRows\s*\])(?:\s+as\s+[^()]*)?\s*\)/u;
  return imports.length > 0 && runsAll.test(code);
}

const MARKER = /^<!-- test-plan:start \S+( \[pending\])? -->$/u;

/** Every line that mentions `test-plan:start` must be a well-formed marker (verifier F2). */
export function markerErrors(markdown: string): readonly string[] {
  // No trimming: trailing whitespace or a CR would make the renderer skip the table (N1).
  const errors: string[] = [];
  let fenced = false;
  let open: string | undefined;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/u.test(line)) fenced = !fenced;
    if (line.includes("test-plan:start")) {
      if (!MARKER.test(line)) {
        errors.push(`malformed test-plan marker: ${JSON.stringify(line)}`);
        continue;
      }
      if (fenced) {
        errors.push(`test-plan marker inside a fenced code block: ${JSON.stringify(line)}`);
        continue;
      }
      if (open !== undefined) errors.push(`test-plan:start without test-plan:end: ${JSON.stringify(open)}`);
      open = line;
    } else if (line.includes("test-plan:end") && !fenced) {
      open = undefined;
    }
  }
  if (open !== undefined) errors.push(`test-plan:start without test-plan:end: ${JSON.stringify(open)}`);
  return errors;
}

const TAGS = ["deploy", "measure", "pending"];

/** Tag and bullet shapes the item parser would otherwise drop silently (verifier F2, F4). */
export function acceptanceErrors(spec: string, markdown: string): readonly string[] {
  if (!/^Traceability:\s*enforced\s*$/mu.test(markdown)) return [];
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^## Acceptance\s*$/u.test(line));
  if (start < 0) return [`${spec}: enforced spec has no "## Acceptance" section`];
  const end = lines.findIndex((line, index) => index > start && /^## /u.test(line));
  const errors: string[] = [];
  for (const line of lines.slice(start + 1, end < 0 ? undefined : end)) {
    const item = /^- ([A-Z]+\d+):\s*((?:\[[^\]]*\]\s*)*)/u.exec(line);
    if (item !== null) {
      const tags = [...item[2]!.matchAll(/\[([^\]]*)\]/gu)].map((match) => match[1]!);
      const unknown = tags.find((tag) => !TAGS.includes(tag));
      if (unknown !== undefined) errors.push(`${spec} ${item[1]}: unknown tag [${unknown}]`);
      else if (tags.length > 1) errors.push(`${spec} ${item[1]}: more than one tag (${tags.map((tag) => `[${tag}]`).join(" ")}); use one of [deploy], [measure], [pending]`);
      continue;
    }
    // Near misses the item parser would drop: indent, `*`/`+`, bold, lowercase, space before the colon (N2).
    if (/^\s*[-*+]\s*\**\s*[A-Za-z]+\d+\s*\**\s*:/u.test(line)) errors.push(`${spec}: malformed acceptance bullet: "${line}"`);
  }
  return errors;
}

if (import.meta.main) {
  const specs: { path: string; markdown: string }[] = [];
  for await (const path of new Bun.Glob("docs/specs/*/spec.md").scan({ cwd: root })) {
    if (path.startsWith("docs/specs/_")) continue; // templates
    specs.push({ path, markdown: await Bun.file(join(root, path)).text() });
  }
  const tests: { path: string; source: string }[] = [];
  for (const glob of testGlobs) {
    for await (const path of new Bun.Glob(glob).scan({ cwd: root })) {
      if (path.includes("node_modules")) continue;
      tests.push({ path, source: await Bun.file(join(root, path)).text() });
    }
  }
  const result = await checkTraceability({
    specs: specs.sort((a, b) => (a.path < b.path ? -1 : 1)),
    tests,
    rows: async (casePath) => (await import(join(root, casePath))).testPlanRows,
  });
  for (const line of result.proven) console.log(line);
  for (const line of result.pending) console.log(`${line}: planned slice, not yet tested`);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(relative(root, join(root, error)));
    process.exit(1);
  }
  console.log(`traceability ok: ${result.items} acceptance items, ${result.pending.length} pending`);
}
