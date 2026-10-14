import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildData, renderPage } from "../feature-map-site/generate";
import { parseMarkdown, renderInline, splitRow } from "../feature-map-site/markdown";
import {
  assignSlugs, buildSite, directoryTree, gitTree, pagesDecision, slugify, switcherScript,
  type RefInput, type TreeReader,
} from "../feature-map-site/site";
import { testPlanRows } from "./feature-map-site.cases";

/** Spec 020: the feature-map site generator. Every test name carries the acceptance ID it proves. */
const root = join(import.meta.dir, "..", "..");
const fixture = join(import.meta.dir, "fixtures", "feature-map-site");
const tree = directoryTree(join(fixture, "tree"));
const repository = "example/repo";
const sha = "0123456789abcdef0123456789abcdef01234567";
const ref = { name: "main", slug: "main", kind: "branch", sha, date: "2026-10-13T06:22:09.000Z" } as const;
const data = buildData({ repository, ref, tree });
const page = renderPage(data, { defaultSlug: "main" });

const input = (refs: readonly RefInput[]) =>
  ({ repository, defaultBranch: "main", builtAt: "2026-10-14T01:02:03.000Z", generatorSha: sha, refs });
const refInput = (name: string, kind: "branch" | "tag", reader: TreeReader = tree): RefInput =>
  ({ name, kind, sha, date: ref.date, tree: reader });
const without = (reader: TreeReader, ...paths: string[]): TreeReader => ({
  read: (path) => paths.includes(path) ? null : reader.read(path),
  list: (dir) => reader.list(dir),
});

