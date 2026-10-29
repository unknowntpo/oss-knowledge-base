# Spec 030: Project activity trend on This week

Status: Partially implemented (owner decisions 2026-10-24, [Owner decisions](#owner-decisions)); slice 1 built behind `PROJECT_TREND` (PR #141); on Dev only: the owner approved the Dev enable on 2026-10-24 ([Rollout](#rollout)); PT16 runs after that deploy; the Prod enable was approved on 2026-10-29 (decision 8) for its own PR, after the first Prod run confirms both stores; [amendment (1)](#amendment-2026-10-25-1-years-on-the-compact-axis) (2026-10-25) adds years to the compact axis
Date: 2026-10-24
Traceability: enforced
Builds on: Spec 014 (This week layout, Behavior 27, the "Counts" design decision), Spec 019 (the profile's "活動趨勢" chart, amendment (5), W56–W65; the activity log; W10, W18, W29), Spec 022 (review month objects), Spec 023 (data tokens DS4–DS6), Spec 024 (dark theme DM4–DM8), Spec 026 (cost guard)

> **Note 2026-10-25 ([Spec 032](../032-path-urls/spec.md)).** The web app
> uses path URLs now: a route written `/#/<route>` below is `/<route>` (for
> example `/#/kafka/threads` is `/kafka/threads`). Old `/#/…` links still
> land on the same page.

## Intent

The owner wants to see how active the whole Kafka project is over a year,
the way a contributor profile already shows one person's year (owner,
2026-10-24: 「因為他不只本週，但這個頁面是最適合的，我想要看到整個專案的活動趨勢」).

Observable outcome: Kafka's This week page (`/#/kafka/`) shows a compact
12-month trend card directly below the headline stats, with the current
month marked as in progress. Expanding it shows the full chart, the
"以表格檢視" table and the data range line, drawn with the same chart, colours
and "尚未記錄" hatching as the profile. Months a source did not record are
never drawn as zero.

The card is a second, separately sourced block on the page. It does not
change the digest, its 7-day window or its counts.

## Evidence

- The profile chart (Spec 019 W56–W65) is implemented on Dev:
  `apps/web/src/components/PersonActivityChart.vue`, model
  `apps/web/src/profile-chart.ts`. Nothing chart-specific is published; the
  Pages Function sums stored rows per request.
- There is no project-level aggregate anywhere. Review rows are stored per
  review in `internal/github-reviews/v1/<projectId>/<YYYY-MM>.json` (Spec
  022). Activity rows are stored per event in
  `internal/people/v1/<projectId>/<YYYY-MM>.json`. The
  `<YYYY-MM>.summary.json` objects are per identity, and nothing reads them.
- The profile reader already reads the 12 newest months of both stores for a
  project and caches each key for 10 minutes per isolate
  (`PEOPLE_INDEX_TTL_MS`, W29: at most 26 cold R2 reads). A project series
  can be summed from the same objects.
- Published digests cannot provide history. Each digest is a rolling 7-day
  window rebuilt daily on Dev since 2026-10-14, and only `current.json` is
  indexed (Spec 014).
- Both stores and the digest run on Dev only. PR #110 (open) starts recording
  reviews and the activity log on Prod, with profiles still off.

### Source coverage (Kafka, `apache-kafka`)

| Source | Store | Granularity | Recorded from | In the 12-month view (2025-11 … 2026-10) | Project aggregate today |
| --- | --- | --- | --- | --- | --- |
| GitHub reviews | `internal/github-reviews/v1/apache-kafka/<YYYY-MM>.json` | one row per review (`submittedAt` UTC month, RV12) | 2025-10-14 (backfill, RV35) | all 12 months; the chart shows 11/1 on | none |
| GitHub PRs, issues, comments | `internal/people/v1/apache-kafka/<YYYY-MM>.json`, `source: github` | one row per event (PR in its opened month) | 2026-09-10T02:45:16Z (first append − 35 days; never moves) | 2026-09 (partial) and 2026-10 | none (summary is per identity) |
| Jira issues, comments | same, `source: jira` | one row per event (issue in its last-update month) | 2026-09-10 | same | none |
| dev@ messages | same, `source: mail` | one row per message | 2026-09-10 | same | none |
| KIP pages | `internal/kips/v1/apache-kafka/authors.json` | one entry per KIP page, no month | first run: 365 days back | not monthly; not a series | none |
| Feed events | Durable Object state, 35 days; Feed releases | one entry per thread | rolling 35 days | no | none |

DataFusion has GitHub reviews and GitHub activity only, no This week digest
(`digest: false`), and its 12-month profile read already parses 23.2 MB,
above the 16 MB budget (W18, G75).

## Example

Kafka, as the card would read on 2026-10-24. Review figures for chia7712
are the Spec 019 oracle (2026-10-15). Project figures marked *estimate*
come from Spec 022's measured volume (about 17,100 review rows from
2025-10-14 to 2026-10-14, so about 1,425 a month) and the Dev activity log's
35-day count of 2026-10-13 (2,248 rows, about 1,950 a month). Slice 1 reads
no Dev object, so the estimates stay until the Dev enable PR deploys; PT16
then replaces them with the counts `/api/activity` returns on Dev.

| Month | Reviews (project) | of which chia7712 | GitHub PRs and comments | Jira | dev@ | Drawn as |
| --- | --- | --- | --- | --- | --- | --- |
| 2025-11 | ≈1,425 *estimate* | 219 | not recorded | not recorded | not recorded | reviews bar; three hatched lanes |
| 2025-12 … 2026-08 | ≈1,425 each *estimate* | 188, 157, 145, 243, 182, 227, 129, 193, 210 | not recorded | not recorded | not recorded | same |
| 2026-09 | ≈1,425 *estimate* | 278 | ≈1,350 *estimate* (from 9/10) | included in the activity estimate | included | stacked bar; tooltip "只計入 9/10 起" |
| 2026-10 (to 10/24, in progress) | ≈1,100 *estimate* | 83 to 10/15 | ≈1,500 *estimate* | included | included | stacked bar, marked "進行中 · 至 10/24" |

Footer: 「資料範圍：GitHub 審查 11/1 起 · GitHub 留言與 PR、Jira、dev@ 9/10 起」.

What the example shows:

1. At project level every review given is also received. The profile's
   mirrored "收到的審查" bar would repeat the upper bar, so it has no reader
   (decision 3).
2. The stacked bar roughly doubles at 2026-09 only because recording began on
   9/10. The coverage lanes, the tooltip note and the footer must make that
   visible, or the card reads as a growth spike (decision 4).
3. Reviews are the only series with 12 recorded months.

## Simplification review

1. **Question every requirement.**
   - The trend: the owner, for a year view of the project (Intent).
   - Compact card plus expand: the owner wants the full chart, and This week
     exists to answer "what happened in the past 7 days". A compact card keeps
     the highlights near the top.
   - Each series: reviews and GitHub activity because the owner named them
     on the profile. Jira and dev@ because Kafka discussion happens there.
     Their owner is decision 2.
   - Current month marker: without it the partial last month reads as a drop.
   - A weekly period, a down axis, DataFusion, and KIP counts have no owner
     yet. They are deleted below.
2. **Delete.**
   - No new R2 object, no new job, no stored aggregate, no change to the
     publication. The series is summed from objects the profile reader
     already reads.
   - No down axis (Example point 1).
   - No weekly toggle. The profile's 90-day weekly view answers a person's
     recent rhythm; the project question is the year.
   - No new route for the full view. It expands in place.
   - No new colour tokens and no new chart component. The profile's chart and
     `--data-*` tokens are reused.
   - No DataFusion: no This week digest, and over the parse budget.
   - No KIP series: KIP pages have no month.
   - No "active contributors" count, no year-over-year comparison, and no
     judgement words such as "declining" (Spec 019 rule).
3. **Simplify.** Use one pure function that sums the per-month indexes the
   profile reader already builds into a project series. The chart model takes
   a series list instead of deriving it from an identity's source.
4. **Shorten the cycle.** Case-file rows over the existing
   `people-activity-fixture` check the sums and the coverage nulls without a
   Worker. A component test checks the card. One E2E checks the page order.
5. **Automate last.** No new script. The `measure:people` read-only command
   gains a project mode only if PT13 needs it.

## Forces

- **The page's purpose versus the owner's wish.** This week answers "the past
  7 days" (Spec 014). A year chart above the highlights pushes them down,
  especially at 375 px. A card at the bottom keeps the purpose but hides the
  trend.
- **One data source for counts.** Spec 014's 2026-10-08 decision says "All
  counts come from one data source, and source lag is shown". The trend
  comes from different stores with different lag. It must state its own range
  and update time, and look like a separate block.
- **Uneven coverage.** Reviews cover 12 months and activity covers 1.5. A
  stacked total jumps when recording starts. Hiding unrecorded months as zero
  would be false.
- **Consistency with the profile.** The owner accepted the profile chart's
  look, hatching and footer. Reuse keeps the mental model and the tests.
- **Budget.** The account is past the 1 M Class A allowance, so every write
  is billed. A request-time sum adds no writes. Reads are cheap (Class B,
  10 M free) but the parse is bounded by 16 MB per request (W18).
- **Public surface.** Aggregated counts are derived from public upstream
  activity, but a new endpoint is a new public URL (workflow: core decision).
- **Environment.** The stores and the digest exist on Dev only, so the card
  can only appear on Dev until both reach Prod.

## Behavior

1. **Source.** A new Pages Function `GET /api/activity?projectId=<id>`
   answers `osskb.project-activity.v1`:
   `{ projectId, until, months: [{ month, reviews, github, jira, mail }],
   coverage: SourceCoverageV1[], unavailableMonths }`. Each count is an
   integer or `null` when its source did not record that month (the same
   rule as `profile-chart.ts`: `bucketEnd(month) < coverage.from` or status
   `not-recorded`). `until` is the newest store `updatedAt`. It is built from the
   same 12 newest months and `state.json` objects as `readPersonProfile`,
   through the same per-key cache. *(Decision 6: the public surface.)*
2. **Counts.** `reviews` counts review rows submitted in the UTC month by
   logins that are people (W12 bot rule), including `COMMENTED` reviews.
   As on the profile, a review by the pull request's own author (an answer
   in a review thread, W8) is not a review, so the project count equals the
   sum of every person's "reviews given".
   Activity series count rows by source, counting a Jira issue once across
   months (Spec 019 rule), in the month of its newest row. They are counts of
   events, not of people. Only months inside a store's coverage are read;
   every other month is `null`. Kafka only in v1 (`PROJECT_TREND_PROJECTS`;
   another known project is a 404, an unknown one a 400).
