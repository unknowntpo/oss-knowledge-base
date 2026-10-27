# Spec 033: System map

Status: Partially implemented (slice 1: SM1–SM8, SM12–SM17, SM23, SM19 measured; slice 2: SM9–SM11, SM18, SM20 measured; SM21–SM22 [deploy], checked on Dev after the merge deploys (SM22 on 2026-10-26, from the Spec 027 drill); owner decisions 2026-10-26: decisions 1–5 below, and slice 2: `components` and the CORS header of `GET /health`; slice 3 planned: decision 5 amended 2026-10-27, the map moves to a private site, SM24–SM27 [pending]/[deploy]; the public half of rule 17 landed first, before `v0.3.3`: `docs:build` builds `PUBLIC_PAGES`, without the map page and its links, tested by name in `scripts/test/system-map.test.ts`; SM24 stays pending until `dist/ops-site` exists)
Date: 2026-10-26
Traceability: enforced
Builds on: Spec 025 (docs site, the system flow `docs/site/flows/system.json`, DOC20), Spec 020 (feature-map site, the Deployed configuration parser), Spec 018 (`/health`), Spec 028 (signals)

## Intent

AI agents write and deploy code faster than the owner can keep the whole system
in mind. Today the picture is split across four places: the docs-site system
flow (what exists), the Deployed configuration in `docs/feature-map.md` (what
is on in Dev and Prod), the publisher's `/health` (whether it works now), and
`git log` (what changed). Answering "what runs on Prod, is it healthy, what
runs on my laptop, and what changed since the release" means reading all four.

Readers: the owner first; later teammates who join and need the same picture.

Observable outcome: one page, the **system map** (on the docs site until slice 3,
then on its own private site, decision 5), that shows
for a chosen environment (Dev or Prod):

- every component that is live in that environment, laid out as the data flow
  of `system.json` (the same groups and links), and as a list grouped by
  status;
