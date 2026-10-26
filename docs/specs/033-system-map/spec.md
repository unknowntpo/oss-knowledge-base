# Spec 033: System map

Status: Accepted (slice 1 implemented: SM1–SM8, SM12–SM17, SM23; SM19 measured; slice 2 items SM9–SM11, SM18, SM20–SM22 pending; owner decisions 2026-10-26: decisions 1–5 below)
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

Observable outcome: one page on the docs site, the **system map**, that shows
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
| Dev, data flow | 60 components (`rq-trig` and `access` not live); `j-people` red (failed, reason from `kip-pages`); `cost` yellow (warn); `manual`, `j-rq`, `verify` and `sre-drill` carry "manual ⚠" |
| Dev, list | groups Failed (2: `j-people`, `src-asf`), Warn, Manual (4), OK, No status |
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
5. **Health binding.** A node may declare `"health": "<component id>"` naming
   an entry of `/health` `components` (rule 7). Several nodes may bind the
   same id. A node without a binding has no live status (shown as n/a).
   Needed by: rule 9.
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
   stale) instead of new ones. Needed by: decision 2.
8. **CORS.** `GET /health` answers with `access-control-allow-origin: *`. No
   other route changes. Needed by: rule 9 (the page runs on another origin).
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
- SM9: [pending] Given Dev state with `kipPages.lastRun.status: "failed"` → `/health` `components` has `{ id: "kip-pages", status: "failed" }` with the run's error as reason. Evidence: Worker unit test.
- SM10: [pending] Given every job's state → `components` has one entry per job that is on, with the status rules of Behavior 7, and none for a job that is off. Evidence: Worker unit test (case file).
- SM11: [pending] Given `GET /health` → the response has `access-control-allow-origin: *`; `POST /run` and other routes do not. Evidence: Worker unit test.

- SM23: Given a built page whose inline script or inline event handler names a URL other than the two `/health` URLs, absolute or protocol-relative → `auditSite` reports it. Evidence: unit test.

### Failure and retry
- SM12: Given a gate naming a row that does not exist, or a name that more than one row carries → the docs build fails naming the node and the row(s). Evidence: unit test.
- SM13: Given `/health` unreachable, a non-2xx answer, or invalid JSON → the map still renders from build data, every node shows unknown, and the header says `/health` could not be read and when it was tried. Evidence: unit test (DOM, stubbed fetch).
- SM14: Given `/health` that has no `components` (a Worker deployed before rule 7, today's Prod) → nodes show n/a and the header says the Worker does not report components; nothing is guessed from other fields. Evidence: unit test.
- SM15: Given a `components` id that no node binds → it is listed in the detail area as "not on the map" so drift is visible, and the test of SM3 fails for ids that the repository's Worker can emit but no node binds. Evidence: unit test.
- SM16: Given a build with no `v*` tag reachable (a fork, a shallow clone) → the changes section says no release tag was found; the build does not fail. Evidence: unit test.
- SM17: Given a fetch for Dev still pending when the reader switches to Prod → only the Prod answer is applied. Evidence: unit test (stubbed fetch).
- SM18: [pending] Given a job whose state is missing or unreadable → its entry is `unknown` with a reason, and `/health` still answers 200. Evidence: Worker unit test.

### Budget
- SM19: [measure] The built page, both locales, stays under 300 KB each uncompressed (limit chosen against the current overview page; measured value in the PR; command `bun run docs:build` then `wc -c`).
- SM20: [measure] A page view costs one `GET /health` per environment shown, and `/health` performs no R2 operation for `components` (Workers requests only; measured with the Worker's request log over 10 page loads).

### Observability
- SM21: [deploy] After deployment, the Dev page shows the live `/health` read time and at least one component per job that Dev runs, and the Prod page shows Prod's 26 (± changes) live components.
- SM22: [deploy] When a job fails on Dev (the Spec 027 fault drill), the map shows it failed on the next page load, with the same reason as `/health`.

## Slices

1. **Gates and the page from build data** (SM1–SM8, SM12–SM17, SM19, SM23): rule 1–6,
   10–15; live status shows n/a until slice 2 because no `/health` has
   `components`. No Worker change.
2. **`/health` components and CORS** (SM9–SM11, SM18, SM20–SM22): rules 7–9.
   Merged off is not possible for an additive field; it ships on Dev with the
   next `main` deploy and on Prod with the next release tag (owner approval).

## Non-goals

- Metrics, charts or logs copied from Cloudflare.
- Alerts or notifications (owner: stalls must show in the UI; no push).
- Per-viewer state ("since last visit").
- Access control for the page (decision 5); revisit if `/health` stops being public.
- Components outside this repository's deployments (GitHub itself, Apache
  services) beyond what `system.json` already names as sources.
