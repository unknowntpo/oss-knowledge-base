# Spec 020: Generated feature-map site

Status: Implemented (#66, 2026-10-14; published at https://unknowntpo.github.io/oss-knowledge-base/); amended 2026-10-19: the status board (B19–B24)
Date: 2026-10-14
Traceability: enforced
Builds on: `docs/process/workflow.md` (verification kit, gardening), gardening G52

## Intent

The owner keeps a "product overview / feature map" page by hand, and it goes
stale. The repository already holds what that page says: `docs/feature-map.md`,
`docs/gardening.md` and the specs' status lines. So the page is generated from
them on every push and published, with nothing to remember:

- one static page per ref, built from that ref's own files;
- one site where the reader switches between `main`, release branches and
  release tags;
- every page says which ref and commit it shows, and when that commit was made.

The point is the automation (owner: 「重點是流程要自動化」): after this change
no one edits or republishes the page.

## Evidence

- `main` at `1e56522` (2026-10-13): `docs/feature-map.md` has 11 sections and
  10 tables; `docs/gardening.md` has 60 open items; 18 specs.
- The sources drift too, and a generated page shows it instead of hiding it.
  Found while building this (fixed in the same PR):
  - the `OSS_KB_BUCKET` row said "the hourly publication … about 40 Class A …
    a run". Publication is daily (Spec 018), and the first daily run on Dev
    (`/health`, `lastRun.completedAt: 2026-10-13T22:07:09Z`) reports
    `copiedObjectCount: 388`, `reusedObjectCount: 7952`,
    `r2 {classA: 391, classB: 8343}`: the runbook's formula exactly
    (388 + 3; 388 + 7952 + 3);
  - Specs 016 and 017 said "Draft for human review" while the feature map's
    Deployed configuration lists their flags as set on Dev.
- Tags `v0.1.0` (`3779549`, 2026-08-26) and `v0.2.0` (`308d3fa`, 2026-08-31)
  have no `docs/feature-map.md` and no `docs/gardening.md`; they have 5 and 6
  specs. There is no `release/*` branch yet.
- GitHub Pages is enabled for the repository with source "GitHub Actions"
  (`GET /repos/unknowntpo/oss-knowledge-base/pages`: `build_type: "workflow"`,
  `html_url: https://unknowntpo.github.io/oss-knowledge-base/`; enabled by the
  owner's session on 2026-10-14). Its `github-pages` environment accepts
  deployments from the branch `main` only (deployment branch policy, one
  entry). Nothing is published there today (the URL answers 404).
- Dev `/health` sends no `access-control-allow-origin` header (checked
  2026-10-14 with an `Origin` request header), so a page on another origin
  cannot read it.

## Example

`bun run docs:feature-map-site -- --out <dir> --built-at 2026-10-14T00:00:00Z`
in a clone of this repository on 2026-10-14 (before this PR):

```text
main/ main ok 1e56522 181618 bytes
v0.2.0/ v0.2.0 no-feature-map 308d3fa 13370 bytes (docs/feature-map.md is not in this tree)
v0.1.0/ v0.1.0 no-feature-map 3779549 12922 bytes (docs/feature-map.md is not in this tree)
3 refs, 8 files → <dir> in 920 ms
```

```text
<dir>/index.html            goes to main/
<dir>/versions.json         the three refs
<dir>/main/index.html       the page
<dir>/main/data.json        the same content as data
<dir>/v0.2.0/index.html     "此版本沒有 feature map", 6 specs
<dir>/v0.2.0/data.json
<dir>/v0.1.0/index.html     "此版本沒有 feature map", 5 specs
<dir>/v0.1.0/data.json
```

`main/index.html` shows, top to bottom:

| Part | Content on `main` at `1e56522` |
| --- | --- |
| Header | 「建置自 `main`（分支）· commit `1e56522` · commit 時間 2026-10-13 09:39 UTC」, the ref switcher, and, once `versions.json` is read, 「網站建置於 …」 |
| 總覽 | 18 specs (已實作 4 · 已接受 9 · 草稿 3 · 其他 2), 60 gardening items, 16 deployed-configuration rows, 6 schedules, 11 feature-map sections |
| 規格 | one row per spec: number, title, status (badge and the `Status:` line as written), acceptance IDs and surface from the feature map's "Acceptance IDs by spec" row |
| 部署設定 | the "Deployed configuration" section: its table and the prose around it |
| 排程 | the "Schedules" section |
| 待處理事項 | the 60 gardening items by category; each opens to Where, Why, Fix, Layer, Source |
| Feature map 全文 | every other section of the feature map, collapsed, in its own order |

`versions.json`:

```json
{
  "schema": "feature-map-site.versions.v1",
  "repository": "unknowntpo/oss-knowledge-base",
  "builtAt": "2026-10-14T00:00:00.000Z",
  "generatorSha": "1e56522408bab92fafd9ad17d28f779497563457",
  "default": "main",
  "refs": [
    { "name": "main", "slug": "main", "kind": "branch", "sha": "1e56522408bab92fafd9ad17d28f779497563457", "date": "2026-10-13T09:39:37.000Z", "status": "ok" },
    { "name": "v0.2.0", "slug": "v0.2.0", "kind": "tag", "sha": "308d3fa3a44cc0f20af5855b681ae1d6e801f733", "date": "2026-08-31T01:26:11.000Z", "status": "no-feature-map", "reason": "docs/feature-map.md is not in this tree" },
    { "name": "v0.1.0", "slug": "v0.1.0", "kind": "tag", "sha": "37795499e500cc2609a11088dfc6d949c8f345d6", "date": "2026-08-26T04:31:15.000Z", "status": "no-feature-map", "reason": "docs/feature-map.md is not in this tree" }
  ]
}
```

## Simplification review

1. **Question every requirement.**
   - The page per ref: the owner, who reads the product's state without
     opening three Markdown files.
   - The ref and commit stamp: the owner, to tell a current page from an old
     one.
   - `data.json`: the next consumer of the same facts (an agent, the product
     overview, a check), so that nobody parses the HTML.
   - `versions.json` and the switcher: the owner, to compare a release with
     `main`.
   - The Pages gate and the post-deploy check: the maintainer, so that a
     publish that did not happen is a red run, not a stale page.
2. **Delete.**
   - A Markdown library: the three sources use a small subset, and a
     dependency would need `bun install` in the workflow and a lockfile
     change. A small parser of that subset (gardening G67).
   - A `gh-pages` branch and per-ref incremental publishing (option b below).
   - Worktrees or one checkout per ref: each ref's files are read from the
     git object store (`git show <ref>:<path>`).
   - A build time on every page: it would change every file on every run. The
     page carries its commit time; the build time is in `versions.json` only.
   - A page template, a bundler, client-side rendering: the page is complete
     HTML; its one script only fills the switcher.
   - Live Dev health and the owner's pending decisions: not derivable from the
     tree; proposed below, not built.
   - Publishing every branch: 62 remote branches exist, most of them merged
     leftovers. A pull request gets the site as a workflow artifact instead
     (Decision 4).
3. **Simplify.** Two pure functions do the work: `buildData(tree, ref)` and
   `renderPage(data)`; `buildSite` calls them per ref and adds the two root
   files. A ref is an interface with `read(path)` and `list(directory)`, so a
   directory and a git revision are the same to the generator.
4. **Shorten the cycle.** The unit tests run in in about two seconds on a
   small fixture tree and a temporary repository; the whole site builds in about
   one second.
5. **Automate last.** One workflow file; the command it runs is the one a
   person runs locally.

## Behavior

### Generator

1. The generator reads only these files of the tree it is given:
   `docs/feature-map.md`, `docs/gardening.md`, and `docs/specs/<NNN>-*/spec.md`.
   The ref's name, kind (`branch` or `tag`), commit SHA and commit time are
   passed in. It reads no clock, no environment and no network.
2. `data.json` (`schema: "feature-map-site.data.v1"`) holds: `repository`,
   `ref {name, slug, kind, sha, date}`, `status` (`ok` or `no-feature-map`),
   `notes[]` (what the tree lacks), `featureMap {path, title, sections[]}`
   (each section: `level`, `title`, `anchor`, `blocks[]` of type `paragraph`,
   `table {headers, rows}`, `list`, `code`, `quote`), the tables
   `deployedConfiguration` and `schedules` of the sections so named,
   `specs[] {number, directory, path, title, status, statusKind, acceptanceIds,
   surface}`, `gardening {path, lastFullPass, items[] {id, title, anchor,
   category, layer, fields[]}}`, and `counts`. Cell text is the source's
   Markdown, unrendered.
3. A spec's `status` is its `Status:` line as written (also the older
   `- Status:` list form); `statusKind` is `implemented`, `accepted` or
   `draft` when the line starts with that word, else `other`. `acceptanceIds`
   and `surface` come from the feature map's "Acceptance IDs by spec" row
   whose first cell links the spec's number, or are `null`.
4. `index.html` is one file: inline CSS, one inline script, no image, font or
   other request. `<html lang="zh-Hant">`; labels are Traditional Chinese;
   identifiers, section titles and source text stay as written. It works
   without the script. At 720 px and below a table becomes one card per row.
5. Every page states its ref, the ref's kind, the commit (7 characters,
   linking to the commit on GitHub) and the commit time in UTC. A page of a
   ref other than the default says that it is not the latest state and links
   to the default ref's page.
