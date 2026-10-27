/**
 * B35 invariant playbooks: `docs/runbooks/sre/<rule id>.md` with six sections and an ordered cause
 * list, each cause id → runbook anchors in `docs/runbooks/`. `scripts/playbooks.ts` bundles the
 * files and the runbook sections their causes point to into `playbooks.generated.ts`; its `--check`
 * fails CI when the module is out of date or a playbook is malformed (SRE48). `docs/runbooks/sre/system.md`
 * is not a playbook: it is the system context at the top of the agent's prompt (SRE99), bundled as
 * `SYSTEM_CONTEXT`.
 */

export interface MarkdownFile {
  readonly path: string;
  readonly text: string;
}

export interface PlaybookLibrary {
  /** Rule id → playbook markdown. */
  readonly playbooks: Readonly<Record<string, string>>;
  /** `<file>.md#<anchor>` → that runbook section's markdown. */
  readonly runbooks: Readonly<Record<string, string>>;
}

export interface Cause {
  readonly id: string;
  /** `<file>.md#<anchor>`, relative to `docs/runbooks/`. */
  readonly anchors: readonly string[];
}

export const REQUIRED_SECTIONS = ["Statement", "Why", "Evidence", "Hard check", "Judgment guidance", "Causes"] as const;
export const UNKNOWN_CAUSE = "unknown";

interface Heading { readonly level: number; readonly text: string; readonly line: number }

