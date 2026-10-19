/**
 * Spec 020: the multi-ref site. Every ref is built by this one generator into `/<slug>/`, and the
 * root gets `versions.json` and a page that goes to the default branch. Pure: `buildSite` returns
 * the files; build.ts writes them.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildData, formatTime, PAGES_WORKFLOW, renderErrorPage, renderPage, SPECS, type ProductionRef, type RefKind, type RefMeta, type TreeReader } from "./generate";
import { escapeHtml } from "./markdown";

export { switcherScript } from "./switcher";
export type { RefKind, RefMeta, TreeReader } from "./generate";

/** Root files a ref's directory must not shadow. */
const RESERVED = new Set(["index.html", "versions.json", "404.html"]);

/** The directory a ref is published in: lower case, `a-z 0-9 . _ -` only, never empty, never a path. */
export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/-{2,}/gu, "-").replace(/\.{2,}/gu, ".")
    .replace(/^[-._]+|[-.]+$/gu, "");
  if (slug === "") return "ref";
  return RESERVED.has(slug) ? `${slug}-ref` : slug;
}

/** One slug per ref, in the given order; a later ref that would repeat a slug gets its kind, then a number. */
export function assignSlugs(refs: readonly { readonly name: string; readonly kind: RefKind }[]): string[] {
  const taken = new Set<string>();
  return refs.map((ref) => {
    const base = slugify(ref.name);
    let slug = base;
    for (let attempt = 1; taken.has(slug); attempt += 1) slug = attempt === 1 ? `${base}-${ref.kind}` : `${base}-${ref.kind}-${attempt}`;
    taken.add(slug);
    return slug;
  });
}

/** Newest first: digit runs compare as numbers, so v0.10.0 precedes v0.2.0. */
function newestFirst(left: string, right: string): number {
  const parts = (value: string) => value.match(/\d+|\D+/gu) ?? [];
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const [x, y] = [a[index], b[index]];
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    if (x === y) continue;
    const numeric = /^\d/u.test(x) && /^\d/u.test(y);
    if (numeric && Number(x) !== Number(y)) return Number(y) - Number(x);
    return x < y ? 1 : -1;
  }
  return 0;
}

export interface RefInput {
  readonly name: string;
  readonly kind: RefKind;
  readonly sha: string;
  readonly date: string;
  readonly tree: TreeReader;
}

export interface VersionEntry extends RefMeta {
  readonly status: "ok" | "no-feature-map" | "error";
  /** Why the status is not `ok`. */
  readonly reason?: string;
}

export interface Versions {
  readonly schema: "feature-map-site.versions.v1";
  readonly repository: string;
  /** When the site was built: the one value that is not derived from a tree. */
  readonly builtAt: string;
  /** Commit of the generator that built every ref, when known. */
  readonly generatorSha: string | null;
  /** Slug the root page goes to. */
  readonly default: string;
  readonly refs: readonly VersionEntry[];
}

export interface SiteInput {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly builtAt: string;
  readonly generatorSha: string | null;
  readonly refs: readonly RefInput[];
}

