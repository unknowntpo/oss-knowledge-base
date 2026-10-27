/**
 * Spec 027 B35 / SRE48: bundles docs/runbooks/sre/*.md and the docs/runbooks/ sections their causes
 * cite into src/playbooks.generated.ts; docs/runbooks/sre/system.md becomes SYSTEM_CONTEXT (SRE99). `--check` writes nothing and fails when a playbook is
 * malformed or the module is out of date.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkPlaybooks, renderPlaybookModule, SYSTEM_FILE, type MarkdownFile } from "../src/playbook";

const repo = join(import.meta.dir, "../../..");
const target = join(import.meta.dir, "../src/playbooks.generated.ts");

function read(dir: string): MarkdownFile[] {
  return [...new Bun.Glob("*.md").scanSync({ cwd: join(repo, dir) })].sort()
    .map((name) => ({ path: `${dir}/${name}`, text: readFileSync(join(repo, dir, name), "utf8") }));
}

const playbooks = read("docs/runbooks/sre");
const runbooks = read("docs/runbooks");
const errors = checkPlaybooks(playbooks, runbooks);
if (!playbooks.some((file) => file.path.endsWith(`/${SYSTEM_FILE}`))) errors.push(`docs/runbooks/sre/${SYSTEM_FILE} is missing`);
const count = playbooks.length - 1;
for (const error of errors) console.error(error);
if (errors.length > 0) process.exit(1);
const rendered = renderPlaybookModule(playbooks, runbooks);
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== rendered) {
    console.error("packages/sre-agent/src/playbooks.generated.ts is out of date; run bun run --cwd packages/sre-agent playbooks");
    process.exit(1);
  }
  console.log(`playbooks ok: ${count} and ${SYSTEM_FILE}`);
} else {
  await Bun.write(target, rendered);
  console.log(`playbooks rendered: ${count} and ${SYSTEM_FILE}`);
}