3. **Gate.** The endpoint and the card are behind a new flag `PROJECT_TREND`,
   unset everywhere at merge. With the flag unset, the endpoint returns 404
   and the card is absent. The flag requires `GITHUB_REVIEWS` and
   `PEOPLE_ACTIVITY` data on the same environment. The page learns the flag
   without a request of its own: where it is `"true"`, a 200 from
   `/api/digest` carries the header `x-project-trend: on` (the digest body is
   unchanged), and only then does This week ask `/api/activity`.
4. **Placement.** On This week, the card sits directly below `ul.digest-stats`
   and the `.digest-lag` line, before the highlights. Spec 014 Behavior 27's
   order becomes "headline, window label and stats, activity trend card, up to
   3 highlights, …". The card is fetched separately from `/api/digest`. A
   no-digest or unavailable digest state does not show the card.
   *(Decision 1; amendment recorded in Spec 014 Behavior 27.)*
5. **Compact card.** It has the title 「專案活動趨勢」, the 12 monthly bars
   oldest to newest, and plot height ≤ 96 px. There are no axis labels except
   the first and last month, each with its year (「2025/11」 … 「2026/10」;
   English "Nov 2025" … "Oct 2026"), a small year marker 「2026」 at each
   January inside the view (not when January is the first month, whose label
   already names the year), and no totals written on the bars. The current
   month carries the label 「進行中 · 至 M/D」 (M/D: the stores' `until`, or
   today if earlier) and a dashed outline
   (`--data-stroke-width`, the series stroke), not a new colour. Hatched lanes
   appear when any series is unrecorded. A one-line legend (the four series
   and "尚未記錄") names the colours. A button 「查看完整趨勢」 expands it.
