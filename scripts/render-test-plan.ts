/**
 * Renders each spec's test-plan table from the case file named in its marker, so the table a
 * human reviews is the data the tests run (docs/process/workflow.md). `--check` fails instead
 * of writing when a table is out of date.
 *
 *   <!-- test-plan:start apps/web/test/freshness.cases.ts -->
 *   …generated table…
 *   <!-- test-plan:end -->
 *
 * A marker may end with ` [pending]` (`<!-- test-plan:start <case file> [pending] -->`) for a case
 * file of a planned later slice; it is rendered the same way (see check-spec-traceability.ts).
 */
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const block = /(<!-- test-plan:start (\S+)(?: \[pending\])? -->\n)[\s\S]*?(<!-- test-plan:end -->)/gu;

type Cell = string | number | boolean | null;

export function renderTable(rows: readonly Readonly<Record<string, Cell>>[]): string {
  if (rows.length === 0) throw new Error("A test plan needs at least one row");
  const columns = Object.keys(rows[0]!);
  const cell = (value: Cell) => value === null ? "—" : typeof value === "boolean" ? (value ? "yes" : "no")
    : String(value).replaceAll("|", "\\|");
  return [
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${columns.map((column) => cell(row[column] ?? null)).join(" | ")} |`),
  ].join("\n") + "\n";
}

export async function renderSpec(
  markdown: string,
  loadRows: (casePath: string) => Promise<readonly Readonly<Record<string, Cell>>[]>,
): Promise<string> {
  // A marker the block pattern does not match would be skipped silently (verifier F2).
  for (const line of markdown.split("\n")) {
    if (line.includes("test-plan:start") && !/^<!-- test-plan:start \S+( \[pending\])? -->$/u.test(line)) {
      throw new Error(`malformed test-plan marker: ${JSON.stringify(line)}`);
    }
  }
  let rendered = markdown;
  for (const match of markdown.matchAll(block)) {
    const table = renderTable(await loadRows(match[2]!));
    rendered = rendered.replace(match[0], `${match[1]}${table}${match[3]}`);
  }
  return rendered;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const stale: string[] = [];
  for await (const path of new Bun.Glob("docs/specs/*/spec.md").scan({ cwd: root })) {
    const file = Bun.file(join(root, path));
    const markdown = await file.text();
    const rendered = await renderSpec(markdown, async (casePath) =>
      (await import(join(root, casePath))).testPlanRows);
    if (rendered === markdown) continue;
    if (check) stale.push(path);
    else await Bun.write(file, rendered);
  }
  if (stale.length > 0) {
    for (const path of stale) console.error(`${path}: test-plan table differs from its case file; run bun run docs:test-plan`);
    process.exit(1);
  }
  console.log(check ? "test plans ok" : "test plans rendered");
}