describe("feature-map site: parser", () => {
  test("B1: the fixture feature map becomes the Deployed configuration and Schedules tables", () => {
    expect(data.schema).toBe("feature-map-site.data.v1");
    expect(data.status).toBe("ok");
    expect(data.ref).toEqual(ref);
    expect(data.deployedConfiguration).toEqual({
      headers: ["Name", "Where", "Dev", "Prod", "What it does"],
      rows: [
        ["`MODE`", "Worker var", "`development`", "`production`", "Names the environment"],
        ["`FLAG_A`, `FLAG_B`", "Worker vars", "`on|off`", "unset", "Status `ok|failed`; see [Spec 002](specs/002-beta/spec.md)"],
      ],
    });
    expect(data.schedules?.headers).toEqual(["What", "Cadence", "Turned on by"]);
    expect(data.schedules?.rows.map((row) => row[0])).toEqual(["Publisher", "Digest"]);
    expect(data.featureMap?.title).toBe("Feature map");
    expect(data.featureMap?.sections.map((section) => `${section.level} ${section.title}`)).toEqual([
      "1 Feature map", "2 Environments", "3 Deployed configuration", "2 Schedules", "2 Acceptance IDs by spec", "2 Verification kit",
    ]);
  });

  test("B1: every spec has its number, title, status and the acceptance IDs of its feature-map row", () => {
    expect(data.specs).toEqual([
      {
        number: "001", directory: "001-alpha", path: "docs/specs/001-alpha/spec.md", title: "Alpha Thread",
        status: "Draft for implementation", statusKind: "draft", acceptanceIds: "A1–A3", surface: "Domain",
      },
      {
        number: "002", directory: "002-beta", path: "docs/specs/002-beta/spec.md", title: "Beta `search`",
        status: "Implemented (PR #7, merged 2026-09-30)", statusKind: "implemented", acceptanceIds: "B1–B12 (B4 measure)", surface: "`/api/x`",
      },
    ]);
    expect(data.counts.specsByStatus).toEqual({ draft: 1, accepted: 0, implemented: 1, other: 0 });
  });

  test("B1: every open gardening item has its ID, title, category, layer and fields", () => {
    expect(data.gardening?.lastFullPass).toBe("2026-10-06 (`main` 6cfbfc6).");
    expect(data.gardening?.items.map((item) => [item.id, item.category, item.layer])).toEqual([
      ["G1", "Web UI", "test"],
      ["G11", "Process and docs", "static check"],
    ]);
    const g1 = data.gardening!.items[0]!;
    expect(g1.title).toBe("`<html lang>` is not set on first load");
    expect(g1.fields.map((field) => field.label)).toEqual(["Where", "Why", "Fix", "Layer", "Source"]);
    expect(g1.fields[0]!.text).toBe("`apps/web/index.html`; a page that starts in English keeps `lang=\"zh-Hant\"`.");
    expect(data.counts).toMatchObject({ specs: 2, gardeningItems: 2, schedules: 2, deployedNames: 2 });
  });

  test("B7: a table row splits on unescaped pipes only and is padded or cut to the header width", () => {
    expect(splitRow("| `a\\|b` | c |")).toEqual(["`a|b`", "c"]);
    expect(splitRow("a | b")).toEqual(["a", "b"]);
    const other = parseMarkdown(readFileSync(join(fixture, "other-shape/docs/feature-map.md"), "utf8"));
    const table = other.find((section) => section.title === "Routes")!.blocks[0]!;
    expect(table).toEqual({
      type: "table", headers: ["Route", "Component"],
      rows: [["`/`", "Home"], ["`/kip/:id`", "Detail"], ["short", ""]],
    });
  });

  test("B7: lists keep nesting and continuation lines; a fenced block keeps its text", () => {
    const blocks = data.featureMap!.sections.find((section) => section.title === "Deployed configuration")!.blocks;
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "table", "paragraph", "list", "code"]);
    expect(blocks[3]).toEqual({
      type: "list",
      items: [
        { depth: 0, ordered: false, text: "Tokens go only to Dev and never elsewhere." },
        { depth: 1, ordered: false, text: "nested point with `code`" },
      ],
    });
    expect(blocks[4]).toEqual({ type: "code", lang: "sh", text: "curl https://dev.example.test/health | jq '.a | .b'" });
  });

  test("B7: inline text is escaped; code, bold and links render; only http, https and mailto links are kept", () => {
    const resolve = (url: string) => url.startsWith("x:") ? null : `R(${url})`;
    expect(renderInline("a <b> & `<i>` **bold `c`**", resolve)).toBe("a &lt;b&gt; &amp; <code>&lt;i&gt;</code> <strong>bold <code>c</code></strong>");
    expect(renderInline("[`f.md`](../f.md) and [bad](x:1)", resolve)).toBe('<a href="R(../f.md)"><code>f.md</code></a> and bad');
    expect(renderInline("see https://a.test/x?y=1, then", resolve)).toBe('see <a href="R(https://a.test/x?y=1)">https://a.test/x?y=1</a>, then');
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).toContain("Never bad link.");
    expect(page).not.toContain("javascript:");
  });
});