6. **Full view.** Expanding renders the profile's `PersonActivityChart` in
   project mode: the stacked up series per decision 2, no down series, the
   legend, the "尚未記錄" band and lanes, the tooltip with partial-start notes,
   "以表格檢視", and the collapsed 「資料範圍：…」 line from `coverage[].from`.
   A dashed vertical line where the activity log starts (9/10 on Dev) is
   labelled 「PR 與留言自此記錄」 (decision 4). The opened range line also
   gives the update time from `until` and says the counts are events.
   Collapsing returns to the card. No second request is sent.
7. **Series and colours.** Reviews use the profile's `given` tokens (勿忘草
   fill, 千草 outline). GitHub uses 柳茶 / 苔, Jira 水浅葱 / 青碧, and dev@
   紅梅 / 今様. Fills are translucent `color-mix` over a plain fallback with a
   1.2 px outline (Spec 023 rules 4 and 8). The dark theme uses the existing
   dark alphas (DM4–DM6). No orange.
8. **Wording.** Labels describe counts only: no "growth", "decline",
   "inactive" or rank.
9. **Accessibility.** Both views are `svg role="img"` with an `aria-label`
   naming the range and the newest month's counts. The table is reachable by
   keyboard. There is no sideways scroll at 320 and 375 px (DM8).