- each component's live status from that environment's `/health`;
- where each component runs (Cloudflare, GitHub Actions, or a manual step on
  the owner's machine, which is a risk);
- what changed between the Prod release tag and `main`.

The map does not copy Cloudflare's dashboards. Each component links to its
Cloudflare page (Worker logs, AI Gateway logs, R2 bucket) or GitHub page
instead of showing metrics.

Design: mockup v3, https://claude.ai/artifact/KZtmqD687Xpy79PNUJVTVd
(values illustrative; component names and links are real `system.json` data).

### Owner decisions (2026-10-26)

1. **Stage comes from the Deployed configuration.** A component's stage in
   Dev and in Prod is derived from the flag rows of the Deployed configuration
   table in `docs/feature-map.md`. The hand-written `tag` badges in
   `system.json` are replaced by a reference to the row that gates the
   component.
2. **`/health` reports status per component.** The publisher's `/health` gets
   one `components` list with a status per job and source; the page only
   displays it and does not interpret job-specific fields.
3. **Changes compare the Prod tag with `main`.** Every reader sees the same
   list; there is no per-viewer "since last visit" state.
4. **Generated, not hand-maintained.** The page is built from `system.json`,
   `docs/feature-map.md` and git at build time, plus `/health` at view time.
5. **A new page on the docs site, public.** Same audience rule as the rest of
   the docs site; it shows nothing that `/health` and the repository do not
   already publish.
   Amended 2026-10-27: **a separate private site.** The map is the owner's
   working view; the docs site is for other readers. The map moves to its own
   Cloudflare Pages project, `oss-knowledge-base-ops`, whose whole domain sits
   behind Cloudflare Access: only the owner's email may sign in, with a
   one-time PIN. The docs site stays public and no longer carries the map or
   links to it. Residual exposure, accepted: the repository and `/health` stay
   public, so Access hides the assembled view, not the data behind it.

## Evidence

Captured 2026-10-26 about 02:20 UTC.

- **Hand badges drift.** `system.json` tags 36 of 62 nodes as Dev only or off
  by hand. The Review queue job (`j-rq`) has no tag, so the diagram shows it
  on Prod, while `REVIEW_QUEUE_CRON` is unset in both environments (it runs
  only on a manual request). DOC20 checks that every deployed item is named,
  not that a badge matches a flag value.
- **Status needs job knowledge.** Dev `/health` has 21 top-level keys; each job
  reports success differently: `kipPages.lastRun.status: "failed"` (cwiki
  answered 503 at 01:49 UTC), `costGuard.status: "tripped"` (R2 Class A at
  207.81 % of the monthly allowance, mode `monitor`), `sreAgent.lastRun.verdicts:
  ["inconclusive"]`, `digest.lastRun` with no status field. Prod `/health` has
  12 keys and no `signals`, so Spec 028's per-job rule status exists only on
  Dev.
- **Cross-origin reads fail.** `GET /health` with `Origin:
  https://oss-knowledge-base-docs.pages.dev` returns no
  `access-control-allow-origin` header, so a docs-site page cannot read it.
- **Changes are invisible.** `v0.3.2..main` is 13 commits; nothing lists which
  components or flags they added.
- **Manual steps hide.** The fault drill (`POST /sre-agent/drill`) and manual
  triggers need a bearer token and a person; no schedule or `/health` field
  shows that they depend on the owner's laptop.

## Example

Real data, 2026-10-26 02:20 UTC, Prod tag `v0.3.2`, `main` at `7632200`.

Input rows (abridged):

| `system.json` node | gate (Deployed configuration row) | Dev cell | Prod cell |
| --- | --- | --- | --- |
| `cron-pub` Daily publication cron | none | — | — |
| `sre-diag` Diagnose | `SRE_AGENT` | `live` | `off` |
| `cost` Cost guard | `COST_GUARD` | `monitor` | `unset: off` |
| `j-ret` R2 retention | `R2_RETENTION` | `dry-run` | `unset` |
| `rq-trig` Review queue trigger | `REVIEW_QUEUE_CRON` | `unset` | `unset` |
| `j-rq` Review queue job | none; `runsOn: manual` (owner decision 2026-10-26: `POST /review-queue/run` with a token, both environments) | — | — |
| `j-people` identity links, KIP authors | `IDENTITY_LINKS`, … | on | unset |

`/health` (Dev) → `components` (abridged):

```json
[
  { "id": "publication", "status": "ok", "at": "2026-10-25T22:19:42.397Z" },
  { "id": "kip-pages", "status": "failed", "at": "2026-10-26T01:49:47.939Z", "reason": "cwiki.apache.org answered 503" },
  { "id": "cost-guard", "status": "warn", "at": "2026-10-25T22:07:34.039Z", "reason": "tripped: r2ClassA 207.81%" },
  { "id": "source:github", "status": "ok", "at": "2026-10-25T22:19:42.397Z" }
]
```

Expected page. Counts and the changes list are as built from the slice 1
branch after the verifier's round-2 fixes (parent commit `ea2809b`,
2026-10-26), against tag `v0.3.2`; the statuses assume the `/health` above
(slice 2):

| View | Shows |
| --- | --- |
| Prod, data flow | 26 live components; no SRE agent group, no Workers AI group; `rq-trig` absent, `j-rq` present with "manual ⚠"; title "26 live components (36 not live, not shown)" |
| Dev, data flow | 60 components (`rq-trig` and `access` not live); `j-people` and `cron-people` red (failed, reason "kip-pages: cwiki.apache.org answered 503"); `cost` yellow (warn); `manual`, `j-rq`, `verify` and `sre-drill` carry "manual ⚠" |
| Dev, list | groups Failed (3: `cron-people`, `j-people`, `src-asf`), Warn, Manual (4), OK, No status |
| Changes | nodes added since `v0.3.2` per group, among them "New group SRE agent: Collect firings, Diagnose, Record the run, Fault drill" and "New group Workers AI"; new manual steps Manual triggers, Review queue, Fault drill; "`SRE_AGENT` Dev off → live", "`PROJECT_TREND` added", "`Cloudflare Access` added" (`R2_RETENTION` was already `dry-run` at `v0.3.2`, so it is not listed); PRs #141–#158 from `v0.3.2..HEAD` |
| Any component, Cloudflare link | Worker logs of `oss-knowledge-base-data-dev` (or `-prod`) in the Cloudflare dashboard |