describe("feature-map site: page", () => {
  test("B2: the page names the ref, its kind, the commit and the commit time, in Traditional Chinese", () => {
    expect(page.startsWith("<!doctype html>\n<html lang=\"zh-Hant\"")).toBe(true);
    expect(page).toContain(`data-ref="main"`);
    expect(page).toContain(`data-sha="${sha}"`);
    const stamp = /<p class="stamp"[^>]*>([\s\S]*?)<\/p>/u.exec(page)![1]!;
    expect(stamp).toContain("<code>main</code>");
    expect(stamp).toContain("分支");
    expect(stamp).toContain(`<a href="https://github.com/example/repo/commit/${sha}"><code>0123456</code></a>`);
    expect(stamp).toContain("2026-10-13 06:22 UTC");
    for (const label of ["功能地圖", "部署設定", "排程", "待處理事項", "規格"]) expect(page).toContain(label);
    for (const identifier of ["MODE", "FLAG_A", "7 22 * * *", "G11", "Alpha Thread", "A1–A3"]) expect(page).toContain(identifier);
  });

  test("B2: the page loads nothing from another origin and needs no script to show its content", () => {
    expect(page).not.toMatch(/<link\b/u);
    expect(page).not.toMatch(/<(script|img|iframe|video|audio|source|object|embed)\b[^>]*\bsrc=/u);
    expect(page).not.toMatch(/@import|url\(/u);
    expect([...page.matchAll(/<script\b/gu)].length).toBe(1);
    // The only request the script makes is the sibling versions.json.
    expect([...switcherScript.matchAll(/fetch\(([^,)]*)/gu)].map((match) => match[1])).toEqual(['"../versions.json"']);
    const body = page.replace(/<script>[\s\S]*<\/script>/u, "");
    expect(body).toContain("Names the environment");
    expect(body).toContain(`<option value="main" selected>main</option>`);
  });

  test("B2: a relative link opens the file on GitHub at the page's commit", () => {
    expect(page).toContain(`<a href="https://github.com/example/repo/blob/${sha}/docs/specs/002-beta/spec.md">Spec 002</a>`);
    expect(page).toContain(`<a href="https://github.com/example/repo/blob/${sha}/docs/feature-map.md#verification-kit">Verification kit</a>`);
    expect(page).toContain(`<a href="https://github.com/example/repo/blob/${sha}/docs/process/workflow.md">workflow</a>`);
    expect(page).toContain(`<a href="https://github.com/example/repo/pull/26">PR #26</a>`);
  });

  test("B2: a page of another ref than the default says so and links to the default", () => {
    const tagRef = { ...ref, name: "v0.2.0", slug: "v0.2.0", kind: "tag" } as const;
    const tagPage = renderPage(buildData({ repository, ref: tagRef, tree }), { defaultSlug: "main" });
    expect(tagPage).toContain("標籤");
    expect(tagPage).toContain('<a href="../main/">');
    expect(page).not.toContain('<a href="../main/">');
  });

  test("B3: the same tree and metadata give byte-identical files", () => {
    const first = buildSite(input([refInput("main", "branch"), refInput("v0.1.0", "tag")]));
    const second = buildSite(input([refInput("v0.1.0", "tag"), refInput("main", "branch")]));
    expect([...second.files.keys()]).toEqual([...first.files.keys()]);
    for (const [path, content] of first.files) expect(second.files.get(path)).toBe(content);
    // Positive control: other metadata gives another page.
    const moved = buildSite(input([{ ...refInput("main", "branch"), sha: "f".repeat(40) }, refInput("v0.1.0", "tag")]));
    expect(moved.files.get("main/index.html")).not.toBe(first.files.get("main/index.html"));
    expect(moved.files.get("v0.1.0/index.html")).toBe(first.files.get("v0.1.0/index.html")!);
  });
});

describe("feature-map site: slugs and layout", () => {
  test.each(testPlanRows)("$id: ref $ref is published as $slug", ({ ref: name, slug }) => {
    expect(slugify(name)).toBe(slug);
    expect(slug).toMatch(/^[a-z0-9][a-z0-9._-]*$/u);
  });

  test("B5: the site is /<slug>/index.html and data.json per ref, versions.json, and a root page that goes to the default", () => {
    const site = buildSite(input([refInput("v0.1.0", "tag"), refInput("release/1.0", "branch"), refInput("main", "branch"), refInput("v0.10.0", "tag"), refInput("v0.2.0", "tag")]));
    expect([...site.files.keys()].sort()).toEqual([
      "index.html", "main/data.json", "main/index.html", "release-1.0/data.json", "release-1.0/index.html",
      "v0.1.0/data.json", "v0.1.0/index.html", "v0.10.0/data.json", "v0.10.0/index.html", "v0.2.0/data.json", "v0.2.0/index.html",
      "versions.json",
    ]);
    const versions = JSON.parse(site.files.get("versions.json")!);
    expect(versions).toEqual(site.versions);
    expect(versions).toEqual({
      schema: "feature-map-site.versions.v1",
      repository,
      builtAt: "2026-10-14T01:02:03.000Z",
      generatorSha: sha,
      default: "main",
      refs: [
        { name: "main", slug: "main", kind: "branch", sha, date: ref.date, status: "ok" },
        { name: "release/1.0", slug: "release-1.0", kind: "branch", sha, date: ref.date, status: "ok" },
        { name: "v0.10.0", slug: "v0.10.0", kind: "tag", sha, date: ref.date, status: "ok" },
        { name: "v0.2.0", slug: "v0.2.0", kind: "tag", sha, date: ref.date, status: "ok" },
        { name: "v0.1.0", slug: "v0.1.0", kind: "tag", sha, date: ref.date, status: "ok" },
      ],
    });
    const rootPage = site.files.get("index.html")!;
    expect(rootPage).toContain('<meta http-equiv="refresh" content="0; url=main/">');
    for (const slug of ["main", "release-1.0", "v0.2.0"]) expect(rootPage).toContain(`<a href="${slug}/">`);
    expect(JSON.parse(site.files.get("release-1.0/data.json")!).ref).toMatchObject({ name: "release/1.0", slug: "release-1.0", kind: "branch" });
    expect(site.files.get("main/data.json")).toBe(`${JSON.stringify(buildData({ repository, ref, tree }), null, 2)}\n`);
  });

  test("B12: refs whose names give the same slug are published under distinct slugs", () => {
    expect(assignSlugs([
      { name: "main", kind: "branch" }, { name: "release/1.0", kind: "branch" }, { name: "release-1.0", kind: "tag" },
      { name: "Release-1.0", kind: "tag" },
    ])).toEqual(["main", "release-1.0", "release-1.0-tag", "release-1.0-tag-2"]);
  });
});

describe("feature-map site: failure", () => {
  test("B8: a tree without docs/feature-map.md gets a page that says so, with its specs, and the site still builds", () => {
    const old = without(tree, "docs/feature-map.md", "docs/gardening.md");
    const site = buildSite(input([refInput("main", "branch"), refInput("v0.1.0", "tag", old)]));
    const entry = site.versions.refs.find((item) => item.name === "v0.1.0")!;
    expect(entry).toMatchObject({ status: "no-feature-map", reason: "docs/feature-map.md is not in this tree" });
    const oldPage = site.files.get("v0.1.0/index.html")!;
    expect(oldPage).toContain("此版本沒有 feature map");
    expect(oldPage).toContain("Alpha Thread");
    expect(oldPage).toContain("此版本沒有 <code>docs/gardening.md</code>");
    const oldData = JSON.parse(site.files.get("v0.1.0/data.json")!);
    expect(oldData).toMatchObject({ status: "no-feature-map", featureMap: null, deployedConfiguration: null, schedules: null, gardening: null });
    expect(oldData.specs.map((spec: { number: string; acceptanceIds: string | null }) => [spec.number, spec.acceptanceIds])).toEqual([["001", null], ["002", null]]);
    expect(oldData.notes).toEqual(["docs/feature-map.md is not in this tree", "docs/gardening.md is not in this tree"]);
  });

  test("B9: a feature map of another shape is rendered section by section, with the missing tables recorded", () => {
    const other = directoryTree(join(fixture, "other-shape"));
    const shaped = buildData({ repository, ref, tree: other });
    expect(shaped.status).toBe("ok");
    expect(shaped.deployedConfiguration).toBeNull();
    expect(shaped.schedules).toBeNull();
    expect(shaped.specs).toEqual([]);
    expect(shaped.notes).toEqual([
      'docs/feature-map.md has no "Deployed configuration" table',
      'docs/feature-map.md has no "Schedules" table',
      "docs/gardening.md is not in this tree",
      "docs/specs has no spec",
    ]);
    const shapedPage = renderPage(shaped, { defaultSlug: "main" });
    expect(shapedPage).toContain("Routes of the old application, without a title heading.");
    expect(shapedPage).toContain("<code>/kip/:id</code>");
    expect(shapedPage).toContain("此版本的 feature map 沒有「Deployed configuration」表格");
  });

  test("B10: a ref that cannot be generated gets a page with the reason and the other refs are still built", () => {
    const broken: TreeReader = { read: () => { throw new Error("object <x> is corrupt"); }, list: () => [] };
    const site = buildSite(input([refInput("main", "branch"), refInput("v0.3.0", "tag", broken)]));
    expect(site.versions.refs.map((item) => [item.name, item.status])).toEqual([["main", "ok"], ["v0.3.0", "error"]]);
    expect(site.versions.refs[1]!.reason).toBe("object <x> is corrupt");
    expect(site.files.get("v0.3.0/index.html")).toContain("此版本無法產生");
    expect(site.files.get("v0.3.0/index.html")).toContain("object &lt;x&gt; is corrupt");
    expect(site.files.has("v0.3.0/data.json")).toBe(false);
    expect(site.files.get("main/index.html")).toBe(buildSite(input([refInput("main", "branch")])).files.get("main/index.html")!);
  });

  test("B10: the default ref failing, or no ref at all, fails the build", () => {
    const broken: TreeReader = { read: () => { throw new Error("boom"); }, list: () => [] };
    expect(() => buildSite(input([refInput("main", "branch", broken), refInput("v0.1.0", "tag")]))).toThrow("main: boom");
    expect(() => buildSite(input([]))).toThrow("no ref to build");
    expect(() => buildSite(input([refInput("v0.1.0", "tag")]))).toThrow('the default branch "main" is not among the refs');
  });
});

/** Runs the page's script against a fake document; returns what the reader would see. */
async function runSwitcher(fetchImpl: () => Promise<unknown>) {
  interface Fake { tag: string; children: Fake[]; [key: string]: unknown }
  const element = (tag: string): Fake => {
    const self: Fake = {
      tag, children: [],
      appendChild(child: Fake) { self.children.push(child); },
      replaceChildren(...children: Fake[]) { self.children = children; },
    };
    return self;
  };
  const handlers: Record<string, () => void> = {};
  const select = Object.assign(element("select"), {
    value: "main",
    getAttribute: (name: string) => name === "data-current" ? "main" : null,
    addEventListener: (type: string, handler: () => void) => { handlers[type] = handler; },
  });
  select.children = [Object.assign(element("option"), { value: "main", textContent: "main" })];
  const note = Object.assign(element("span"), { textContent: "", hidden: true });
  const visited: string[] = [];
  const fakeDocument = {
    getElementById: (id: string) => id === "ref-select" ? select : id === "ref-note" ? note : null,
    createElement: element,
  };
  const fakeWindow = { fetch: fetchImpl, location: { hash: "#specs", assign: (url: string) => { visited.push(url); } } };
  new Function("document", "window", switcherScript)(fakeDocument, fakeWindow);
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  const options = select.children.flatMap((child) => child.tag === "optgroup" ? child.children : [child]);
  return {
    groups: select.children.filter((child) => child.tag === "optgroup").map((child) => child.label),
    options: options.map((option) => [option.value, option.textContent]),
    note: note.hidden ? null : note.textContent,
    choose: (slug: string) => { select.value = slug; handlers.change!(); return visited; },
  };
}

describe("feature-map site: ref switcher", () => {
  const versions = buildSite(input([refInput("main", "branch"), refInput("release/1.0", "branch"), refInput("v0.2.0", "tag", without(tree, "docs/feature-map.md"))])).versions;

  test("B6: the switcher lists the refs of versions.json by kind and opens the chosen ref's page", async () => {
    const seen = await runSwitcher(async () => ({ ok: true, json: async () => versions }));
    expect(seen.groups).toEqual(["分支", "標籤"]);
    expect(seen.options).toEqual([["main", "main"], ["release-1.0", "release/1.0"], ["v0.2.0", "v0.2.0（沒有 feature map）"]]);
    expect(seen.note).toBe("網站建置於 2026-10-14 01:02 UTC");
    expect(seen.choose("main")).toEqual([]);
    expect(seen.choose("release-1.0")).toEqual(["../release-1.0/#specs"]);
  });

  test("B11: when versions.json cannot be loaded or is not the expected shape, the current ref stays and a notice says so", async () => {
    const failures: (() => Promise<unknown>)[] = [
      async () => { throw new TypeError("Failed to fetch"); },
      async () => ({ ok: false, status: 404, json: async () => ({}) }),
      async () => ({ ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } }),
      async () => ({ ok: true, json: async () => ({ refs: "nope" }) }),
      async () => ({ ok: true, json: async () => ({ refs: [{ name: "x", slug: "../../evil", kind: "tag" }] }) }),
    ];
    for (const failure of failures) {
      const seen = await runSwitcher(failure);
      expect(seen.options).toEqual([["main", "main"]]);
      expect(seen.note).toBe("無法載入版本清單，只顯示目前版本");
      expect(seen.choose("main")).toEqual([]);
    }
  });
});

