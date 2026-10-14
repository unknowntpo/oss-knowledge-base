# Spec 021: Overdue daily publication visible

Status: Draft 2026-10-14 (implemented in the same PR; design delegated, issue #64, gardening G66)
Date: 2026-10-14
Traceability: enforced
Builds on: Spec 010, Spec 011, Spec 018

## Intent

The maintainer (and any reader) can tell from the page that today's
publication did not arrive, without waiting for the 27 h stale mark, and
without a warning on a day that ran normally. Spec 018 left this open: for
three hours after a missed or failed daily run the topbar read "Updated 24–26
h ago" with live styling (Spec 018 Known limit 1; the owner's rule is that a
stall shows in the UI, with no push alert).

## Evidence

- Publication runs once a day: Dev Cron `7 22 * * *`, Prod `37 22 * * *`
  (Spec 018 T1). A failed run is retried after 10, 30 and 60 min; nothing is
  written to R2 by a run that fails, so the page cannot see the failure in
  `/api/feed`; it is only in the publisher's `/health`.
- A release's `generatedAt` is the time its run was triggered
  (`materializedAt`: the Cron's scheduled time, or the alarm time of a
  follow-up, or the time of a `POST /run`), and every successful run
  publishes a release, also when nothing changed upstream
  (`apps/data-publisher-worker/src/pipeline.ts`). So the next Cron run is due
  at most 24 h after the `generatedAt` the page already has.
- A run has 15 minutes (the alarm limit, Spec 009); a new release reaches a
  browser at most 150 s later (`max-age=30, stale-while-revalidate=120`).
- The page loads `/api/feed` once (`apps/web/src/App.vue`), so a tab left
  open keeps yesterday's `generatedAt` after a normal run.

## Example

Captured 2026-10-14T01:43:30Z.

```json
// Dev /api/feed metadata.manifest
{ "releaseId": "2026-10-13T22-07-09-000Z", "generatedAt": "2026-10-13T22:07:09.000Z" }
// Dev /health
{ "running": false, "scheduled": false, "followUp": null,
  "lastRun": { "ok": true, "completedAt": "2026-10-13T22:07:09.000Z", "pollTruncated": false } }
// Prod /api/feed metadata.manifest.generatedAt (bootstrap snapshot)
"2026-08-25T08:29:41.122Z"
```

If the Dev run of 2026-10-14 does not publish, the topbar pill reads (UTC):

| Browser clock | Pill (en / zh-Hant) | Class |
| --- | --- | --- |
| 10-14 22:07:09 (the run is due) | Updated 24 h ago / 資料更新於 24 小時前 | `is-live` |
| 10-14 22:37:09 (a run and a first retry would have landed) | Updated 24 h ago | `is-live` |
| 10-14 22:37:10 | Daily run late · 24 h ago / 今日更新尚未完成 · 24 小時前 | `is-overdue` |
| 10-15 01:07:09 (27 h) | Daily run late · 27 h ago | `is-overdue` |
| 10-15 01:07:10 | Data may be out of date · 27 h ago / 資料可能過期 · 27 小時前 | `is-stale` |

Prod at capture time: "Data may be out of date · 49 d ago", `is-stale`, as
before this spec.

## Simplification review