## Behavior

1. **Gate.** A `system.json` node that is not live everywhere names the
   Deployed configuration row(s) that gate it: `"gate": ["SRE_AGENT"]`. A row
   is named by any of its backticked names in the first column. The hand
   `tag` of kind `dev` or `off` is removed, and a gated node carries no hand
   `tag` of any kind (its badge comes from the gate); an ungated node may keep
   a tag of kind `on`. Needed by: decision 1.
2. **Live rule.** A gated node is live in an environment when every named row's
   cell for that environment is on. A cell is off when its text, without
   backticks, starts with `unset`, `none`, `off` or `no `; anything else is on
   (`dry-run` and `monitor` are on, shown with the mode as a chip). An
   ungated node is live in both. A gate that names no existing row, or a name
   that more than one row carries (such as `SEARCH_QUERY_GATE`, a Worker and a
   Pages row), fails the docs build naming the rows. A row shared by several
   names (`DIGEST_ENABLED`, `DIGEST_MODEL`, `DIGEST_GATEWAY_ID`) is decided by
   the row's leading value: one cell per environment for all its names. Needed by: decision 1. Reuses `parseMarkdown` and `plainText`
   (`scripts/feature-map-site/markdown.ts`) and the section and table helpers
   of `scripts/feature-map-site/generate.ts` (`sectionNamed`, `tableOf`,
   exported for this); `offOnProd()` stays spec-keyed.
3. **Badge.** The docs-site system flow shows "Dev only" for a node live on Dev
   and not on Prod, and "Off" for a node live nowhere, computed by rule 2; the
   wording is unchanged. Needed by: the existing diagram keeps its badges
   without hand tags.
4. **Runs on.** A node may declare `"runsOn": "github-actions"` or
   `"runsOn": "manual"`; the default is Cloudflare. `manual` means a person
   runs it (a token-authenticated `curl`, `bun run` on a laptop) and nothing
   schedules it. Needed by: the owner, to see laptop risk.
5. **Health binding.** A node may declare `"health": "<component id>"`, or a
   list of distinct ids, naming entries of `/health` `components` (rule 7); an
   id the Worker cannot emit fails the docs build. Several nodes may bind the
   same id. A node bound to several ids shows the worst of their statuses
   (failed, stale, warn, unknown, ok; an id missing from `components` is
   unknown), and its reason is prefixed with that id (`j-people`, one step
   for `identity-links`, `kip-pages` and `identity-backfill`). A node without
   a binding has no live status (shown as n/a). Needed by: rule 9.
   Amended 2026-10-26 (slice 2, G103): a list replaces the slice 1 stand-in
   bindings.
6. **Page.** The docs site gets a page "System map" (`docs/site/en/system-map.md`,
   `docs/site/zh-Hant/system-map.md`, registered in `PAGES` of
   `scripts/docs-site/generate.ts`, rendered from a `{{map:system}}` block
   the way `{{flow:system}}` is) with an environment switch (Dev, Prod; default
   Dev), a view switch (data flow, list; default data flow), the Prod tag and
   date, the build commit and its distance from the tag, the time `/health`
   was read, and an overall status (counts of failed, warn, manual).