describe("feature-map site: git and automation", () => {
  test("B3: a ref read from git gives the same bytes as its tree on disk; B8, B5: the command builds main, release/* and v* from a repository", () => {
    const work = mkdtempSync(join(tmpdir(), "feature-map-site-"));
    try {
      const repo = join(work, "repo");
      const git = (...args: string[]) => execFileSync("git", args, {
        cwd: repo, encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_AUTHOR_DATE: "2026-08-26T04:31:15Z", GIT_COMMITTER_DATE: "2026-08-26T12:31:15+08:00" },
      }).trim();
      mkdirSync(join(repo, "docs"), { recursive: true });
      git("init", "-q", "-b", "main");
      cpSync(join(fixture, "tree/docs/specs"), join(repo, "docs/specs"), { recursive: true });
      git("add", "-A");
      git("commit", "-q", "-m", "specs only");
      git("tag", "v0.1.0");
      git("tag", "-a", "v0.2.0", "-m", "annotated");
      git("tag", "not-a-release");
      cpSync(join(fixture, "tree"), repo, { recursive: true });
      git("add", "-A");
      git("commit", "-q", "-m", "feature map");
      git("branch", "release/1.0");
      git("branch", "topic/x");
      const head = git("rev-parse", "HEAD");

      const date = "2026-08-26T04:31:15.000Z";
      const fromGit = buildSite(input([{ name: "main", kind: "branch", sha: head, date, tree: gitTree(repo, head) }]));
      const fromDisk = buildSite(input([{ name: "main", kind: "branch", sha: head, date, tree: directoryTree(repo) }]));
      expect(fromDisk.files.get("main/index.html")).toContain("Alpha Thread");
      for (const [path, content] of fromDisk.files) expect(fromGit.files.get(path)).toBe(content);

      const out = join(work, "site");
      const run = () => execFileSync("bun", [
        join(root, "scripts/feature-map-site/build.ts"), "--repo-dir", repo, "--out", out, "--repository", repository,
        "--built-at", "2026-10-14T01:02:03Z", "--preview", "my/feature",
      ], { encoding: "utf8" });
      const log = run();
      expect(log).toContain("v0.1.0 no-feature-map");
      const versions = JSON.parse(readFileSync(join(out, "versions.json"), "utf8"));
      expect(versions.refs.map((item: { name: string; kind: string; status: string }) => [item.name, item.kind, item.status])).toEqual([
        ["main", "branch", "ok"], ["release/1.0", "branch", "ok"], ["my/feature", "branch", "ok"],
        ["v0.2.0", "tag", "no-feature-map"], ["v0.1.0", "tag", "no-feature-map"],
      ]);
      expect(versions.refs[0]).toMatchObject({ sha: head, date });
      expect(versions.refs[3].sha).toBe(git("rev-parse", "v0.1.0^{commit}"));
      expect(versions.generatorSha).toBe(head);
      expect(readdirSync(out).sort()).toEqual(["index.html", "main", "my-feature", "release-1.0", "v0.1.0", "v0.2.0", "versions.json"]);
      const before = readFileSync(join(out, "main/index.html"), "utf8");
      expect(before).toBe(fromGit.files.get("main/index.html")!);
      run();
      expect(readFileSync(join(out, "main/index.html"), "utf8")).toBe(before);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("B13: the workflow builds on pull requests, main, release branches, v* tags and by hand, and only the default branch deploys", () => {
    const text = readFileSync(join(root, ".github/workflows/feature-map-site.yml"), "utf8");
    const workflow = Bun.YAML.parse(text) as Record<string, any>;
    const on = workflow.on ?? workflow.true;
    expect(Object.keys(on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(on.push).toEqual({ branches: ["main", "release/**"], tags: ["v*"] });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
    expect(workflow.concurrency.group).toContain("'publish'");
    const { redispatch, build, deploy } = workflow.jobs;
    expect(Object.keys(workflow.jobs)).toEqual(["redispatch", "build", "deploy"]);
    expect(redispatch.permissions).toEqual({ actions: "write" });
    expect(redispatch.if).toContain("github.event_name == 'push'");
    expect(build.permissions).toEqual({ contents: "read", pages: "read" });
    expect(deploy.permissions).toEqual({ pages: "write", "id-token": "write" });
    expect(deploy.needs).toBe("build");
    expect(deploy.if).toBe("${{ needs.build.outputs.deploy == 'true' }}");
    expect(deploy.environment.name).toBe("github-pages");
    expect(build.outputs.deploy).toContain("github.event_name != 'pull_request'");
    expect(build.outputs.deploy).toContain("github.event.repository.default_branch");
    expect(build.outputs.deploy).toContain("steps.gate.outputs.deploy == 'true'");
    const steps = [...redispatch.steps, ...build.steps, ...deploy.steps] as { uses?: string; run?: string; with?: Record<string, unknown> }[];
    const uses = steps.flatMap((step) => step.uses === undefined ? [] : [step.uses]);
    expect(uses.sort()).toEqual(["actions/checkout@v4", "actions/deploy-pages@v4", "actions/upload-artifact@v4", "actions/upload-pages-artifact@v4", "oven-sh/setup-bun@v2"]);
    expect(build.steps.find((step: { uses?: string }) => step.uses === "actions/checkout@v4").with["fetch-depth"]).toBe(0);
    // No secret and no Cloudflare credential anywhere in the workflow.
    expect(text).not.toMatch(/secrets\.|CLOUDFLARE/u);
  });

  test("B14: Pages that is not enabled, or not built by GitHub Actions, stops the deploy with the setting to change", () => {
    expect(pagesDecision({ httpStatus: 200, buildType: "workflow" })).toEqual({ deploy: true, message: "GitHub Pages is enabled with source GitHub Actions." });
    const off = pagesDecision({ httpStatus: 404, buildType: null });
    expect(off.deploy).toBe(false);
    expect(off.message).toBe("GitHub Pages is not enabled for this repository. Enable it once: Settings → Pages → Build and deployment → Source: GitHub Actions. The site was built and uploaded as a workflow artifact; nothing was published.");
    const legacy = pagesDecision({ httpStatus: 200, buildType: "legacy" });
    expect(legacy.deploy).toBe(false);
    expect(legacy.message).toContain('source "legacy"');
    expect(legacy.message).toContain("Source: GitHub Actions");
    const denied = pagesDecision({ httpStatus: 403, buildType: null });
    expect(denied.deploy).toBe(false);
    expect(denied.message).toContain("HTTP 403");
  });
});