6. Source text is escaped. Inline code, bold and links are rendered; a
   relative link becomes the file on GitHub at the page's commit; a link with
   a scheme other than `http`, `https` or `mailto` is dropped and its text
   kept.
7. The same tree and metadata give byte-identical `index.html` and
   `data.json`, whether the tree is a directory or a git revision.

### Site

8. The site is `/<slug>/index.html` and `/<slug>/data.json` per ref,
   `/versions.json` (`schema: "feature-map-site.versions.v1"`: `repository`,
   `builtAt`, `generatorSha`, `default`, `refs[] {name, slug, kind, sha, date,
   status, reason?}`), and `/index.html`, which goes to the default ref and
   lists every ref as a link. Refs are ordered: the default branch, other
   branches, tags; within a group newest version first (`v0.10.0` before
   `v0.2.0`).
9. A slug is the ref name in lower case with every run of characters outside
   `a-z 0-9 . _ -` replaced by one hyphen, repeated dots collapsed, and
   leading and trailing separators removed (test plan below). Two refs with
   the same slug: the later one gets `-<kind>`, then `-<kind>-<n>`.
10. Each page's switcher shows the page's own ref. Its script loads
    `../versions.json`, lists the refs by kind, marks refs without a feature
    map, and opens `../<slug>/` keeping the URL fragment. When the file cannot
    be loaded, is not JSON, or is not that shape (a slug that is not a slug
    included), the switcher keeps the one ref and says
    「無法載入版本清單，只顯示目前版本」.
