# Spec 025: Public documentation site

Status: Implemented (not yet published: the Cloudflare Pages project `oss-knowledge-base-docs` is created by the owner after review)
Date: 2026-10-20
Traceability: enforced
Builds on: Spec 020 (feature-map site, its Markdown subset), Spec 023/024 (design tokens, dark theme), `docs/process/workflow.md`

## Intent

Two readers need the whole system on one site, without opening the repository:

- **Interviewers and outside engineers** (English): what the product is, how data flows,
  how search and the digest work and why, and how the project is engineered and kept cheap.
- **The owner** (Traditional Chinese, Taiwan usage): the same content, to hold the whole
  system in mind.

Observable outcome: a public static site at https://oss-knowledge-base-docs.pages.dev with
five pages in two locales and a 中/EN toggle that keeps the reader on the same page and
section; every fact links to its source in the repository at the build commit, or states
the endpoint and the time it was read.

Owner decisions (2026-10-20): its own Cloudflare Pages project, `oss-knowledge-base-docs`;
bilingual with the same content in both locales, English primary; v1 content is the four
topics below; the owner creates the Pages project after review, so the deploy job must skip
cleanly until then.

## Evidence

- `docs/feature-map.md`, `docs/specs/*`, `docs/architecture/*`, the runbook and the release
  notes already hold every fact, but in 25 files written for implementers and verifiers,
  partly in Chinese (`docs/architecture/search-algorithm.md`), partly stale (README says the
  last Prod tag is `v0.2.0`; Spec 018's schedule table predates the Dev digest cron).
- Two hand-made explainer pages (whole-project flow, digest flow; 2026-10-19/20) were useful
  but drifted from the repository within a day: the digest page listed the This-week layout
  in the wrong order, stated recall ≥ 0.8 and misattribution ≤ 1 as fixed thresholds (the
  spec fixes only `status-mismatch` 0 and `overbroad-stance` 0), and described the scoring as
  "recent comments and status changes" (it is decayed per-author human records). A
  generated site with checked links is the fix.
- `ci.yml` deploys Dev and Prod Pages with `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`; it has no pull-request preview deploys.

## Example

`bun run docs:build` at `a38ed29` (2026-10-20):

```text
404.html 17723 bytes
build.json 319 bytes
en/digest.html 42963 bytes
en/index.html 26312 bytes
en/overview.html 57444 bytes
en/process.html 32435 bytes
en/search.html 32602 bytes
index.html 18120 bytes
zh-Hant/digest.html 42556 bytes
zh-Hant/index.html 26248 bytes
zh-Hant/overview.html 57035 bytes
zh-Hant/process.html 32493 bytes
zh-Hant/search.html 32664 bytes
13 files, 418914 bytes → dist/docs-site in 71 ms
```

| Page | `en/` | `zh-Hant/` | Content |
| --- | --- | --- | --- |
| Home | `index.html` | `index.html` | what it is, live sites, status at a glance, links to the four topics |
| System & data flow | `overview.html` | `overview.html` | clickable flow (4 columns, 10 cards, 31 steps), the four stages, Dev vs Prod, why |
| Search | `search.html` | `search.html` | BM25 parameters, identifier normalisation, adjacency, shards and `terms.json`, Spec 017 evaluation, hybrid on Dev, query budget |
| Weekly digest | `digest.html` | `digest.html` | clickable flow (3 columns, 7 cards, 14 steps), validation rules, quality gate, cost |
| Process & cost | `process.html` | `process.html` | spec-driven workflow, traceability, CI/CD and releases, the R2 Class A incident, budgets, observability |

`build.json` names the commit (`a38ed294…`, committed 2026-10-20T00:36:21Z). The 中/EN link
on `en/search.html` opens `../zh-Hant/search.html` and carries the fragment, so
`en/search.html#eval` opens `zh-Hant/search.html#eval` (section ids are locale-independent).
Live numbers were read from the public Dev and Prod `/health` on 2026-10-20 (last runs
2026-10-19 22:07 and 22:37 UTC; digest 22:47 UTC: 448 candidates, 29 model calls, 1,637
estimated neurons) and are dated on the page.

## Simplification review

1. **Question every requirement.** Bilingual pages and the toggle: the two readers above
   (owner decision). Interactive flows: the owner, who used the two explainer pages to
   grasp the system. Source links at the build commit: every reader, so a number can be
   checked; the owner, so drift is visible. CI deploy: nobody republishes by hand (Spec 020's
   lesson). The audit: a public page must not leak a credential or advertise a
   cost-bearing route.
2. **Delete.**
   - A site framework (VitePress, Astro) or Vite app: five pages of prose and two flows do
     not need a bundler, routing or client rendering; a dependency would need lockfile
     changes and upgrades. The generator reuses Spec 020's dependency-free Markdown parser
     (`scripts/feature-map-site/markdown.ts`).
   - A Markdown library, front matter, a search box, a sitemap, analytics: not needed by
     either reader at five pages.
   - Per-locale navigation files: the page list is one constant (`PAGES`); labels are in the
     generator.
   - Duplicating the design tokens: they are read from `apps/web/styles.css` at build time.
   - Pull-request preview deploys: `ci.yml` has none, and the PR artifact `docs-site-<sha>`
     carries the built site.
   - Live data on the page (fetching `/health` in the browser): it would need CORS changes
     on the Worker and could spend R2 reads per visitor; numbers are dated instead.
   - The 43-node whole-project flow: reduced to 31 steps in 10 cards; routes that spend money
     are not shown.
3. **Simplify.** Two pure functions, `buildDocsSite(input)` and `auditSite(files)`; the CLI
   reads the repository and writes files; `deploy.ts` holds one decision function.
4. **Shorten the cycle.** The unit tests build a minimal fixture in memory (about 40 ms) and
   the real site (about 70 ms).
5. **Automate last.** One CI job; the build runs inside the existing `static` job via
   `bun run build`.

## Decisions

1. **Host: its own Cloudflare Pages project** (owner, 2026-10-20). Spec 020 chose GitHub
   Pages for the feature-map site because it needs no token and stays out of the product's
   account. For this site the owner chose Cloudflare Pages: a clear `pages.dev` name next to
   the product, and the same hosting as the product it describes. Consequences: the existing
   token (already used for Dev and Prod Pages) deploys it; the project is created by hand,
   once, never by CI; cost is none at this size (static assets on Pages are free; 13 files).
2. **Format: Markdown in the repository, two locales.** `docs/site/en/<page>.md` and
   `docs/site/zh-Hant/<page>.md`, same file names; flows in `docs/site/flows/<id>.json` with
   both locales per text. English is the primary and the default for a browser without a
   Chinese preference.
3. **Generator: a static script, not a framework.** `scripts/docs-site/` next to
   `scripts/feature-map-site/`, run with Bun, no new dependency.
4. **Content stays in sync by construction, not by review:** a link to a repository path that
   no longer exists fails the build; counts such as the number of specs are derived
   (`{{value:specs}}`); every page states the build commit; numbers read from a live endpoint
   say when; both locales must cite the same sources.
5. **No `noindex`.** The site is meant to be public; the audit keeps Worker hostnames,
   manual-trigger routes and Dev API links out of it.

## Behavior

1. `bun run docs:build [-- --out <dir>]` reads `docs/site/<locale>/*.md`,
   `docs/site/flows/*.json` and `apps/web/styles.css`, stamps `git log -1` (SHA and commit
   time), writes `<out>` (default `dist/docs-site`, replaced) and prints each file's size and
   the total. Any build or audit problem prints every problem and exits 1; nothing is written.
2. Output: `<locale>/<page>.html` for each locale (`en`, `zh-Hant`) and page (`index`,
   `overview`, `search`, `digest`, `process`); `index.html` (chooses a locale from a stored
   choice or `navigator.languages`, falls back to English, and links both without script);
   `404.html`; `build.json` (`schema: "docs-site.build.v1"`, `repository`, `commit`,
   `commitDate`, `locales`, `pages`).
3. A page starts with one level-1 heading (the title) and a lede paragraph. Every level-2
   heading carries an explicit `{#id}`; level-2 ids become the "On this page" list.
4. Links: `http(s)` as written; `<page>.html[#id]` within the locale; any other relative path
   is a repository path, rendered as a GitHub link at the build commit (`blob` for a file,
   `tree` for a directory) and must exist; other schemes and paths outside the repository
   are errors.
5. `{{value:specs}}` and `{{value:enforcedSpecs}}` are replaced by the count of
   `docs/specs/NNN-*` directories and of those marked `Traceability: enforced`; any other
   `{{…}}` is an error.
6. A paragraph that is only `{{flow:<id>}}` renders that flow: columns of cards of steps;
   each step is a link to its detail section (works without script); with script, one detail
   is shown at a time (the URL fragment, else the flow's `initial`), and elbow connectors are
   drawn between card headers. Below 760 px the columns stack and connectors are hidden. Every
   flow text exists in both locales; ids are unique; links name existing cards; `initial`
   names a step; every step names at least one existing repository source.
7. Each page has a 中/EN link to the same page in the other locale (`hreflang`, `lang`); the
   script stores the choice and carries the fragment. A theme button toggles light and dark
   (stored; the OS preference otherwise, also without script).
8. Styles: the product's `:root` and `:root[data-theme="dark"]` token blocks are copied from
   `apps/web/styles.css`, plus a small Japanese traditional palette (藤, 青磁, 勿忘草, 苔,
   薄紅, 藍) for translucent fills with fine outlines; no orange. Fonts: IBM Plex from Google
   Fonts, plus Noto Sans TC on `zh-Hant` pages.
9. The audit fails the build when the output: links to a missing page or anchor; loads any
   resource (script, stylesheet, image, frame, CSS `url()`) from a host other than
   `fonts.googleapis.com` and `fonts.gstatic.com`; contains an email address, a GitHub token,
   an AWS key id, a private key, a bearer credential or a `*TOKEN|SECRET|PASSWORD|API_KEY=`
   assignment; or names a `workers.dev` host, a manual-trigger route (`POST /run`,
   `/digest/run`, `/search-embedding/run`, `/review-queue/run`, `/github-reviews/*`),
   `MANUAL_TRIGGER_TOKEN`, or a Dev `/api/` URL.
10. Parity: for each page, both locales exist, carry the right `lang`, toggle to each other,
    have the same level-2 ids in the same order, the same flows, and the same set of cited
    repository paths.
11. The same input gives byte-identical output.
12. `ci.yml`: the `static` job builds the site (`bun run build`) and uploads it as the
    artifact `docs-site-<sha>` (7 days). Job `deploy-docs` runs only on a push to `main`,
    after `static` and `unit`, and calls `scripts/docs-site/deploy.ts`: it asks the
    Cloudflare API for the Pages project `oss-knowledge-base-docs`; 200 → `wrangler pages
    deploy dist/docs-site --project-name=oss-knowledge-base-docs --branch=main`; 404 → a
    notice and exit 0 (nothing deployed); any other status or missing credentials → failure.
    It never creates the project and never prints a credential.
13. After a deploy the job reads `https://oss-knowledge-base-docs.pages.dev/build.json` until
    it names the commit (10 tries, 6 s apart), failing otherwise; the outcome is written to
    the job summary.

## Acceptance

### Behavior
- DOC1: Given the content, when the site is built, then `en/` and `zh-Hant/` hold every page with the right `lang`, and the root page, `404.html` and `build.json` (naming the commit) exist. Evidence: unit test.
- DOC2: Given any built page, its 中/EN link opens the same page in the other locale, and the script carries the URL fragment. Evidence: unit test.
- DOC3: Given both locales, the audit finds no difference in level-2 ids, flows or cited sources; a difference is reported. Evidence: unit test and test-plan rows.
- DOC4: Every internal link and anchor in the output resolves; a broken one is reported. Evidence: test-plan rows.
- DOC5: A repository path becomes a GitHub link at the build commit, and the footer names the commit and its date. Evidence: unit test.
- DOC6: The output loads no resource from a host other than Google Fonts; Google Fonts is accepted. Evidence: test-plan rows.
- DOC7: The output contains no email, token or key, and does not advertise Worker hosts, manual-trigger routes or Dev API links; the public Dev site URL is accepted. Evidence: test-plan rows.
- DOC8: The product's light and dark tokens are inlined, with the dark block also under `prefers-color-scheme: dark`. Evidence: unit test.
- DOC9: A flow renders cards, step links and one detail per step without script; invalid flows fail the build. Evidence: unit test and test-plan rows.
- DOC10: `{{value:specs}}` is replaced by the derived count. Evidence: unit test.
- DOC11: The same input gives byte-identical files. Evidence: unit test.
- DOC14: The committed `docs/site` builds and audits clean in both locales. Evidence: unit test on the repository (failed before the content existed: 10 problems).

### Failure and retry
- DOC12: The deploy decision deploys only on a push to `main` with an existing project; a missing project is a skip, a non-404 error or missing credentials a failure; pull requests and tags deploy nothing. Evidence: test-plan rows.
- DOC13: The post-deploy check accepts `build.json` only when it names the commit (not another commit, not non-JSON). Evidence: unit test.
- DOC15: Every content error fails the build with the file and the problem: a missing counterpart page, an unregistered page, a heading without `{#id}`, a missing title, a link to a missing or out-of-repository path or a disallowed scheme, an unknown value or flow. Evidence: test-plan rows.

### Budget
- DOC16: [measure] The site stays small and fast to build: 13 files, 418,914 bytes in total, the largest page 57,444 bytes, built in about 70 ms (`bun run docs:build`, 2026-10-20). Limits: total under 1 MB, each page under 150 KB, Cloudflare Pages' 20,000 files per deployment. Hosting static assets on Pages costs nothing; one deploy per push to `main`.

### Observability
- DOC17: [deploy] After the owner creates the project, the next push to `main` deploys; the `deploy-docs` job summary says "Published https://oss-knowledge-base-docs.pages.dev at <sha>", `build.json` names the commit, and every page's footer shows it. Before that, the job summary says the project does not exist.

## Test plan

Rows of `scripts/test/docs-site.cases.ts`, run by `scripts/test/docs-site.test.ts`. Each build
and audit row first checks that the unchanged fixture builds and audits clean (positive control).

<!-- test-plan:start scripts/test/docs-site.cases.ts -->
| id | change | stage | expect | why |
| --- | --- | --- | --- | --- |
| DOC15 | zh-Hant/search.md deleted | build | docs/site/zh-Hant/search.md is missing | every page exists in every locale |
| DOC15 | en/extra.md added | build | is not a registered page | a page must be in the nav (PAGES) to be built |
| DOC15 | a level-2 heading without {#id} | build | needs an explicit {#id} | anchors must not depend on the locale |
| DOC15 | page starts without a level-1 heading | build | must start with one level-1 heading | the H1 is the page title |
| DOC15 | link to docs/specs/999-none/spec.md | build | does not exist: docs/specs/999-none/spec.md | a renamed source breaks the build instead of the link |
| DOC15 | link to ../../etc/passwd | build | link outside the repository | only repository paths are linked to GitHub |
| DOC15 | link to javascript:alert(1) | build | disallowed scheme | only http, https and repository paths |
| DOC15 | {{value:nope}} | build | unknown value {{value:nope}} | a typo in a derived value is not printed |
| DOC15 | {{flow:nope}} | build | unknown flow nope | a flow paragraph must name a flow file |
| DOC9 | flow node without zh-Hant title | build | node a1.title: missing zh-Hant text | every flow text exists in both locales |
| DOC9 | flow link to an unknown card | build | unknown card "ghost" | a connector joins two existing cards |
| DOC9 | flow initial names no node | build | initial: must name a node | the selected step on load exists |
| DOC9 | flow node without sources | build | sources: must name at least one repository path | every step cites where its facts come from |
| DOC9 | flow source path missing | build | does not exist: apps/none.ts | flow sources are checked like page links |
| DOC8 | styles.css without the dark block | build | has no ":root[data-theme="dark"] {" block | the product's dark tokens are required |
| DOC3 | zh-Hant overview has an extra {#id} section | audit | section ids differ between locales | both locales carry the same sections |
| DOC3 | en overview cites one more source | audit | cited sources differ between locales | both locales cite the same evidence |
| DOC4 | en link to missing.html | audit | broken link missing.html | a link to a page that is not built |
| DOC4 | en link to search.html#nowhere | audit | names a missing anchor | a fragment must exist on the target |
| DOC6 | a <script src> from a CDN | audit | loads an external resource from cdn.example.com | only Google Fonts may be loaded |
| DOC6 | a stylesheet from fonts.googleapis.com | audit |  | positive control: Google Fonts is allowed |
| DOC7 | text with dev@kafka.apache.org | audit | contains an email address | no email address in the output |
| DOC7 | text with ghp_ followed by 36 characters | audit | contains a GitHub token | no token in the output |
| DOC7 | text with a workers.dev hostname | audit | advertises a Worker hostname | its POST routes spend money |
| DOC7 | text with POST /digest/run | audit | advertises a manual trigger route | cost-bearing route |
| DOC7 | a link to the Dev /api/search | audit | advertises a link to a Dev API | each query can spend Workers AI neurons |
| DOC7 | text with the Dev site URL only | audit |  | positive control: the public Dev site may be named |
| DOC12 | push refs/heads/main yes 200 | deploy | deploy | the project exists |
| DOC12 | push refs/heads/main yes 404 | deploy | skip | the owner has not created the project yet: green, nothing deployed |
| DOC12 | push refs/heads/main yes 403 | deploy | fail | a token without Pages access is an error, not a skip |
| DOC12 | push refs/heads/main no - | deploy | fail | missing credentials on main |
| DOC12 | pull_request refs/pull/1/merge yes 200 | deploy | skip | pull requests deploy nothing (ci.yml has no preview deploys) |
| DOC12 | push refs/tags/v0.3.2 yes 200 | deploy | skip | a tag deploys Prod, not the docs |
<!-- test-plan:end -->

## One-time setup (owner)

1. Create the Pages project once, with the owner's own Cloudflare login (not CI):
   `bunx wrangler pages project create oss-knowledge-base-docs --production-branch=main`
   (or the dashboard: Workers & Pages → Create → Pages → Upload assets, name
   `oss-knowledge-base-docs`, production branch `main`).
2. Nothing else: the repository's `CLOUDFLARE_API_TOKEN` already deploys the Dev and Prod Pages
   projects. If it is scoped to named projects rather than the account, add this one.
3. Re-run the latest `CI and release` run on `main` (or push to `main`); `deploy-docs` deploys
   and checks https://oss-knowledge-base-docs.pages.dev/build.json.
4. Rollback or unpublish: Cloudflare dashboard → the project → Deployments (roll back), or
   delete the project; the job then skips again.

## Non-goals

- Full-text search, versioned docs per release, a sitemap or analytics.
- Live numbers fetched in the browser (dated numbers instead).
- Replacing `docs/feature-map.md`, the specs or the feature-map site; this site explains, they
  remain the sources.
- Content for the status-tense rule and translation guard beyond "in review" until PR #101
  merges.

## Open questions

1. Should the docs site also publish per release tag (like the feature-map site), or only
   `main`? v1: `main` only.
2. Should the feature-map site (GitHub Pages) link here, and this site link to it? v1 links
   only to the repository.
3. A custom domain? Not in v1.
