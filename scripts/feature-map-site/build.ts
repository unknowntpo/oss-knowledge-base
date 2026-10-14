/**
 * Spec 020 command: builds the feature-map site (`bun run docs:feature-map-site -- --out <dir>`).
 *
 *   build.ts --out <dir> [--repo-dir .] [--repository owner/name] [--default-branch main]
 *            [--built-at <ISO time>] [--preview <name>]
 *       Every ref of the repository: the default branch, `release/*` branches and `v*` tags, each read
 *       from git (no checkout). `--preview <name>` adds the working tree as one more branch (pull
 *       request builds).
 *
 *   build.ts --out <dir> --tree <dir> --ref <name> --kind branch|tag --sha <sha> --date <ISO time> […]
 *       One ref from a directory (a checkout, or `git archive | tar -x`); it becomes the site's default.
 *
 *   build.ts pages-gate --status <HTTP status> --body <file> [--eligible true|false]
 *       The deploy gate of .github/workflows/feature-map-site.yml (see `pagesDecision`).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildSite, directoryTree, git, gitTree, pagesDecision, type RefInput, type RefKind } from "./site";

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index]!, argv[index + 1]];
    if (!flag.startsWith("--") || value === undefined) throw new UsageError(`expected --flag value, got ${JSON.stringify(flag)}`);
    args.set(flag.slice(2), value);
  }
  return args;
}

const required = (args: Map<string, string>, name: string) => {
  const value = args.get(name);
  if (value === undefined || value === "") throw new UsageError(`--${name} is required`);
  return value;
};

function isoTime(value: string, flag: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw new UsageError(`--${flag} is not a time: ${JSON.stringify(value)}`);
  return time.toISOString();
}

/** `owner/name` of the `origin` remote, for links to GitHub. */
function repositoryOf(repo: string): string {
  try {
    const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/u.exec(git(repo, "remote", "get-url", "origin"));
    if (match !== null) return match[1]!;
  } catch { /* no origin */ }
  throw new UsageError("--repository owner/name is required (no GitHub origin remote)");
}

/** The default branch, `release/*` branches and `v*` tags: remote-tracking refs after a fetch, else local branches. */
function discoverRefs(repo: string, defaultBranch: string): RefInput[] {
  const names = (pattern: string) => git(repo, "for-each-ref", "--format=%(refname)", pattern).split("\n").filter((name) => name !== "");
  const remote = names(`refs/remotes/origin/${defaultBranch}`).length > 0;
  const heads = remote ? "refs/remotes/origin/" : "refs/heads/";
  const found: { name: string; kind: RefKind; refname: string }[] = [
    ...names(`${heads}${defaultBranch}`).map((refname) => ({ name: defaultBranch, kind: "branch" as const, refname })),
    ...names(`${heads}release/`).map((refname) => ({ name: refname.slice(heads.length), kind: "branch" as const, refname })),
    ...names("refs/tags/v*").map((refname) => ({ name: refname.slice("refs/tags/".length), kind: "tag" as const, refname })),
  ];
  return found.map(({ name, kind, refname }) => ({ name, kind, ...commitOf(repo, refname), tree: gitTree(repo, refname) }));
}

function commitOf(repo: string, revision: string): { sha: string; date: string } {
  const [sha, date] = git(repo, "log", "-1", "--format=%H%x09%cI", `${revision}^{commit}`).trim().split("\t");
  return { sha: sha!, date: new Date(date!).toISOString() };
}

function build(args: Map<string, string>): void {
  const started = performance.now();
  const out = resolve(required(args, "out"));
  const builtAt = isoTime(args.get("built-at") ?? new Date().toISOString(), "built-at");
  let input: Parameters<typeof buildSite>[0];
  const treeDir = args.get("tree");
  if (treeDir !== undefined) {
    const kind = required(args, "kind");
    if (kind !== "branch" && kind !== "tag") throw new UsageError("--kind is branch or tag");
    const name = required(args, "ref");
    input = {
      repository: required(args, "repository"), defaultBranch: name, builtAt, generatorSha: args.get("generator-sha") ?? null,
      // A lone ref is the site's default whatever its kind.
      refs: [{ name, kind, sha: required(args, "sha"), date: isoTime(required(args, "date"), "date"), tree: directoryTree(resolve(treeDir)) }],
    };
  } else {
    const repo = resolve(args.get("repo-dir") ?? ".");
    const defaultBranch = args.get("default-branch") ?? "main";
    const refs = discoverRefs(repo, defaultBranch);
    const preview = args.get("preview");
    if (preview !== undefined && preview !== "" && !refs.some((ref) => ref.name === preview)) {
      refs.push({ name: preview, kind: "branch", ...commitOf(repo, "HEAD"), tree: directoryTree(repo) });
    }
    input = { repository: args.get("repository") ?? repositoryOf(repo), defaultBranch, builtAt, generatorSha: commitOf(repo, "HEAD").sha, refs };
  }
  const site = buildSite(input);
  for (const [path, content] of site.files) {
    const file = join(out, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  for (const ref of site.versions.refs) {
    const bytes = Buffer.byteLength(site.files.get(`${ref.slug}/index.html`)!);
    console.log(`${ref.slug}/ ${ref.name} ${ref.status} ${ref.sha.slice(0, 7)} ${bytes} bytes${ref.reason === undefined ? "" : ` (${ref.reason})`}`);
  }
  console.log(`${site.versions.refs.length} refs, ${site.files.size} files → ${out} in ${Math.round(performance.now() - started)} ms`);
}

function pagesGate(args: Map<string, string>): void {
  const httpStatus = Number(required(args, "status"));
  let buildType: string | null = null;
  const body = args.get("body");
  if (body !== undefined && existsSync(body)) {
    try {
      const value = (JSON.parse(readFileSync(body, "utf8")) as { build_type?: unknown }).build_type;
      if (typeof value === "string") buildType = value;
    } catch { /* not JSON: the status decides */ }
  }
  const eligible = args.get("eligible") !== "false";
  const decision = pagesDecision({ httpStatus, buildType });
  if (process.env.GITHUB_OUTPUT !== undefined) appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${decision.deploy}\n`);
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**Feature map site:** ${decision.message}\n`);
  if (decision.deploy) console.log(decision.message);
  else console.log(`::${eligible ? "error" : "warning"} title=Feature map site not published::${decision.message}`);
  // A run that should have published fails; a pull request build only reports what a publish would meet.
  if (!decision.deploy && eligible) process.exit(1);
}

try {
  const argv = process.argv.slice(2);
  if (argv[0] === "pages-gate") pagesGate(parseArgs(argv.slice(1)));
  else build(parseArgs(argv));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(`feature-map-site: ${error.message}`);
  process.exit(2);
}