11. A tree without `docs/feature-map.md` still gets a page: the notice
    「此版本沒有 feature map」, its specs, and its gardening items if it has
    the file. Its `versions.json` entry has `status: "no-feature-map"` and the
    reason. A feature map of another shape is rendered section by section; a
    missing "Deployed configuration" or "Schedules" table is a note in
    `data.json` and a notice on the page.
12. A ref whose generation throws gets a page with the reason,
    `status: "error"`, and no `data.json`; the other refs are built. If the
    default ref throws, or is missing, the build fails: a broken default page
    is not published.

### Automation

13. `.github/workflows/feature-map-site.yml` runs on pull requests, on a push
    to `main`, to `release/**` or of a tag `v*`, and by hand. It needs no
    secret and no Cloudflare credential. Top-level permissions are
    `contents: read`.
14. Every run builds every ref with the generator of the commit it checked
    out: `main`, `release/*` branches and `v*` tags, each read from git after
    a full fetch (option (a) below).
15. The `github-pages` environment accepts deployments from `main` only, so a
    push to a release branch or of a tag does not build: its one job starts
    the workflow on `main` (`workflow_dispatch`, `actions: write` in that job
    only). The site is therefore always built and deployed from `main`.
16. A run on `main` (push or by hand) uploads the site as a workflow artifact,
    checks that Pages is enabled with source "GitHub Actions"
    (`GET /repos/{repo}/pages`, `pages: read`), deploys with
    `actions/deploy-pages` (`pages: write`, `id-token: write`, in the deploy
    job only), and then reads the published `versions.json` until it names the
    commit of `main` that the run built (10 tries, 6 s apart), failing
    otherwise.