function headings(markdown: string): Heading[] {
  const result: Heading[] = [];
  let fenced = false;
  markdown.split("\n").forEach((line, index) => {
    if (/^\s*(```|~~~)/u.test(line)) fenced = !fenced;
    const match = fenced ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match !== null) result.push({ level: match[1]!.length, text: match[2]!, line: index });
  });
  return result;
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens, `-n` for repeats. */
export function anchors(markdown: string): Map<string, Heading> {
  const result = new Map<string, Heading>();
  const counts = new Map<string, number>();
  for (const heading of headings(markdown)) {
    const base = heading.text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/gu, "-");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    result.set(count === 0 ? base : `${base}-${count}`, heading);
  }
  return result;
}

/** The text of a heading's section, up to the next heading of the same or a higher level. */
export function section(markdown: string, heading: Heading): string {
  const lines = markdown.split("\n");
  const next = headings(markdown).find((value) => value.line > heading.line && value.level <= heading.level);
  return lines.slice(heading.line, next?.line ?? lines.length).join("\n").trimEnd();
}

/** The cause table of the `Causes` section: a `Cause id` column in backticks and runbook links. */
export function parseCauses(markdown: string): Cause[] {
  const heading = headings(markdown).find((value) => value.level === 2 && value.text.startsWith("Causes"));
  if (heading === undefined) return [];
  const rows = section(markdown, heading).split("\n").filter((line) => line.startsWith("|"));
  const header = rows[0]?.split("|").map((cell) => cell.trim()) ?? [];
  const idColumn = header.indexOf("Cause id");
  const runbookColumn = header.indexOf("Runbook");
  if (idColumn < 0 || runbookColumn < 0) return [];
  return rows.slice(2).map((row) => {
    const cells = row.split("|").map((cell) => cell.trim());
    const id = /^`([a-z0-9-]+)`$/u.exec(cells[idColumn] ?? "")?.[1] ?? "";
    const links = [...(cells[runbookColumn] ?? "").matchAll(/\]\(\.\.\/([\w.-]+\.md#[\w-]+)\)/gu)].map((match) => match[1]!);
    return { id, anchors: links };
  });
}

/** SRE99: the file in `docs/runbooks/sre/` that holds the system context, not a playbook. */
export const SYSTEM_FILE = "system.md";

const isSystemFile = (file: MarkdownFile) => file.path.split("/").pop() === SYSTEM_FILE;

/** SRE48: every problem of every playbook, each naming its file; empty when all pass. */
export function checkPlaybooks(all: readonly MarkdownFile[], runbooks: readonly MarkdownFile[]): string[] {
  const files = all.filter((file) => !isSystemFile(file));
  const known = new Set(runbooks.flatMap((file) => [...anchors(file.text).keys()].map((anchor) => `${file.path.replace(/^docs\/runbooks\//u, "")}#${anchor}`)));
  const errors: string[] = [];
  for (const file of files) {
    const titles = headings(file.text).filter((value) => value.level === 2).map((value) => value.text);
    for (const name of REQUIRED_SECTIONS) {
      if (!titles.some((title) => title === name || title.startsWith(`${name} `) || title.startsWith(`${name},`))) errors.push(`${file.path}: missing section "${name}"`);
    }
    const causes = parseCauses(file.text);
    if (causes.length === 0) errors.push(`${file.path}: no cause table with "Cause id" and "Runbook" columns`);
    for (const cause of causes) {
      if (cause.id === "") errors.push(`${file.path}: a cause has no id in backticks`);
      else if (cause.id !== UNKNOWN_CAUSE && cause.anchors.length === 0) errors.push(`${file.path}: cause ${cause.id} has no runbook anchor`);
      for (const anchor of cause.anchors) {
        if (!known.has(anchor)) errors.push(`${file.path}: anchor ${anchor} is not a heading in docs/runbooks/`);
      }
    }
  }
  return errors;
}

/** The library the bundle reads: each playbook by rule id and every runbook section it cites. */
export function buildLibrary(all: readonly MarkdownFile[], runbooks: readonly MarkdownFile[]): PlaybookLibrary {
  const files = all.filter((file) => !isSystemFile(file));
  const playbooks: Record<string, string> = {};
  const sections: Record<string, string> = {};
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    playbooks[file.path.split("/").pop()!.replace(/\.md$/u, "")] = file.text;
    for (const anchor of parseCauses(file.text).flatMap((cause) => cause.anchors)) {
      const [name, slug] = anchor.split("#") as [string, string];
      const runbook = runbooks.find((value) => value.path === `docs/runbooks/${name}`);
      const heading = runbook === undefined ? undefined : anchors(runbook.text).get(slug);
      if (runbook !== undefined && heading !== undefined) sections[anchor] = section(runbook.text, heading);
    }
  }
  return { playbooks, runbooks: sections };
}

export function renderPlaybookModule(files: readonly MarkdownFile[], runbooks: readonly MarkdownFile[]): string {
  const system = files.find(isSystemFile);
  if (system === undefined) throw new Error(`docs/runbooks/sre/${SYSTEM_FILE} is missing`);
  return [
    "// Generated by `bun run --cwd packages/sre-agent playbooks` from docs/runbooks/sre/*.md and the",
    "// docs/runbooks/ sections their causes cite. Do not edit; `check:playbooks` fails when it is stale.",
    'import type { PlaybookLibrary } from "./playbook";',
    "",
    `/** SRE99: docs/runbooks/sre/${SYSTEM_FILE}, the start of the agent's system prompt. */`,
    `export const SYSTEM_CONTEXT = ${JSON.stringify(system.text.trim())};`,
    "",
    `export const PLAYBOOK_LIBRARY: PlaybookLibrary = ${JSON.stringify(buildLibrary(files, runbooks), null, 2)};`,
    "",
  ].join("\n");
}

/** Causes and runbook anchors a diagnosis may name, from the playbooks of its firing rules. */
export function allowedAnswers(library: PlaybookLibrary, ruleIds: readonly string[]): { causes: Set<string>; runbooks: Set<string>; missing: string[] } {
  const causes = new Set([UNKNOWN_CAUSE]);
  const runbooks = new Set<string>();
  const missing: string[] = [];
  for (const ruleId of ruleIds) {
    const text = library.playbooks[ruleId];
    if (text === undefined) {
      missing.push(ruleId);
      continue;
    }
    for (const cause of parseCauses(text)) {
      causes.add(cause.id);
      for (const anchor of cause.anchors) runbooks.add(anchor);
    }
  }
  return { causes, runbooks, missing };
}