1. **Question every requirement.**
   - The overdue state: the maintainer, who must see a missed run on the
     page (issue #64).
   - The 30-minute allowance: the same maintainer, who must not be warned
     while a normal run is still writing.
   - The re-read of an open tab: without it, every tab left open overnight
     would show the warning after a normal run — a false alarm each day.
   - The narrow-screen pill: Spec 011's reader on a phone; an overdue run is
     the first three hours of a stall.
2. **Delete.**
   - A publisher field for the last run's outcome or the next expected run
     in `/api/feed`. `/api/feed` is read from R2; a failed run writes
     nothing there, and writing its outcome would be a per-run R2 Class A
     write (and a failed conditional PUT is also Class A,
     `docs/runbooks/cloudflare-data-publisher.md`). A service binding from
     Pages to the publisher's `/health` would add a second failure domain
     to every Feed read. A run the platform kills records nothing at all,
     and the age rule covers it (Spec 011 made the same choice).
   - The Cron time on the page (Dev 22:07, Prod 22:37): `generatedAt` plus
     one cadence already is the next run's time, for either environment.
   - Covering all three retries in the allowance: they end 2 h 55 min after
     the Cron, which is the stale grace itself; there would be no overdue
     window left. A run that failed and is waiting for its second retry is
     late, and saying so is true.
   - Polling `/api/feed` every minute from an open page: one read when the
     state is about to change is enough.
   - A separate text for "failed" versus "not started": the page cannot tell
     them apart.
3. **Simplify.** One more threshold in `apps/web/src/freshness.ts`
   (`OVERDUE_AFTER_MS` = cadence + allowance), one state field instead of the
   `stale` boolean, one text key, one CSS class.
4. **Shorten the cycle.** The boundaries are a generated table (below); the
   open-tab behaviour runs in Playwright with a controlled clock in seconds.
5. **Automate last.** Nothing added.

## Behavior

1. The page takes the next daily run to be due `PUBLICATION_CADENCE_MS`
   (24 h) after `metadata.manifest.generatedAt`. No time of day is
   configured or hard-coded.
2. `PUBLICATION_ALLOWANCE_MS` is 30 minutes: a run at its 15-minute limit
   plus 150 s of caches (17.5 min), or a run that fails within about two
   minutes and succeeds on its first retry 10 min later. Until
   `OVERDUE_AFTER_MS` (24 h 30 min) the pill is unchanged (Spec 010).
3. Above `OVERDUE_AFTER_MS` and up to `STALE_AFTER_MS` (27 h) the pill has
   the class `is-overdue` (not `is-live`, not `is-stale`) and reads "Daily run
   late · {n} h ago" / "今日更新尚未完成 · {n} 小時前".
4. Above `STALE_AFTER_MS` nothing changes: `is-stale` and Spec 010's texts.
   `metadata.stale === true` still gives `is-stale`.
5. Before an open page's pill enters the overdue or the stale state, the
   page reads `/api/feed` once more and uses the release it gets. If that
   read fails, the loaded Feed stays on screen and the warning shows. A read
   that has not answered delays the warning by at most one minute.
6. At 420 px and below the pill is shown for `is-overdue` as it is for
   `is-stale` (wrapped, inside the top bar), and stays hidden while fresh.
7. The digest and review-queue freshness lines are unchanged.

## Test plan

Generated from `apps/web/test/publication-overdue.cases.ts` by
`bun run docs:test-plan`; the unit tests run exactly these rows.

<!-- test-plan:start apps/web/test/publication-overdue.cases.ts -->
| id | case | generatedAt | now | en | zh | state |
| --- | --- | --- | --- | --- | --- | --- |
| O1 | one second before the next run is expected | 2026-10-13T22:07:09Z | 2026-10-14T22:07:08Z | Updated 23 h ago | 資料更新於 23 小時前 | fresh |
| O1 | the next run starts | 2026-10-13T22:07:09Z | 2026-10-14T22:07:09Z | Updated 24 h ago | 資料更新於 24 小時前 | fresh |
| O1 | the run is at its 15-minute limit | 2026-10-13T22:07:09Z | 2026-10-14T22:22:09Z | Updated 24 h ago | 資料更新於 24 小時前 | fresh |
| O1 | exactly the allowance | 2026-10-13T22:07:09Z | 2026-10-14T22:37:09Z | Updated 24 h ago | 資料更新於 24 小時前 | fresh |
| O2 | one second past the allowance | 2026-10-13T22:07:09Z | 2026-10-14T22:37:10Z | Daily run late · 24 h ago | 今日更新尚未完成 · 24 小時前 | overdue |
| O2 | the second retry is waiting | 2026-10-13T22:07:09Z | 2026-10-14T23:30:00Z | Daily run late · 25 h ago | 今日更新尚未完成 · 25 小時前 | overdue |
| O2 | exactly 27 h | 2026-10-13T22:07:09Z | 2026-10-15T01:07:09Z | Daily run late · 27 h ago | 今日更新尚未完成 · 27 小時前 | overdue |
| O3 | 27 h 1 s: stale, as before | 2026-10-13T22:07:09Z | 2026-10-15T01:07:10Z | Data may be out of date · 27 h ago | 資料可能過期 · 27 小時前 | stale |
| O3 | the Prod bootstrap snapshot today | 2026-08-25T08:29:41.122Z | 2026-10-14T01:43:30Z | Data may be out of date · 49 d ago | 資料可能過期 · 49 天前 | stale |
| O4 | Prod's Cron minute (22:37), at the allowance | 2026-10-13T22:37:00Z | 2026-10-14T23:07:00Z | Updated 24 h ago | 資料更新於 24 小時前 | fresh |
| O4 | Prod's Cron minute (22:37), one second past | 2026-10-13T22:37:00Z | 2026-10-14T23:07:01Z | Daily run late · 24 h ago | 今日更新尚未完成 · 24 小時前 | overdue |
| O5 | release from a catch-up run at 22:12: counted from that release | 2026-10-13T22:12:09Z | 2026-10-14T22:42:09Z | Updated 24 h ago | 資料更新於 24 小時前 | fresh |
| O5 | release from a catch-up run at 22:12, one second past | 2026-10-13T22:12:09Z | 2026-10-14T22:42:10Z | Daily run late · 24 h ago | 今日更新尚未完成 · 24 小時前 | overdue |
<!-- test-plan:end -->

Step-based scenarios run as E2E tests in
`apps/web/e2e/publication-overdue.spec.ts` (fixture release
2026-08-25T12:00:00Z, controlled clock):

| ID | Scenario | Expected |
| --- | --- | --- |
| O6 | Page opened 30 s before the overdue mark, clock advances 60 s, no new release | "Updated 24 h ago" `is-live` becomes "Daily run late · 24 h ago" `is-overdue`, without a reload |
| O7 | Same, but `/api/feed` now serves a release generated 24 h after the loaded one | "Updated 30 min ago", `is-live`; the pill's class never changed |
| O8 | Same, but `/api/feed` now answers 503 | the overdue pill; one failed read; both Feed cards still shown |
| O9 | Widths 320 and 375, en and zh-Hant; clock at the overdue mark, then 1 s past | hidden; then visible with the overdue text, inside the top bar, not overlapping, not clipped |
| O10 | Open page from 30 s before the overdue mark to 10 min past the stale mark | `/api/feed` read once on entering overdue and once on entering stale; none in between or after |

## Acceptance

### Behavior
- O1: from the moment the next run is due until 30 minutes later the pill
  reads the plain age ("Updated 24 h ago") and is not overdue → evidence:
  generated unit rows.
- O2: from 24 h 30 min 1 s to exactly 27 h the pill reads "Daily run late
  · {n} h ago" / "今日更新尚未完成 · {n} 小時前" with state `overdue` →
  evidence: generated unit rows.
- O3: at 27 h 1 s and for the Prod bootstrap snapshot the state is `stale`
  with Spec 010's texts → evidence: generated unit rows.
- O4: the overdue mark is the cadence plus the allowance and precedes the
  stale mark; a release at Prod's Cron minute, or at any other time, gets
  the same states at the same ages → evidence: unit test O4 and rows.
- O6: an open page turns overdue without a reload → evidence: E2E O6.
- O9: at 320 and 375 px, in both locales, the overdue pill is visible and
  fully inside the top bar, and hidden up to the overdue mark → evidence:
  E2E O9.

### Failure and retry
- O5: a release published by a catch-up, retry or manual run is counted from
  its own `generatedAt` (the warning is then later than the Cron by that
  offset; see Known limits) → evidence: generated unit rows.
- O7: a page left open across a normal run shows the new release's age and
  never the overdue warning → evidence: E2E O7.
- O8: when the re-read fails, the Feed stays and the overdue warning shows
  → evidence: E2E O8.

### Budget
- O10: an open page adds at most two `/api/feed` reads per loaded release
  (entering overdue, entering stale) and none per minute; no publisher
  change, no R2 write → evidence: E2E O10.

### Observability
- O11: [deploy] on Dev at 1280 px and 375 px,
  `bun run verify:ui -- --target dev --at +24h31m` shows `.demo-pill` with
  `is-overdue` and the overdue text, and `--at +24h30m` shows `is-live`; with
  the real clock on a day whose run published, the pill is `is-live`.

## Known limits

1. **After a follow-up or manual release the warning is late by its
   offset.** The page counts from the release it has. A release from a
   catch-up at 22:12 moves the overdue mark by 5 minutes; one from the last
   retry (up to 2 h 55 min after the Cron) or from a `POST /run` at another
   time of day moves it by that much, and the next day's missed run is then
   first shown later, at worst by the stale pill at 27 h after that release.
   It is never early. Closing this needs the Cron tick's time in the Feed
   manifest (a contract change, gardening G66).
2. **A run that published while one source failed is not shown.** The data
   did update; the failed source is in `/health` `lastRun.sources` only.
3. **CI still does not check the daily run** (Spec 018 Known limit 2).
4. **A wrong browser clock** moves the marks, as in Spec 010.

## Non-goals

- Push alerts (Spec 011).
- Showing `/health` (`lastRun.ok`, `followUp`) on the page.
- The digest and review-queue freshness rules.
- Changing the stale mark, the retry schedule, or the publisher.