7. **`/health` components.** The publisher's `/health` adds `components`: one
   entry per job and per source that the environment runs, each `{ id,
   status, at, reason? }` with `status` one of `ok`, `warn`, `failed`,
   `stale`, `unknown`. Ids are the job names Spec 028 uses (`publication`,
   `digest`, `embedding`, `cost-guard`, `identity-links`, `kip-pages`,
   `identity-backfill`, `retention`, `sre-agent`) and `source:<name>` for each
   publication source. `failed` when the job's last run failed; `stale` when
   no run started within the job's cadence plus Spec 028's `job.missed`
   grace; `warn` for a job-defined degraded state (cost guard `tripped`,
   retention `dry-run` with errors, SRE agent verdict `inconclusive`);
   `unknown` before the first run. A job that is off is not listed. The
   status is computed from state `/health` already reads; it does not depend
   on `OBSERVABILITY_SIGNALS` being on: it reuses the state readers of
   `signals/rules.ts` (`stateRules`) and the thresholds of
   `signals/profile.ts` (`SIGNAL_THRESHOLDS`: daily jobs 24.5 h warn, 27 h
   stale) instead of new ones. Details (slice 2): a `job.missed` warn (late)
   is `warn`; a source is judged by its own `ok` and `lastSuccessAt`; the SRE
   agent, not a Spec 028 job, is judged against the same daily limits; cost
   guard `warn` and `unconfigured`, retention `overrun`, `evidence-missing`
   and `unconfigured` are also `warn`; a record that did not answer, could not
   be read or has the wrong type is `unknown` with a reason. `at` is when the
   judged state was recorded (the last run, check or success), null when none
   is. The id list is the Worker's `COMPONENT_IDS`
   (`apps/data-publisher-worker/src/signals/profile.ts`), which the docs site
   imports. `components` is derived, so the SRE agent's tick body leaves it
   out like `sreAgent` (Spec 027 SRE34: no derived field). Needed by:
   decision 2.
8. **CORS.** `GET /health` answers with `access-control-allow-origin: *`,
   also when the publisher's answer is not ok. No other route or method
   changes (no `OPTIONS` handler: the page's `GET` with an `accept` header is
   a simple request). Needed by: rule 9 (the page runs on another origin).
9. **Live status.** In the browser the page fetches the selected
   environment's `/health` once on load and on switching environment, maps
   `components` to nodes by rule 5, and shows a status dot per node and the
   worst status per group.
10. **Live only.** A node that is not live in the selected environment (rule 2)
    is not drawn: not in the data flow, not in the list. A group with no live
    node is not drawn, nor are links to it. The title states how many are not
    shown. Not-live components appear only in the changes list. Owner
    feedback on mockup v2, 2026-10-26.
11. **Data flow view.** Columns, groups and links are those of `system.json`.
    Selecting a node highlights the links of its group and dims unrelated
    groups; links that skip a column are drawn only while one of their groups
    is selected. The detail panel shows the node's lead, its stage in both
    environments, status and reason, runs-on, upstream and downstream groups,
    and links (rule 13).
12. **List view.** Rows grouped Failed, Stale, Warn, Manual, OK, No status;
    columns: component, group, Dev stage, Prod stage, status, runs on, meta.
13. **Links out.** Each node links to the Cloudflare dashboard page for its
    resource, using the `?to=/:account/…` form so no account id is in the
    page: Worker logs for the environment's publisher (Cloudflare nodes), AI
    Gateway logs (nodes naming a gateway), the R2 bucket (R2 nodes); GitHub
    Actions runs for `github-actions` nodes; and the raw `/health` JSON. The
    page shows no metric values beyond `/health` `components`.
14. **Changes.** At build time the generator finds the newest `v*` tag
    reachable from the build commit and lists, against that tag: nodes added
    to or removed from `system.json`; Deployed configuration rows whose Dev
    or Prod cell changed (old → new); new nodes with `runsOn: manual` as a
    risk item; and the merged pull requests in `<tag>..HEAD` (subjects ending
    in `(#N)`). Needed by: decision 3.
15. **Only `/health` at view time.** The page's script fetches only the two
    publisher `/health` URLs. `auditSite` checks inline scripts and inline
    event-handler attributes (`on*="…"`) for any other URL, absolute or
    protocol-relative (`//host/…`). This is a drift check on generated output,
    not a security boundary: it catches a page script that starts calling
    something new, not a determined author hiding a URL. Needed by:
    the docs site stays static apart from this read.
16. **Determinism.** The build output depends only on the commit and its tags
    (no clock, no network), like the rest of the docs site (DOC11).
17. **Two sites from one build.** The docs build writes the public site
    (`dist/docs-site`) and the ops site (`dist/ops-site`). The ops site holds
    the system map pages (en, zh-Hant) and the assets they load, and no other
    docs page. The public site holds no system map page, no `{{map:system}}`
    output, and no link to the map (navigation, `index.md` "Read next",
    `process.md` Observability). `auditSite` (rule 15) checks both outputs.
    Needed by: decision 5 (amended).