export function buildSite(input: SiteInput): { readonly files: Map<string, string>; readonly versions: Versions } {
  if (input.refs.length === 0) throw new Error("no ref to build");
  // The default ref first (a branch before a tag of the same name), then branches, then tags.
  const rank = (ref: RefInput) => ref.name === input.defaultBranch ? (ref.kind === "branch" ? 0 : 0.5) : ref.kind === "branch" ? 1 : 2;
  const ordered = [...input.refs].sort((left, right) => rank(left) - rank(right) || newestFirst(left.name, right.name));
  if (rank(ordered[0]!) >= 1) throw new Error(`the default branch "${input.defaultBranch}" is not among the refs`);
  const slugs = assignSlugs(ordered);
  const defaultSlug = slugs[0]!;
  const files = new Map<string, string>();
  const entries: VersionEntry[] = [];
  const production = productionRef(input.repository, ordered, slugs);
  ordered.forEach((ref, index) => {
    const meta: RefMeta = { name: ref.name, slug: slugs[index]!, kind: ref.kind, sha: ref.sha, date: ref.date };
    try {
      const data = buildData({ repository: input.repository, ref: meta, tree: ref.tree, production });
      // The default page is what readers see: it may not claim more than the evidence (B27).
      if (index === 0 && data.runsOnErrors.length > 0) throw new Error(data.runsOnErrors.join("; "));
      const page = renderPage(data, { defaultSlug });
      files.set(`${meta.slug}/index.html`, page);
      files.set(`${meta.slug}/data.json`, `${JSON.stringify(data, null, 2)}\n`);
      entries.push(data.status === "ok" ? { ...meta, status: "ok" } : { ...meta, status: data.status, reason: data.notes[0] ?? "" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A broken default page must not be published as if it were the product's state.
      if (index === 0) throw new Error(`${ref.name}: ${reason}`);
      files.set(`${meta.slug}/index.html`, renderErrorPage({ repository: input.repository, ref: meta, defaultSlug, reason }));
      entries.push({ ...meta, status: "error", reason });
    }
  });
  const versions: Versions = {
    schema: "feature-map-site.versions.v1",
    repository: input.repository,
    builtAt: input.builtAt,
    generatorSha: input.generatorSha,
    default: defaultSlug,
    refs: entries,
  };
  files.set("versions.json", `${JSON.stringify(versions, null, 2)}\n`);
  files.set("index.html", renderRoot(versions));
  return { files, versions };
}

/**
 * The ref Prod runs (Spec 020 B20): the newest `v*` tag whose page can be generated. Every page's
 * status board compares its specs with this one ref, so all pages agree on what Prod has.
 */
function productionRef(repository: string, ordered: readonly RefInput[], slugs: readonly string[]): ProductionRef | null {
  for (const [index, ref] of ordered.entries()) {
    if (ref.kind !== "tag" || !/^v\d/u.test(ref.name)) continue;
    try {
      buildData({ repository, ref: { name: ref.name, slug: slugs[index]!, kind: ref.kind, sha: ref.sha, date: ref.date }, tree: ref.tree });
      return { name: ref.name, sha: ref.sha, date: ref.date, specDirectories: [...ref.tree.list(SPECS)] };
    } catch { /* an unreadable tag is not what Prod runs; B10 gives it an error page */ }
  }
  return null;
}

/** The root page: goes to the default ref at once, and lists every ref for a reader whose browser does not. */
function renderRoot(versions: Versions): string {
  const target = `${versions.default}/`;
  const items = versions.refs.map((ref) =>
    `<li><a href="${ref.slug}/">${escapeHtml(ref.name)}</a> ${ref.kind === "tag" ? "標籤" : "分支"} · ${escapeHtml(ref.sha.slice(0, 7))} · ${escapeHtml(formatTime(ref.date))}</li>`).join("\n");
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url=${target}">
<title>功能地圖 · ${escapeHtml(versions.repository)}</title>
</head>
<body>
<p>前往 <a href="${target}">${escapeHtml(versions.refs[0]!.name)} 的功能地圖</a>。</p>
<ul>
${items}
</ul>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------------------------
// Trees

/** A checked-out tree (or an extracted archive) on disk. */
export function directoryTree(root: string): TreeReader {
  return {
    read(path) {
      const file = join(root, path);
      return existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : null;
    },
    list(directory) {
      const target = join(root, directory);
      return existsSync(target) && statSync(target).isDirectory() ? readdirSync(target).sort() : [];
    },
  };
}

export const git = (repo: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/** The `docs/` files of a revision and the feature-map-site workflow (B27), read from the object store: no checkout, no worktree. */
export function gitTree(repo: string, revision: string): TreeReader {
  let paths: Set<string> | undefined;
  const all = () => paths ??= new Set(git(repo, "ls-tree", "-r", "-z", "--name-only", revision, "--", "docs", PAGES_WORKFLOW).split("\0").filter((path) => path !== ""));
  return {
    read: (path) => all().has(path) ? git(repo, "show", `${revision}:${path}`) : null,
    list(directory) {
      const prefix = `${directory.replace(/\/+$/u, "")}/`;
      return [...new Set([...all()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split("/")[0]!))].sort();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Deploy gate

const PAGES_SETTING = "Settings → Pages → Build and deployment → Source: GitHub Actions";

/** Whether the repository's Pages site accepts a deployment from a workflow, from `GET /repos/{repo}/pages`. */
export function pagesDecision(input: { readonly httpStatus: number; readonly buildType: string | null }): { readonly deploy: boolean; readonly message: string } {
  if (input.httpStatus === 200 && input.buildType === "workflow") return { deploy: true, message: "GitHub Pages is enabled with source GitHub Actions." };
  const unpublished = "The site was built and uploaded as a workflow artifact; nothing was published.";
  if (input.httpStatus === 404) return { deploy: false, message: `GitHub Pages is not enabled for this repository. Enable it once: ${PAGES_SETTING}. ${unpublished}` };
  if (input.httpStatus === 200) return { deploy: false, message: `GitHub Pages is enabled with source "${input.buildType ?? "unknown"}", which a workflow cannot deploy to. Change it: ${PAGES_SETTING}. ${unpublished}` };
  return { deploy: false, message: `Could not read the repository's Pages settings (HTTP ${input.httpStatus}); the job needs \`pages: read\`. ${unpublished}` };
}