17. **Pages not enabled: the run fails.** With Pages off (404) or built from a
    branch (`build_type` other than `workflow`), the gate step fails with the
    setting to change, in an error annotation and in the job summary; the
    built site is still attached as an artifact. On a pull request the same
    check only warns. (The alternative, skipping the deploy and staying green,
    would hide that nothing is published; Pages is enabled today, so a failure
    here means someone turned it off.)
18. A pull request run builds the same refs plus the pull request's own tree
    as one more branch named after its head branch, uploads the site as the
    artifact `feature-map-site-<sha>` (7 days), and deploys nothing.
19. Publishing runs share one concurrency group and are not cancelled: one
    runs, at most one waits, and the newest waiting run wins. A run reads
    every ref when it starts, so the last run publishes the newest state.
    Pull request runs have a group per pull request and cancel their
    predecessor.

## Alternatives

**How refs are published.**

| | (a) Rebuild every ref on each run (chosen) | (b) Publish one ref into a `gh-pages` branch |
| --- | --- | --- |
| Generator | one version, `main`'s, for every ref: every page has the same layout and the same switcher | each ref's page is built by whichever generator ran when it was pushed; a layout fix does not reach old pages |
| Old tags | get a page on the first run | never built unless someone re-pushes or backfills them |
| State | none: the site is a pure function of the repository | a branch that accumulates; a deleted release branch leaves its page behind until someone prunes it |
| Races | none inside a run | two pushes edit `versions.json` on the same branch |
| Permissions | `pages: write` in one job | `contents: write` for the workflow |
| Cost | every run rebuilds all refs: 0.9 s for 3 refs, about 0.3 s per ref | one ref per run |
| Limit | the page of an old tag changes when the generator changes (its data does not) | — |

(a) has no concrete problem at this size. It would need a second look at
several hundred refs (about 0.3 s and 0.35 MB each).

**Where it is hosted.**

| | GitHub Pages (chosen) | Cloudflare Pages |
| --- | --- | --- |
| Credentials | the workflow's own token | `CLOUDFLARE_API_TOKEN`, an account id, a new Pages project |
| Cost and blast radius | none; not in the product's Cloudflare account | free at this size, but in the account that runs Dev and Prod, next to their projects |
| Per-branch pages | not native: this spec's `/<slug>/` layout and `versions.json` | native preview URL per branch (`<branch>.<project>.pages.dev`) |
| One site with a switcher | yes, one origin | each branch is its own deployment and origin; a switcher needs a list fetched across origins, or a build that assembles them anyway |
| Access control | public (the repository is public) | can sit behind Cloudflare Access |

Cloudflare Pages was not chosen: it needs a token and a project the workflow
must not create by itself, it puts a documentation site in the account whose
budget the product uses, and its per-branch previews do not give one site
with a switcher. Its advantage, Access, matters only if the repository goes
private.

## Proposed, not built

1. **Live Dev status strip.** The page could fetch the public Dev `/health`
   in the browser and show the last publication's time and outcome. It needs
   `access-control-allow-origin: https://unknowntpo.github.io` on the Worker's
   `GET /health` (it sends none today), which changes a public endpoint and
   belongs in its own PR. It would only ever be shown on the default ref's
   page, and its failure would have to be as quiet as the switcher's.
2. **Pending decisions.** The hand-made page lists what waits for the owner.
   Source: a file `docs/decisions-pending.md` (one table: decision, spec,
   recommendation, since), which the generator would render as its own
   section when present, plus a check that each spec's "Decisions needed from
   owner" items are in it. Without the file nothing changes.

## Amendment 2026-10-19: status board

Intent (owner, 2026-10-19): the project is shown to outside readers, such as
a hiring manager, who want to know at a glance what is built, what is in
progress and what is planned. The page listed the specs' Status lines as
written, and 14 of 24 were stale (Spec 020 itself said "Draft"), so the
summary tiles said "accepted 9, draft 3" for a project whose specs were
almost all built. The board derives each spec's place, so a stale word
shows up as a wrong group instead of hiding in a long line.

Behavior:

