# Spec 030: Project activity trend on This week

Status: Draft (2026-10-24; awaiting the owner decisions in [Owner decisions needed](#owner-decisions-needed); nothing implemented)
Date: 2026-10-24
Traceability: enforced
Builds on: Spec 014 (This week layout, Behavior 27, the "Counts" design decision), Spec 019 (the profile's "活動趨勢" chart, amendment (5), W56–W65; the activity log; W10, W18, W29), Spec 022 (review month objects), Spec 023 (data tokens DS4–DS6), Spec 024 (dark theme DM4–DM8), Spec 026 (cost guard)

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
35-day count of 2026-10-13 (2,248 rows, about 1,950 a month). Slice 1 replaces
every estimate with counts from the stores (PT13).

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
   Activity series count rows by source, counting a Jira issue once across
   months (Spec 019 rule). They are counts of events, not of people.
3. **Gate.** The endpoint and the card are behind a new flag `PROJECT_TREND`,
   unset everywhere at merge. With the flag unset, the endpoint returns 404
   and the card is absent. The flag requires `GITHUB_REVIEWS` and
   `PEOPLE_ACTIVITY` data on the same environment.
4. **Placement.** On This week, the card sits directly below `ul.digest-stats`
   and the `.digest-lag` line, before the highlights. Spec 014 Behavior 27's
   order becomes "headline, window label and stats, activity trend card, up to
   3 highlights, …". The card is fetched separately from `/api/digest`. A
   no-digest or unavailable digest state does not show the card.
   *(Decision 1.)*
5. **Compact card.** It has the title 「專案活動趨勢」, the 12 monthly bars
   oldest to newest, and plot height ≤ 96 px. There are no axis labels except
   the first and last month, and no totals written on the bars. The current
   month carries the label 「進行中 · 至 M/D」 and a dashed outline
   (`--data-stroke-width`, the series stroke), not a new colour. Hatched lanes
   appear when any series is unrecorded. A button 「查看完整趨勢」 expands it.
6. **Full view.** Expanding renders the profile's `PersonActivityChart` in
   project mode: the stacked up series per decision 2, no down series, the
   legend, the "尚未記錄" band and lanes, the tooltip with partial-start notes,
   "以表格檢視", and the collapsed 「資料範圍：…」 line from `coverage[].from`.
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

Every item is `[pending]` until the owner decisions are made and slice 1
lands; slice 1 removes the tags it covers.

### Behavior
- PT1: [pending] given the activity fixture (reviews 2025-11 … 2026-10, activity from 2026-09-10), `GET /api/activity?projectId=apache-kafka` returns 12 months where `reviews` equals the sum of non-bot review rows per UTC month and `github`/`jira`/`mail` equal the per-source row counts, a Jira issue in two months counted once → case rows.
- PT2: [pending] given the same fixture, months before 2026-09 have `github`, `jira` and `mail` `null` (never 0), and `coverage` names `github-reviews` from 2025-11-01 and the activity log from 2026-09-10 → case rows.
- PT3: [pending] given `PROJECT_TREND` unset, `/api/activity` returns 404 and This week renders exactly as before (no `.project-trend` element, no request to `/api/activity`) → function and E2E test.
- PT4: [pending] given the flag on and a digest, This week shows in order `.digest-stats`, `.project-trend`, `.digest-highlights` → E2E test.
- PT5: [pending] the compact card shows 12 bars, the first and last month labels, the current month labelled 「進行中 · 至 10/24」 at a controlled clock of 2026-10-24, and hatched lanes for the three activity series in 2025-11 … 2026-08 → component test.
- PT6: [pending] pressing 「查看完整趨勢」 shows the full chart with no down series, the legend, "以表格檢視", and 「資料範圍：GitHub 審查 11/1 起 · GitHub 留言與 PR、Jira、dev@ 9/10 起」, and sends no second request → component test.
- PT7: [pending] the 2026-09 tooltip says the activity series count only from 9/10, and a null cell in the table has class `is-unrecorded` → component test.
- PT8: [pending] every bar fill resolves to a `--data-*` token with `color-mix` after a plain fallback, the outline is 1.2 px, and no new custom property is added (DS3, DS6, DS10 gates stay green) → existing design-system tests.

### Failure and retry
- PT9: [pending] given one review month unreadable, the response lists it in `unavailableMonths`, its `reviews` is `null`, the other months are present, and the card shows 「<月份> 資料暫時無法取得」 → case row and component test.
- PT10: [pending] given `/api/activity` answers 503 or fails, This week still renders the digest unchanged and the card shows one line 「活動趨勢暫時無法取得」, with no retry loop → component and E2E test.
- PT11: [pending] given a store's `state.json` missing (the source never recorded on this environment), its series is `null` in every month with coverage `not-recorded`, and the card is hidden if no series is recorded → case rows.
- PT12: [pending] given two requests within 10 minutes on one isolate, the second makes 0 R2 reads, and a failed read is not cached (W29 rule) → function test.

### Budget
- PT13: [pending] cold request for Kafka: at most 26 R2 Class B reads, 0 Class A, parsed bytes ≤ 16 MB (the Kafka profile read measured 11.6 MB), and a response ≤ 4 KB uncompressed; measured read-only by `measure:people` in project mode, which also replaces the Example's estimates.
- PT14: [pending] worst case a month: 3,000 cold isolates × 26 reads = 78,000 Class B (0.8 % of the 10 M allowance), 0 Class A, $0 against the $5 overage cap; stated in the slice 1 PR.

### Observability
- PT15: [pending] the full view shows the store update time from `until`; with `until` older than 48 h the card shows the Spec 014 lag line style 「活動資料更新於 M/D」 → component test.
- PT16: [pending] after the Dev enable PR, `bun run verify:ui --target dev` captures `/#/kafka/` at 375 and 1280 px with the card and the expanded view, both themes.

## Test plan

Slice 1 adds the case file `apps/web/test/project-trend.cases.ts` (it does
not exist yet). `bun run docs:test-plan` will then render it here between
test-plan markers. Planned rows:

| id | case | input | expected |
| --- | --- | --- | --- |
| PT1 | sums per month | fixture reviews and activity | per-source counts; Jira issue once |
| PT1 | bots excluded | rows by `dependabot`, a `[bot]` login | not counted |
| PT2 | before activity coverage | 2025-11 … 2026-08 | activity series `null` |
| PT2 | partial first month | 2026-09 | counts from 9/10, partial note |
| PT9 | one month unreadable | 2026-03 review month corrupt | `reviews: null`, `unavailableMonths: ["2026-03"]` |
| PT11 | store absent | no activity `state.json` | `not-recorded`, all `null` |
| PT11 | nothing recorded | both absent | card hidden |

## Owner decisions needed

1. **Placement.** (a) A compact card below the headline stats, before the
   highlights, with an in-place expand. (b) A full-width block at the bottom,
   after routine. (c) Its own route `/#/kafka/activity`, linked from the
   stats. *Recommended: (a)*. It amends Spec 014 Behavior 27 and needs the
   owner's mockup review first (visual-taste rule).
2. **Series.** (a) Reviews, GitHub PRs and comments, Jira, dev@, stacked.
   (b) Reviews and GitHub only, as on a GitHub profile. (c) Reviews only in
   the compact card (the one 12-month series), all four in the full view.
   *Recommended: (a)*. It matches "the whole project", and the lanes show
   coverage. Choose (c) if the 9/10 step still reads as growth in the mockup.
3. **Up/down semantics.** (a) Up only, because project reviews given equal
   reviews received. (b) Up: activity; down: reviews (contribution versus
   review load). (c) Up: PRs opened; down: PRs merged. *Recommended: (a)*.
   (b) and (c) need new semantics and labels the owner has not asked for.
4. **Uneven coverage.** (a) As on the profile: per-series hatched lanes, the
   "尚未記錄" band only where every series is unrecorded, partial-start
   tooltip, and the footer range line. (b) Additionally, a vertical marker at
   9/10 labelled 「PR 與留言自此記錄」. *Recommended: (a) plus the (b) marker
   in the full view only*, because the compact card has no room for text.
5. **DataFusion.** (a) Not in v1: no This week digest, and over the parse
   budget. (b) Later, with a stored per-month project summary written by the
   jobs (a new R2 key, +1 Class A a day per job). *Recommended: (a)*. Revisit
   when DataFusion gets a digest or G75 is fixed.
6. **New public surface.** (a) A new endpoint `GET /api/activity?projectId=`,
   flag-gated, `noindex`, cached 5 minutes, Dev only at first. (b) Add a
   `trend` field to `/api/digest`, which mixes sources and breaks Spec 014's
   one-source rule. (c) Add it to `/api/people`, which today is a light
   status call. *Recommended: (a)*. It is a new public URL with aggregated
   counts of public upstream activity, so it needs the owner's explicit
   approval, and again before Prod.
7. **Unit.** (a) Events (reviews, comments, messages). (b) Distinct active
   people per month. *Recommended: (a)* for v1. (b) is a different question
   (contributor base) and needs its own owner.

## Non-goals

- A weekly period, a down axis, year-over-year comparison, or rankings.
- History before each store's `coverageFrom`, and KIP page counts.
- DataFusion (decision 5), and Prod before the stores and the digest run there.
- Any change to the digest object, its counts, or the publication.