18. **Ops deploy.** A CI job `deploy-ops`, like `deploy-docs` (Spec 025),
    deploys `dist/ops-site` to the Pages project `oss-knowledge-base-ops` on a
    push to `main` only. If the project is missing it skips with a notice; it
    never creates the project. Pull requests deploy nothing.
19. **Access on the production domain.** The owner creates the project and its
    Access setup in the dashboard (an account setting, not in a wrangler
    file). Pages' **Enable access policy** alone protects only the deployment
    URLs (`<hash>.oss-knowledge-base-ops.pages.dev`), not
    `oss-knowledge-base-ops.pages.dev` itself (Cloudflare Pages docs,
    "Preview deployments" and "Known issues: Enable Access on your
    `*.pages.dev` domain"). The setup therefore follows the Known issues
    steps: enable the policy, edit its application to drop the `*` subdomain
    so it guards the production domain, then enable the policy again so a
    second application guards `*.oss-knowledge-base-ops.pages.dev`. Both
    applications allow only the owner's email. The Deployed configuration
    gets a row `Cloudflare Access (ops site)`. The CORS header of `GET /health`
    (rule 8) already allows the new origin.

## Acceptance

### Behavior
- SM1: Given a `system.json` node gated by `SRE_AGENT` and a Deployed configuration whose `SRE_AGENT` row reads `live` on Dev and `` `off` `` on Prod → build → the node is live on Dev only and the system flow shows "Dev only". Evidence: unit test.
- SM2: Given cells `unset`, `unset: off`, `none`, `off`, `` `off`; no cron ``, `no cron` → each is off; `dry-run`, `monitor`, `true`, `bge-m3@1` → each is on. Evidence: unit test (case file).

<!-- test-plan:start scripts/test/system-map.cases.ts -->
| id | cell | live | mode | why |
| --- | --- | --- | --- | --- |
| SM2 | unset | no | — | no value: off |
| SM2 | unset: off | no | — | the default spelled out |
| SM2 | none | no | — | a binding that is not bound |
| SM2 | off | no | — | the flag's off value |
| SM2 | `off`; no cron | no | — | backticks do not count (Prod `SRE_AGENT`) |
| SM2 | no cron | no | — | "no " starts an off cell |
| SM2 | unset; no cron (Prod unchanged until its own PR, O2) | no | — | explanations after the value do not matter |
| SM2 | `dry-run`; `17 10 * * *` with its cron entry | yes | dry-run | a dry run is live, shown with its mode |
| SM2 | `monitor` (Spec 026 rollout step 1) | yes | monitor | monitor is live, shown with its mode |
| SM2 | `true` (Spec 016 slice 3 enable, 2026-10-13) | yes | — | a value is on |
| SM2 | `bge-m3@1` (Spec 016 H52, 2026-10-12) | yes | — | a revision is on |
| SM2 | bound (2026-10-13) | yes | — | a bound binding is on |
| SM2 | Workers AI | yes | — | any other text is on |
<!-- test-plan:end -->

- SM3: Given the repository → no `system.json` node has a `tag` of kind `dev` or `off`, no gated node has a hand `tag` of any kind (the build fails), and every gated node's badge equals rule 2's result; `rq-trig` is off in both environments, and `j-rq` is live in both and `runsOn: manual` (owner decision 2026-10-26). Evidence: unit test on the repository (before the change hand tags decided both badges; now `REVIEW_QUEUE_CRON` decides `rq-trig`).
- SM4: Given the Prod environment selected → the data flow and the list contain exactly the nodes live on Prod; the SRE agent group and its links are absent; the title counts the hidden nodes. Evidence: unit test on the rendered page (DOM).
- SM5: Given a `components` entry `{ id: "kip-pages", status: "failed", reason }` and two nodes bound to `kip-pages` → both nodes show failed with the reason, and their group's summary is failed. Evidence: unit test.
- SM6: Given a node with `runsOn: "manual"` → it carries the manual chip in both views, counts in the header's manual total, and its detail shows the risk note. Evidence: unit test.
- SM7: Given a node of each kind → its links point to `https://dash.cloudflare.com/?to=/:account/…` for its Worker, gateway or bucket, and no link contains an account id. Evidence: unit test.
- SM8: Given tag `v0.3.2` and the build commit → the changes list names the nodes added since the tag, each Deployed configuration cell change as old → new, and the merged PRs `(#N)` in `v0.3.2..HEAD`. Evidence: unit test on a fixture repository.
- SM9: Given Dev state with `kipPages.lastRun.status: "failed"` → `/health` `components` has `{ id: "kip-pages", status: "failed" }` with the run's error as reason. Evidence: Worker unit test.
- SM10: Given every job's state → `components` has one entry per job that is on, with the status rules of Behavior 7, and none for a job that is off. Evidence: Worker unit test (case file; the SM18 rows are SM18's cases).