1. Every page opens with a section `#status` (現況 · What is built, in
   progress and planned): one tile per group with its count, then the
   groups: 已上線 Prod · Live on Prod; 僅 Dev · Live on Dev only; 進行中 · In
   progress; 規劃中 · Planned; 其他 · Other (only when a spec is in it); 已知缺口
   · Known gaps. Each spec appears in exactly one group, with its number
   linking to its `spec.md` at the page's commit, its title, and a reason.
2. The group follows the rule in the test plan below (`specStage`): pending
   acceptance items or a Status starting "Partially implemented" → In
   progress; "Implemented" → Live on Prod when the spec's directory is in the
   production tag and no Deployed configuration row naming it is off on
   Prod, else Live on Dev only (Dev deploys every push to `main`);
   "Accepted" or "Draft" → Planned; any other first word (a spike) → Other.
3. The production tag is the newest `v*` tag of the site whose page could be
   generated (`.github/workflows/ci.yml` deploys Prod on a `v*` tag). All
   pages of one build use the same one. Without such a tag nothing is on
   Prod and the board says so.
4. A spec is off on Prod when a row of the Deployed configuration table cites
   `Spec <NNN>` in any cell and its Prod cell starts with `unset` or `none`;
   the reason lists the row's names.
5. The Prod group also shows the Prod row of the Environments table, so the
   reader sees what Prod runs (a snapshot, a publisher never deployed).
6. Known gaps counts the open gardening items per category, each linking to
   its category on the page.
7. Pending items are counted with the traceability gate's own parser
   (`acceptanceItems`), so the board and the gate agree.
8. Every Status line starts with Implemented, Partially implemented,
   Accepted, Draft, or (spikes only) Spike; B25 checks the repository.

`data.json` gains `production`, `counts.specsByStage`, and per spec
`acceptanceItems`, `pending`, `inProduction`, `offOnProd` and `stage`.

## Test plan

Generated from `scripts/test/feature-map-site.cases.ts` by
`bun run docs:test-plan`; the unit tests run exactly these rows.

<!-- test-plan:start scripts/test/feature-map-site.cases.ts -->
| id | ref | slug | why |
| --- | --- | --- | --- |
| B4 | main | main | unchanged |
| B4 | v0.2.0 | v0.2.0 | dots and digits are kept |
| B4 | release/1.0 | release-1.0 | a slash would be a directory |
| B4 | release/2.x/hotfix | release-2.x-hotfix | every slash |
| B4 | Release/RC_1 | release-rc_1 | lower case: Pages paths are case-sensitive |
| B4 | feat/搜尋 v2 | feat-v2 | anything outside a-z 0-9 . _ - becomes one hyphen |
| B4 | ../../etc | etc | no leading dots or hyphens, so no path traversal |
| B4 | a..b | a.b | repeated dots collapse |
| B4 | -x- | x | trimmed |
| B4 | /// | ref | nothing left: a fixed name |
| B4 | versions.json | versions.json-ref | reserved root file |
| B4 | index.html | index.html-ref | reserved root file |
<!-- test-plan:end -->

The status board's rule (B19), from `scripts/test/feature-map-site-board.cases.ts`:

