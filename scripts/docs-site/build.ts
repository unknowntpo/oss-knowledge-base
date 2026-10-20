/**
 * Spec 025 command: builds the documentation site (`bun run docs:build`).
 *
 *   build.ts [--out dist/docs-site] [--repo-dir .] [--repository unknowntpo/oss-knowledge-base]
 *
 * Reads docs/site/<locale>/*.md, docs/site/flows/*.json and apps/web/styles.css from the repository,
 * stamps the HEAD commit, writes the site to --out (replacing it), audits the output and exits 1
 * on any problem. Prints one line per file and the total size (the Budget item reads it).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditSite, buildDocsSite, DocsError, LOCALES, type DocsInput, type Locale } from "./generate";

function args(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    if (!flag.startsWith("--") || value === undefined) throw new Error(`expected --flag value, got ${JSON.stringify(flag)}`);
    out.set(flag.slice(2), value);
  }
  return out;
}

/** Everything `buildDocsSite` needs, read from a checkout. */
export function readRepository(repoDir: string, repository: string): DocsInput {
  const read = (path: string) => readFileSync(join(repoDir, path), "utf8");
  const pages = {} as Record<Locale, Record<string, string>>;
  for (const locale of LOCALES) {
    pages[locale] = {};
    const directory = join(repoDir, "docs/site", locale);
    for (const file of existsSync(directory) ? readdirSync(directory) : []) {
      if (file.endsWith(".md")) pages[locale][file.slice(0, -3)] = read(`docs/site/${locale}/${file}`);
    }
  }
  const flows: Record<string, unknown> = {};
  const flowDir = join(repoDir, "docs/site/flows");
  for (const file of existsSync(flowDir) ? readdirSync(flowDir).sort() : []) {
    if (!file.endsWith(".json")) continue;
    try {
      flows[file.slice(0, -5)] = JSON.parse(read(`docs/site/flows/${file}`));
    } catch (error) {
      throw new DocsError([`docs/site/flows/${file}: not JSON (${(error as Error).message})`]);
    }
  }
  const git = (...command: string[]) => execFileSync("git", ["-C", repoDir, ...command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const [sha, date] = git("log", "-1", "--format=%H%x09%cI").split("\t") as [string, string];
  const root = resolve(repoDir);
  const specs = readdirSync(join(repoDir, "docs/specs")).filter((name) => /^\d{3}-/u.test(name));
  const enforced = specs.filter((name) => {
    const path = join(repoDir, "docs/specs", name, "spec.md");
    return existsSync(path) && /^Traceability:\s*enforced\s*$/mu.test(readFileSync(path, "utf8"));
  });
  return {
    repository,
    commit: { sha, date: new Date(date).toISOString() },
    pages,
    flows,
    stylesCss: read("apps/web/styles.css"),
    exists: (path) => {
      const full = resolve(root, path);
      if (relative(root, full).startsWith("..") || !existsSync(full)) return null;
      return statSync(full).isDirectory() ? "dir" : "file";
    },
    values: { specs: String(specs.length), enforcedSpecs: String(enforced.length) },
  };
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === self) {
  const options = args(process.argv.slice(2));
  const repoDir = resolve(options.get("repo-dir") ?? join(dirname(self), "../.."));
  const out = resolve(options.get("out") ?? join(repoDir, "dist/docs-site"));
  const started = performance.now();
  try {
    const files = buildDocsSite(readRepository(repoDir, options.get("repository") ?? "unknowntpo/oss-knowledge-base"));
    const problems = auditSite(files);
    if (problems.length > 0) throw new DocsError(problems);
    rmSync(out, { recursive: true, force: true });
    let total = 0;
    for (const [path, content] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      mkdirSync(dirname(join(out, path)), { recursive: true });
      writeFileSync(join(out, path), content);
      const bytes = Buffer.byteLength(content);
      total += bytes;
      console.log(`${path} ${bytes} bytes`);
    }
    console.log(`${files.size} files, ${total} bytes → ${relative(process.cwd(), out) || "."} in ${Math.round(performance.now() - started)} ms`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