<!-- test-plan:start apps/data-publisher-worker/test/health-components.cases.ts -->
| id | component | state | off | status | reason | why |
| --- | --- | --- | --- | --- | --- | --- |
| SM10 | every id | {} | — | ok | — | every job on and run 10 h ago: one ok entry per job and per source |
| SM10 | publication | {"lastRun":{"ok":false,"completedAt":"2026-10-26T02:00:00.000Z","error":"github: GitHub answered 503"}} | — | failed | GitHub answered 503 | the last run failed |
| SM10 | publication | {"lastRun":{"ok":true,"completedAt":"2026-10-25T11:00:00.000Z"}} | — | warn | no run for 25.0 h | late: past job.missed warn (24.5 h) |
| SM10 | publication | {"lastRun":{"ok":true,"completedAt":"2026-10-25T08:00:00.000Z"}} | — | stale | no run for 28.0 h | no run within the cadence plus the job.missed grace (27 h) |
| SM10 | source:jira | {"lastRun":{"ok":true,"completedAt":"2026-10-26T02:00:00.000Z","sources":{"jira":{"ok":false,"lastSuccessAt":"2026-10-25T22:00:00.000Z","error":"Jira answered 429"}}}} | — | failed | Jira answered 429 | the source failed in the last run |
| SM10 | source:mail | {"lastRun":{"ok":true,"completedAt":"2026-10-26T02:00:00.000Z","sources":{"mail":{"ok":true,"lastSuccessAt":"2026-10-25T06:00:00.000Z"}}}} | — | stale | no success for 30.0 h | no success within the daily limit |
| SM10 | source:github | {"lastRun":{"ok":true,"completedAt":"2026-10-26T02:00:00.000Z","sources":{}}} | — | unknown | no record of this source | the run has no record of the source |
| SM10 | digest | {"digest":{"enabled":true,"lastRun":{"ok":false,"completedAt":"2026-10-26T02:00:00.000Z","error":"model unavailable"}}} | — | failed | model unavailable | the last run failed |
| SM10 | digest | {"digest":{"enabled":false,"lastRun":null}} | — | absent | — | off (DIGEST_ENABLED unset): not listed |
| SM10 | embedding | {"searchEmbedding":{"enabled":true,"lastRun":{"ok":true,"pending":40,"completedAt":"2026-10-26T08:00:00.000Z"}}} | — | stale | no run for 4.0 h | chunks pending and no run within its 3 h limit |
| SM10 | embedding | {"searchEmbedding":{"enabled":true,"lastRun":{"ok":true,"pending":0,"completedAt":"2026-10-24T08:00:00.000Z"}}} | — | ok | — | nothing pending: no run is due |
| SM10 | cost-guard | {"costGuard":{"mode":"monitor","status":"tripped","reason":null,"checkedAt":"2026-10-26T02:00:00.000Z","metrics":{"r2ClassA":{"percent":207.81,"status":"tripped"},"r2ClassB":{"percent":4.05,"status":"ok"}}}} | — | warn | tripped: r2ClassA 207.81% | a tripped guard is degraded, not failed |
| SM10 | cost-guard | {} | costGuard | absent | — | off (COST_GUARD unset): not listed |
| SM10 | identity-links | {"identityLinks":{"lastRun":{"ok":false,"status":"failed","at":"2026-10-26T02:00:00.000Z","durationMs":10,"error":"roster read failed"}}} | — | failed | roster read failed | the last run failed |
| SM10 | identity-backfill | {"identityBackfill":{"lastRun":{"ok":true,"status":"complete","at":"2026-10-20T01:23:00.000Z","durationMs":10}}} | — | ok | — | a finished backfill is not due again |
| SM10 | identity-backfill | {} | identityBackfill | absent | — | off (IDENTITY_BACKFILL unset): not listed |
| SM10 | retention | {"retention":{"mode":"dry-run","status":"failed","reason":null,"lastRun":{"at":"2026-10-26T02:00:00.000Z","mode":"dry-run","status":"failed","reason":null,"error":"listing failed"}}} | — | failed | listing failed | the last run failed |
| SM10 | retention | {"retention":{"mode":"dry-run","status":"ok","reason":"evidence-missing","lastRun":{"at":"2026-10-26T02:00:00.000Z","mode":"dry-run","status":"ok","reason":"evidence-missing","error":null}}} | — | warn | evidence-missing | a dry run with errors |
| SM10 | retention | {"retention":{"mode":"dry-run","status":"overrun","reason":null,"lastRun":{"at":"2026-10-26T02:00:00.000Z","mode":"dry-run","status":"overrun","reason":null,"error":null}}} | — | warn | overrun | a dry run that ran out of time |
| SM10 | sre-agent | {"sreAgent":{"mode":"live","status":"ok","lastRun":{"at":"2026-10-26T02:00:00.000Z","status":"ok","verdicts":["explained","inconclusive"]}}} | — | warn | inconclusive | a diagnosis the agent could not decide |
| SM10 | sre-agent | {"sreAgent":{"mode":"live","status":"failed","reason":"model call failed","lastRun":{"at":"2026-10-26T02:00:00.000Z","status":"failed","reason":"model call failed"}}} | — | failed | model call failed | the last tick failed |
| SM10 | sre-agent | {"sreAgent":{"mode":"off"}} | — | absent | — | off (SRE_AGENT unset or off): not listed |
| SM10 | kip-pages | {"kipPages":{"revision":"authors@1","lastRun":null}} | — | unknown | no run yet | on, before the first run |
| SM18 | kip-pages | {"kipPages":null} | — | unknown | could not be read | last-run.json unreadable |
| SM18 | digest | {"digest":null} | — | unknown | did not answer | the digest object did not answer while DIGEST_ENABLED is on |
| SM18 | cost-guard | {"costGuard":null} | — | unknown | did not answer | the cost guard object did not answer |
| SM18 | sre-agent | {"sreAgent":{"mode":"live","status":"unknown","reason":"reading state.json failed: boom","lastRun":null}} | — | unknown | reading state.json failed | state.json unreadable |
| SM18 | publication | {"lastRun":"garbage","sources":42} | — | unknown | no run yet | a record of the wrong type counts as missing |
| SM18 | identity-links | {"identityLinks":{"lastRun":{"ok":true,"status":"ok","at":"not a date"}}} | — | unknown | no run yet | an unreadable time is not a run |
<!-- test-plan:end -->