## Acceptance

Slice 1 (PR #141) covers PT1–PT15; PT16 belongs to the Dev enable PR. Amendment (1) adds PT17 and PT18.

### Behavior
- PT1: given the activity fixture (reviews 2025-11 … 2026-10, activity from 2026-09-10), `GET /api/activity?projectId=apache-kafka` returns 12 months where `reviews` equals the sum of non-bot review rows per UTC month and `github`/`jira`/`mail` equal the per-source row counts, a Jira issue in two months counted once → case rows.
- PT2: given the same fixture, months before 2026-09 have `github`, `jira` and `mail` `null` (never 0), and `coverage` names `github-reviews` from 2025-11-01 and the activity log from 2026-09-10 → case rows.
- PT3: given `PROJECT_TREND` unset, `/api/activity` returns 404 and This week renders exactly as before (no `.project-trend` element, no request to `/api/activity`) → function and E2E test.
- PT4: given the flag on and a digest, This week shows in order `.digest-stats`, `.project-trend`, `.digest-highlights` → E2E test.
- PT5: the compact card shows 12 bars, the first and last month labels, the current month labelled 「進行中 · 至 10/24」 at a controlled clock of 2026-10-24, and hatched lanes for the three activity series in 2025-11 … 2026-08 → component test.
- PT6: pressing 「查看完整趨勢」 shows the full chart with no down series, the legend, "以表格檢視", the 9/10 marker 「PR 與留言自此記錄」, and 「資料範圍：GitHub 審查 11/1 起 · GitHub 留言與 PR、Jira、dev@ 9/10 起」, and sends no second request → component test (expanded view) and E2E test (the press, one request).
- PT7: the 2026-09 tooltip says the activity series count only from 9/10, and a null cell in the table has class `is-unrecorded` → component test.
- PT17: the compact card's first and last labels carry the year: at a controlled clock of 2026-10-24, zh-Hant shows 「2025/11」 and 「2026/10 · 進行中 · 至 10/24」, English "Nov 2025" and "Oct 2026 · in progress · to 10/24", and at 375 px the labels and year markers do not overlap and the page does not scroll sideways, in both themes → case rows, component test and E2E test.
- PT18: a year marker 「YYYY」 sits at each January inside the view (2026 at 2026-01 for 2025-11 … 2026-10), none when the view lies within one year or starts in January → case rows and component test.
- PT8: every bar fill resolves to a `--data-*` token with `color-mix` after a plain fallback, the outline is 1.2 px, and no new custom property is added (DS3, DS6, DS10 gates stay green) → existing design-system tests and a component test.

### Failure and retry
- PT9: given one review month unreadable, the response lists it in `unavailableMonths`, its `reviews` is `null`, the other months are present, and the card shows 「<月份>資料暫時無法取得」 → case row and component test.
- PT10: given `/api/activity` answers 503 or fails, This week still renders the digest unchanged and the card shows one line 「活動趨勢暫時無法取得」, with no retry loop → component and E2E test.
- PT11: given a store's `state.json` missing (the source never recorded on this environment), its series is `null` in every month with coverage `not-recorded`, and the card is hidden if no series is recorded → case rows.
- PT12: given two requests within 10 minutes on one isolate, the second makes 0 R2 reads, and a failed read is not cached (W29 rule) → function test.

### Budget
- PT13: [measure] cold request for Kafka: at most 26 R2 Class B reads, 0 Class A, parsed bytes ≤ 16 MB, and a response ≤ 4 KB uncompressed; measured read-only by `bun run measure:people --project` on a constructed store of Dev's volume with 12 full activity months (the worst case, a year after the first append): 26 reads, 11.1 MiB parsed, response 1,712 B, warm 0 reads (2026-10-24). The reader has no write path. Dev's real counts replace the Example's estimates after the Dev enable PR deploys (PT16).
- PT14: [measure] worst case a month: 3,000 cold isolates × 26 reads = 78,000 Class B (0.8 % of the 10 M allowance), 0 Class A, $0 against the $5 overage cap; stated in the slice 1 PR. A cold profile read in the same isolate shares the cache, so the trend adds at most the 2 `state.json` and 2 activity-month reads the profile read would not make for a reviews-only identity.

### Observability
- PT15: the full view shows the store update time from `until`; with `until` older than 48 h the card shows the Spec 014 lag line style 「活動資料更新於 M/D」 → component test.
- PT16: [pending] after the Dev enable PR, `bun run verify:ui --target dev` captures `/#/kafka/` at 375 and 1280 px with the card and the expanded view, both themes.

## Test plan

Generated from `apps/web/test/project-trend.cases.ts` (`bun run docs:test-plan`).
`apps/web/test/project-trend.test.ts` runs every row against
`readProjectActivity` over the stores of `project-trend.store.ts`.

<!-- test-plan:start apps/web/test/project-trend.cases.ts -->
| id | case | data | store | month | reviews | github | jira | mail | unavailable | coverage | card |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PT1 | reviews given by people in the month | constructed | full | 2026-01 | 22 | — | — | — | — | github-reviews from 2025-11-01; github, jira, mail from 2026-09-10 | shown |
| PT1 | a GitHub App, a `[bot]` login and a reply by the pull request's author are not reviews (23 rows stored, 20 counted) | constructed | full | 2025-11 | 20 | — | — | — | — | github-reviews from 2025-11-01; github, jira, mail from 2026-09-10 | shown |
| PT1 | a login GitHub typed `Bot` in another month of the view (no `[bot]` suffix) is not a reviewer: its untyped review is left out (24 people's rows, 23 counted) | constructed | full | 2026-02 | 23 | — | — | — | — | github-reviews from 2025-11-01; github, jira, mail from 2026-09-10 | shown |
| PT1 | activity rows by source; a `dependabot` comment is not counted; the Jira issue stored in September and October counts once, in October | recorded | full | 2026-10 | 31 | 47 | 44 | 20 | — | github-reviews from 2025-11-01; github, jira, mail from 2026-09-10 | shown |
| PT2 | a month before the activity log's coverage: activity series null, never 0 | recorded | full | 2026-08 | 29 | — | — | — | — | github-reviews from 2025-11-01; github, jira, mail from 2026-09-10 | shown |
| PT2 | the partial first month counts from 9/10 only: a message one second earlier is left out | recorded | full | 2026-09 | 30 | 112 | 58 | 39 | — | github-reviews from 2025-11-01; github, jira, mail from 2026-09-10 | shown |
| PT9 | one review month unreadable: its reviews null and listed | constructed | review-month-corrupt | 2026-03 | — | — | — | — | 2026-03 | github-reviews from 2025-11-01; github, jira, mail from 2026-09-10 | shown |
| PT9 | the other months are still present | constructed | review-month-corrupt | 2026-04 | 25 | — | — | — | 2026-03 | github-reviews from 2025-11-01; github, jira, mail from 2026-09-10 | shown |
| PT9 | one activity month unreadable: its three activity series null and listed | recorded | activity-month-corrupt | 2026-09 | 30 | — | — | — | 2026-09 | github-reviews from 2025-11-01; github, jira, mail from 2026-09-10 | shown |
| PT11 | no activity `state.json`: the three series null in every month and not recorded | constructed | no-activity | 2026-10 | 31 | — | — | — | — | github-reviews from 2025-11-01; github, jira, mail not recorded | shown |
| PT11 | neither store recorded: every count null and the card hidden | constructed | nothing | 2026-10 | — | — | — | — | — | github-reviews, github, jira, mail not recorded | hidden |
<!-- test-plan:end -->

### Compact axis (amendment (1))

Generated from `apps/web/test/project-trend-axis.cases.ts` (`bun run docs:test-plan`).
`apps/web/test/project-trend-axis.test.ts` runs every row against `trendAxis`.

<!-- test-plan:start apps/web/test/project-trend-axis.cases.ts -->
| id | case | locale | from | to | first | last | years |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PT17 | Dev's view across a year boundary: both ends name their year | zh-Hant | 2025-11 | 2026-10 | 2025/11 | 2026/10 | 2026 at 2026-01 |
| PT17 | the same view in English | en | 2025-11 | 2026-10 | Nov 2025 | Oct 2026 | 2026 at 2026-01 |
| PT18 | a view within one year has no marker | zh-Hant | 2026-03 | 2026-10 | 2026/3 | 2026/10 | — |
| PT18 | January as the first month: its label already names the year, no marker | en | 2026-01 | 2026-12 | Jan 2026 | Dec 2026 | — |
| PT18 | a January as the second month gets a marker | zh-Hant | 2025-12 | 2026-11 | 2025/12 | 2026/11 | 2026 at 2026-01 |
| PT18 | every January inside the view gets a marker | en | 2025-12 | 2027-01 | Dec 2025 | Jan 2027 | 2026 at 2026-01; 2027 at 2027-01 |
<!-- test-plan:end -->

Generated from `apps/web/test/project-trend-layout.cases.ts` (`bun run docs:test-plan`).
`apps/web/test/project-trend-layout.test.ts` runs every row against `compactLayout`.

<!-- test-plan:start apps/web/test/project-trend-layout.cases.ts -->
| id | case | from | to | width | top | marks |
| --- | --- | --- | --- | --- | --- | --- |
| PT18 | a year boundary adds the marker row above the plot | 2025-11 | 2026-10 | 343 | 16 | 2026 at slot 2, start |
| PT18 | a view within one year keeps the 4 px top | 2026-03 | 2026-10 | 343 | 4 | — |
| PT18 | January as the first month: no row, 4 px top | 2026-01 | 2026-12 | 343 | 4 | — |
| PT17 | a January in the last slot writes its year left of the line, inside the card | 2025-02 | 2026-01 | 343 | 16 | 2026 at slot 11, end |
<!-- test-plan:end -->

## Owner decisions

Decided by the owner on 2026-10-24, each as the draft recommended.

1. **Placement: a compact card below the headline stats, before the
   highlights, expanded in place** (option a). This amends Spec 014
   Behavior 27's block order; the amendment is recorded there. Rejected: a
   block at the bottom after routine (b), its own route
   `/#/kafka/activity` (c). The owner reviews the look (screenshots from
   slice 1) before the Dev enable PR (visual-taste rule).
2. **Series: four, stacked — reviews, GitHub PRs and comments, Jira, dev@**
   (option a). Rejected: reviews and GitHub only (b), reviews only in the
   compact card (c).
3. **Upward bars only** (option a): at project level reviews given equal
   reviews received. Rejected: activity up and reviews down (b), PRs opened
   up and merged down (c).
4. **Uneven coverage: the profile chart's per-series hatched "尚未記錄"
   lanes, the tooltip's partial-start notes and the footer data range; the
   full view adds a vertical marker at 9/10 labelled
   「PR 與留言自此記錄」** (a plus the (b) marker in the full view only).
5. **No DataFusion in v1** (option a): it has no This week digest, and its
   12-month read is over the parse budget (G75). Revisit when DataFusion
   gets a digest or G75 is fixed.
6. **A new public endpoint `GET /api/activity?projectId=`** behind the new
   flag `PROJECT_TREND`, `noindex`, cached 5 minutes (option a). Approved for
   Dev only; the owner approved the Dev enable on 2026-10-24 ([Rollout](#rollout)).
   The owner approved the Prod enable on 2026-10-29 (decision 8). Rejected: a `trend`
   field in `/api/digest` (b), a field in `/api/people` (c).
7. **Count unit: events** (option a), not distinct active people (b).
8. **Prod enable (2026-10-29): approved.** `PROJECT_TREND=true` in
   `apps/web/wrangler.production.jsonc` makes `/api/activity` a new public
   URL on Prod. It ships as its own PR, after the first Prod run with Spec
   022 decision 6 and Spec 019 decision 12 confirms both stores (Prod
   `/health` has `githubReviews` and `lastRun.activity`, neither with an
   error). The PR that enables the two stores on Prod does not set it.

## Amendment 2026-10-25 (1): years on the compact axis

The owner read the Dev card (2026-10-25): with only 「11月」 on the left and
「10月 · 進行中 · 至 10/24」 on the right, the 12 bars looked newest-first.
Approved fix: the two end labels carry the year (zh-Hant `YYYY/M`, as the
dates on this page are written; English the short month and the year), and a
small 「YYYY」 marker with a faint boundary line sits above the plot at each
January inside the view (Behavior 5, PT17, PT18). The marker row exists only
when a January falls inside the view, so a view within one year keeps its
height. The full view is the profile's chart (Spec 019) with its own axis,
which already labels every month (every other month when narrow) in order; it is unchanged. No data, contract,
token or colour change: the line uses `--border-strong` like the axis and the
text the existing chart label style.

## Rollout

| Step | Change | Expected |
| --- | --- | --- |
| 1 | Merge PR #141: the endpoint, the header and the card; `PROJECT_TREND` unset everywhere | Nothing changes at runtime (PT3) |
| 2 | Dev Pages: `PROJECT_TREND=true` in `apps/web/wrangler.development.jsonc` (owner approved 2026-10-24; the Dev enable PR) | After the push to `main` deploys Dev, a 200 from `/api/digest?projectId=apache-kafka` carries `x-project-trend: on`, `/api/activity?projectId=apache-kafka` answers 200 `osskb.project-activity.v1`, and `/#/kafka/` shows `.project-trend` under the stats |
| 3 | PT16 on Dev: `bun run verify:ui --target dev`; replace the Example's estimates with Dev's counts | Captures at 375 and 1280 px, card and expanded view, both themes |
| 4 | Prod: approved 2026-10-29 (decision 8). The stores go first: `GITHUB_REVIEWS=metadata@2` and `PEOPLE_ACTIVITY=log@1` on the Prod data Worker, seeded from a copy of Dev's objects (Spec 022 decision 6, Spec 019 decision 12). Then a separate PR sets `PROJECT_TREND=true` in `apps/web/wrangler.production.jsonc`, after the first Prod run shows both stores in `/health` without error | As step 2, on https://oss-knowledge-base.pages.dev after the tag that carries the PR |

Stop and roll back (remove the var, push to `main`) if This week renders
differently with the card absent, `/api/activity` answers 5xx, or the
digest answer changes beyond the header. The flag reads nothing while unset,
so rollback needs no data change.

## Non-goals

- A weekly period, a down axis, year-over-year comparison, or rankings.
- History before each store's `coverageFrom`, and KIP page counts.
- DataFusion (decision 5), and Prod before the stores and the digest run there.
- Any change to the digest object, its counts, or the publication.