<!-- test-plan:start scripts/test/feature-map-site-board.cases.ts -->
| id | status | pending | inTag | offOnProd | stage | why |
| --- | --- | --- | --- | --- | --- | --- |
| B19 | Implemented (PR #7) | 0 | yes | 0 | prod | built and in the tag Prod runs |
| B19 | Implemented (PR #7) | 0 | no | 0 | dev | built after the tag: Dev deploys every push to main |
| B19 | Implemented (PR #7) | 0 | yes | 1 | dev | a flag naming the spec is unset on Prod |
| B19 | Partially implemented: slices 1–2 | 3 | no | 0 | progress | partial status with pending items |
| B19 | Partially implemented: slices 1–2 | 0 | yes | 0 | progress | the partial status alone, even in the tag |
| B19 | Implemented | 2 | yes | 0 | progress | pending items win over the status word |
| B19 | Accepted 2026-10-08 | 0 | yes | 0 | planned | accepted is not built |
| B19 | Draft for owner review | 4 | no | 0 | planned | a draft with pending items is still planned |
| B19 | Spike completed (#13) | 0 | no | 0 | other | no known first word |
| B19 |  | 0 | no | 0 | other | no Status line |
<!-- test-plan:end -->

Named tests: `scripts/test/feature-map-site.test.ts`, on the fixture tree
`scripts/test/fixtures/feature-map-site/` and on a temporary git repository
with `main`, `release/1.0`, a lightweight and an annotated `v*` tag, another
tag and another branch.

| ID | Scenario | Expected |
| --- | --- | --- |
| B3 | the same refs in another order; the same tree read from git and from disk; the command run twice | identical bytes; another SHA changes only that ref's page |
| B8 | a tree without the feature map and the gardening list | page with the notice and the specs; `status: "no-feature-map"`; the site builds |
| B10 | a tag whose tree cannot be read; then the default branch likewise | error page and `status: "error"` for the tag; the build fails for the default branch |
| B11 | `versions.json`: network error, 404, not JSON, wrong shape, a slug `../../evil` | the select keeps the current ref; the notice; no navigation |
| B13 | the workflow file, parsed | triggers, permissions per job, concurrency, pinned actions, deploy gated on the default branch |

## Acceptance

### Behavior
- B1: the fixture tree gives the Deployed configuration and Schedules tables,
  the sections of the feature map, each spec with its number, title, status
  and the acceptance IDs of its feature-map row, and each gardening item with
  its ID, title, category, layer and fields.
- B2: the page names the ref, its kind, the commit and the commit time; its
  labels are Traditional Chinese; it loads nothing from another origin and
  shows its content without the script; a relative link opens the file on
  GitHub at the page's commit; a page of another ref than the default says so.
- B3: the same tree and metadata give byte-identical files, in any ref order,
  from a directory or from git, and when the command runs twice.
- B4: a ref name becomes its slug by the rule of Behavior 9 (test plan).
- B5: the site is `/<slug>/index.html` and `data.json` per ref,
  `versions.json` in the shape and order of Behavior 8, and a root page that
  goes to the default ref; the command finds `main`, `release/*` and `v*` in
  a repository and nothing else.
- B6: the switcher lists the refs of `versions.json` by kind and opens the
  chosen ref's page, keeping the fragment.
- B7: a table row splits on unescaped pipes only; lists keep nesting; a
  fenced block keeps its text; source HTML is escaped; only `http`, `https`
  and `mailto` links are kept.
- B13: the workflow builds on pull requests, `main`, `release/**`, `v*` tags
  and by hand; only a run on the default branch deploys; permissions are per
  job and minimal; actions are pinned like the repository's other workflows;
  it uses no secret.

- B19: a spec's group follows the rule of the amendment's Behavior 2 (test
  plan rows).
- B21: a spec is off on Prod exactly when a Deployed configuration row cites
  it and is unset or none on Prod; a row set on Prod turns nothing off.
- B22: each spec carries its acceptance items, pending items, production
  membership, off-on-Prod names and group, and the group counts add up.
- B23: the page opens with the board before the overview: a tile per group
  with its count, each spec under its group with a link and a reason,
  bilingual headings, the production tag and the Prod environment row, and
  the gardening categories with counts and links; Other only when used.
- B25: every spec of this repository has a Status line the board
  understands; only a spike is Other.

### Failure and retry
- B20: the production tag is the newest `v*` tag whose page builds (an
  unreadable newer tag is skipped), the same on every ref's page; without
  one, nothing is on Prod and the board says so.
- B8: a tree without `docs/feature-map.md` gets a page that says so, with its
  specs; its `versions.json` entry records the reason; the site builds.
- B9: a feature map of another shape is rendered section by section and the
  missing tables are recorded.
- B10: a ref that cannot be generated gets a page with the reason and the
  other refs are built; the default ref failing, or missing, fails the build.
- B11: when `versions.json` cannot be loaded or is not the expected shape,
  the current ref stays, a notice says so, and nothing navigates.
- B12: refs whose names give the same slug are published under distinct
  slugs.
- B14: Pages that is not enabled, or not built by GitHub Actions, stops the
  deploy with the setting to change.

### Budget
- B15: [measure] limits: a job of 10 minutes; a published Pages site of at
  most 1 GB (GitHub's documented limit). Measured 2026-10-14 on this
  repository (3 refs): 0.92–1.14 s for the whole site, 396 KB on disk;
  `main/index.html` 182 KB (50 KB gzipped) and `main/data.json` 170 KB.
  Command: `bun run docs:feature-map-site -- --out <dir>` (prints each
  page's bytes and the total time). No model, no R2, no Cloudflare request.

- B24: [measure] at 375 px the page has no horizontal scroll
  (`scrollWidth` 375 = `clientWidth`) and the board's tiles fit three to a
  row; at 1280 px all six tiles fit one row. Measured 2026-10-19 with
  Playwright Chromium on a local build of this branch.

### Observability
- B16: [deploy] after the merge, the run on `main` deploys;
  https://unknowntpo.github.io/oss-knowledge-base/ goes to `main/`, whose
  page names the merge commit; `versions.json` lists `main`, `v0.2.0`,
  `v0.1.0`; the run's last step printed "Published …".
- B17: [deploy] pushing a tag `v*` (or a branch `release/x`) starts a run on
  `main`, and the new ref is in the switcher when that run ends.
- B18: [deploy] a pull request run has the artifact `feature-map-site-<sha>`
  with the pull request's branch among the refs, a skipped deploy job, and no
  new deployment in the `github-pages` environment.

## Decisions needed from owner

1. **Host: GitHub Pages.** Recommended (see Alternatives). The site is public
   at https://unknowntpo.github.io/oss-knowledge-base/; it shows nothing that
   the public repository does not.
2. **Rebuild every ref on each run** (option a) rather than a `gh-pages`
   branch. Recommended.
3. **Tags and release branches publish through a re-dispatch on `main`**,
   which gives one job `actions: write`. Recommended: it needs no setting.
   The alternative is to add `v*` tags and `release/**` to the `github-pages`
   environment's deployment rules and deploy from those refs directly.
4. **Which refs get a page.** Now: `main`, `release/*`, `v*`; any other
   branch only as its pull request's artifact (a zip to download).
   Alternatives: publish branches with an open pull request under their own
   slug (needs `pull-requests: read` and a rebuild when a pull request opens
   or closes), or every branch (62 today). Recommended: keep as is until the
   artifact proves too clumsy.
5. **Retire the hand-made product overview page.** Recommended: once B16 is
   observed, stop updating it and point it at the site; its two parts that
   the repository cannot supply are the proposals above.
6. **Live Dev status strip** (CORS on `/health`) and **`docs/decisions-pending.md`**:
   build them, in that order of usefulness? Recommended: pending decisions
   first (no deployed change); the status strip only if the owner misses it.
7. **Old tags.** `v0.1.0` and `v0.2.0` get a page that says there is no
   feature map and lists their specs. Alternative: leave such refs out of the
   site. Recommended: keep them, so the switcher shows every release.

## Runbook

`docs/runbooks/feature-map-site.md`: where the site is, how to build it
locally, what a failed run means, and the one setting it depends on.

The one manual step, **already done** (2026-10-14, by the owner's session):
GitHub Pages enabled with Source "GitHub Actions" (Settings → Pages → Build
and deployment). Nothing else has to be done after the merge. If Pages is
turned off, the next run on `main` fails at "Require GitHub Pages with source
GitHub Actions" and names this setting.

## Known limits

1. Not verified before the merge: the deploy job, the post-deploy check and
   the re-dispatch run only from `main` (B16, B17). The workflow's syntax, the
   build, the artifact and the Pages gate are exercised by this PR's own run
   (B18).
2. The page of an old ref is rebuilt by today's generator, so its layout can
   change after the fact; its `data.json` changes only if the parser does.
3. The Markdown parser is a subset (G67). Text it does not understand is
   shown as text, not dropped.
4. `versions.json` is fetched from the same origin; a page opened from disk
   (`file://`) shows the notice of Behavior 10 instead of the list.

## Non-goals

- Checking that the feature map is true (G52): the page shows what the
  sources say.
- Changing what `docs/feature-map.md` contains, beyond this spec's rows and
  the two stale items listed under Evidence.
- Live data, pending decisions (proposed above), search, or a page per spec.
- Publishing every branch.
- Enabling or changing any repository, Pages or Cloudflare setting.