- SM11: Given `GET /health` → the response has `access-control-allow-origin: *`; `POST /run` and other routes do not. Evidence: Worker unit test.

- SM23: Given a built page whose inline script or inline event handler names a URL other than the two `/health` URLs, absolute or protocol-relative → `auditSite` reports it. Evidence: unit test.

### Failure and retry
- SM12: Given a gate naming a row that does not exist, or a name that more than one row carries → the docs build fails naming the node and the row(s). Evidence: unit test.
- SM13: Given `/health` unreachable, a non-2xx answer, or invalid JSON → the map still renders from build data, every node shows unknown, and the header says `/health` could not be read and when it was tried. Evidence: unit test (DOM, stubbed fetch).
- SM14: Given `/health` that has no `components` (a Worker deployed before rule 7, today's Prod) → nodes show n/a and the header says the Worker does not report components; nothing is guessed from other fields. Evidence: unit test.
- SM15: Given a `components` id that no node binds → it is listed in the detail area as "not on the map" so drift is visible, and the test of SM3 fails for ids that the repository's Worker can emit but no node binds. Evidence: unit test.
- SM16: Given a build with no `v*` tag reachable (a fork, a shallow clone) → the changes section says no release tag was found; the build does not fail. Evidence: unit test.
- SM17: Given a fetch for Dev still pending when the reader switches to Prod → only the Prod answer is applied. Evidence: unit test (stubbed fetch).
- SM18: Given a job whose state is missing or unreadable → its entry is `unknown` with a reason, and `/health` still answers 200. Evidence: Worker unit test.

### Budget
- SM19: [measure] The built page, both locales, stays under 300 KB each uncompressed (limit chosen against the current overview page; measured value in the PR; command `bun run docs:build` then `wc -c`).
- SM20: [measure] A page view costs one `GET /health` per environment shown, and `/health` performs no R2 operation for `components` (Workers requests only; measured with the Worker's request log over 10 page loads).
  Measured on Dev on 2026-10-27 09:12–09:14 UTC with Workers Logs (Observability, last hour grouped by trigger and message): 10 loads of the zh-Hant page made 10 `GET /health` and nothing else reached the Worker in that hour. Each load fetched `/health` once (browser resource timing: 1). The 10 requests made 80 `r2_get` (8 per request) and no R2 write; these are the body's existing record reads, since `healthComponents` takes the built body and makes no I/O.

### Observability
- SM21: [deploy] After deployment, the Dev page shows the live `/health` read time and at least one component per job that Dev runs, and the Prod page shows Prod's 26 (± changes) live components.
- SM22: [deploy] When a job fails on Dev (the Spec 027 fault drill), the map shows it failed on the next page load, with the same reason as `/health`.
  Checked on Dev on 2026-10-26: the Spec 027 drill `throw-20261026T0929Z` (graded `pass`) failed the kip-pages runs `kip-pages-2026-10-26T09-29-59-338Z` and `kip-pages-2026-10-26T09-35-02-078Z`; `/health` `components` gave `kip-pages` `failed`, "cwiki.apache.org answered 503" (cwiki itself answered 302, so the drill caused it), and the Dev map loaded at 13:16 UTC showed the kip-pages steps failed with the same reason.

### Private ops site (slice 3)
- SM24: [pending] Given a docs build → `dist/ops-site` has the system map page in en and zh-Hant and no other docs page; `dist/docs-site` has no system map page, no `{{map:system}}` output and no `href` to a system map page; `auditSite` passes on both. Evidence: unit test.
- SM25: [deploy] After the first `main` push with slice 3, the `deploy-ops` job deploys to `oss-knowledge-base-ops` (or skips with a notice while the project is missing), and the docs site's old map URL `/zh-Hant/system-map` answers 404.
- SM26: [deploy] Without an Access session, `https://oss-knowledge-base-ops.pages.dev/zh-Hant/system-map` and one `<hash>.oss-knowledge-base-ops.pages.dev` deployment URL answer a redirect to the Access sign-in page, never the map (checked with `curl -sI`).
- SM27: [deploy] After the owner signs in with a one-time PIN, the ops map reads Dev's and Prod's `/health` as before (SM21 on the new origin).

## Slices

1. **Gates and the page from build data** (SM1–SM8, SM12–SM17, SM19, SM23): rule 1–6,
   10–15; live status shows n/a until slice 2 because no `/health` has
   `components`. No Worker change.
2. **`/health` components and CORS** (SM9–SM11, SM18, SM20–SM22): rules 7–9.
   Merged off is not possible for an additive field; it ships on Dev with the
   next `main` deploy and on Prod with the next release tag (owner approval).
3. **Private ops site** (SM24–SM27): rules 17–19, decision 5 as amended.
   Order: the owner creates the Pages project and both Access applications
   first (rule 19), then the slice merges, so the map is never served on a
   public ops domain. Starts after PR #174 (docs site SRE agent page) merges,
   because both change `scripts/docs-site/generate.ts` and the docs pages.

## Non-goals

- Metrics, charts or logs copied from Cloudflare.
- Alerts or notifications (owner: stalls must show in the UI; no push).
- Per-viewer state ("since last visit").
- Access control for `/health` or the repository (decision 5, amended): both stay public.
- Components outside this repository's deployments (GitHub itself, Apache
  services) beyond what `system.json` already names as sources.
