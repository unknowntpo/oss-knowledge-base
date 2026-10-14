# Spec 010: Feed freshness

Status: Accepted 2026-10-06 (workflow pilot 001); amended 2026-10-13 by Spec 018 (daily publication: stale after 27 h, days from 48 h) and 2026-10-14 by Spec 021 (between 24 h 30 min and 27 h the pill is the overdue warning)
Date: 2026-10-04
Traceability: enforced
Builds on: Spec 003, Spec 008, Spec 018

## Intent

A reader, and the maintainer, can tell from the Feed page how old the data
is, and see a warning when publication has stopped. From 2026-09-30 01:07 to
2026-10-02 02:42 development published nothing and the page still said
"Published snapshot".

## Example

Captured from development at 2026-10-03T23:35:37Z:

```json
"metadata": {
  "manifest": {
    "releaseId": "2026-10-03T23-07-13-000Z",
    "generatedAt": "2026-10-03T23:07:13.000Z",
    "entryCount": 3350
  }
}
```

`/health` reported `lastRun.completedAt` `2026-10-03T23:07:13.000Z`.
`generatedAt` is the run's scheduled start, when GitHub was read; the run
finished writing about five minutes later. It is therefore the time the data
reflects.

| Now (UTC) | Topbar (en / zh-Hant) |
| --- | --- |
| 2026-10-03 23:35:37 | Updated 28 min ago / 資料更新於 28 分鐘前 |
| 2026-10-04 01:07:13 | Updated 2 h ago / 資料更新於 2 小時前 |
| 2026-10-04 22:07:13 | Updated 23 h ago / 資料更新於 23 小時前 (a healthy daily pipeline, Spec 018) |
| 2026-10-05 02:07:14 | stale styling, "Data may be out of date · 27 h ago" |
| 2026-10-05 23:07:13 | stale styling, "Data may be out of date · 2 d ago" / 資料可能過期 · 2 天前 |

Until 2026-10-13 the publisher ran hourly and the boundary was 3 h; the
49-hour stall above would then have read "49 h ago" and now reads "2 d ago".

## Simplification review

- No API change. `metadata.manifest.generatedAt` already carries the only
  value needed. Server-computed age or a `stale` flag would be cached for up
  to 150 s (`max-age=30, stale-while-revalidate=120`) and be less accurate
  than computing in the browser.
- The stale threshold is display policy derived from the publisher's cadence:
  `STALE_AFTER_MS = PUBLICATION_CADENCE_MS + STALE_GRACE_MS` (24 h + 3 h) in
  `apps/web/src/freshness.ts`, not configuration and not an API field,
  because both environments publish at the same cadence and the page ships
  with the configuration (Spec 018 T2 holds the constant to the crons). It
  was a bare 3 h while publication was hourly.
- Days (owner of the requirement: the reader of a stalled page): from 48 h
  the age is given in days, so a week-long stall reads "7 d ago", not
  "168 h ago". Such an age is always stale, so only the stale text needs a
  days form.
- Owner of the live re-render (F3): the maintainer who leaves the page open to
  watch publication.

## Behavior

1. The topbar shows the age of `metadata.manifest.generatedAt` relative to the
   browser clock: minutes below one hour, hours below 48 hours, days from
   then on.
2. Above `STALE_AFTER_MS` (27 h: one daily publication missed, plus 3 h of
   grace for a late run and its retries, Spec 018 Behavior 2) the topbar uses
   the existing stale styling and says the data may be out of date. From
   24 h 30 min up to that mark the text and styling are Spec 021's overdue
   warning, not the plain age.
3. The label is recomputed every minute while the page is open.
4. Freshness never blocks the Feed: an unparsable or missing `generatedAt`
   shows no age, and the topbar keeps its previous "Published snapshot"
   label; a `generatedAt` in the future (clock skew) reads as "just now".

## Test plan

Generated from `apps/web/test/freshness.cases.ts` by `bun run docs:test-plan`;
the unit tests run exactly these rows. Edit the case file, not this table.
`now` is the browser clock; `—` means no freshness label.

<!-- test-plan:start apps/web/test/freshness.cases.ts -->
| id | generatedAt | now | en | zh | stale |
| --- | --- | --- | --- | --- | --- |
| F1 | 2026-10-13T22:07:00Z | 2026-10-14T00:07:00Z | Updated 2 h ago | 資料更新於 2 小時前 | no |
| F1 | 2026-10-13T22:07:00Z | 2026-10-13T22:35:24Z | Updated 28 min ago | 資料更新於 28 分鐘前 | no |
| F1 | 2026-10-13T22:07:00Z | 2026-10-13T22:52:00Z | Updated 45 min ago | 資料更新於 45 分鐘前 | no |
| F1 | 2026-10-13T22:07:00Z | 2026-10-13T23:07:00Z | Updated 1 h ago | 資料更新於 1 小時前 | no |
| F1 | 2026-10-13T22:07:00Z | 2026-10-13T23:52:00Z | Updated 1 h ago | 資料更新於 1 小時前 | no |
| F2 | 2026-10-13T22:07:00Z | 2026-10-14T01:07:01Z | Updated 3 h ago | 資料更新於 3 小時前 | no |
| F2 | 2026-10-13T22:07:00Z | 2026-10-14T22:06:59Z | Updated 23 h ago | 資料更新於 23 小時前 | no |
| F2 | 2026-10-13T22:07:00Z | 2026-10-14T22:17:00Z | Updated 24 h ago | 資料更新於 24 小時前 | no |
| F2 | 2026-10-13T22:07:00Z | 2026-10-15T01:06:30Z | Daily run late · 26 h ago | 今日更新尚未完成 · 26 小時前 | no |
| F2 | 2026-10-13T22:07:00Z | 2026-10-15T01:07:00Z | Daily run late · 27 h ago | 今日更新尚未完成 · 27 小時前 | no |
| F2 | 2026-10-13T22:07:00Z | 2026-10-15T01:07:01Z | Data may be out of date · 27 h ago | 資料可能過期 · 27 小時前 | yes |
| F7 | 2026-10-13T22:07:00Z | 2026-10-15T22:06:59Z | Data may be out of date · 47 h ago | 資料可能過期 · 47 小時前 | yes |
| F7 | 2026-10-13T22:07:00Z | 2026-10-15T22:07:00Z | Data may be out of date · 2 d ago | 資料可能過期 · 2 天前 | yes |
| F7 | 2026-10-13T22:07:00Z | 2026-10-20T23:00:00Z | Data may be out of date · 7 d ago | 資料可能過期 · 7 天前 | yes |
| F4 | not-a-time | 2026-10-14T00:07:00Z | — | — | — |
| F4 | 0 | 2026-10-14T00:07:00Z | — | — | — |
| F5 | 2026-10-13T22:08:00Z | 2026-10-13T22:07:00Z | Updated just now | 資料剛剛更新 | no |
<!-- test-plan:end -->

Step-based scenarios run as E2E tests in `apps/web/e2e/feed-freshness.spec.ts`:

| ID | Scenario | Expected |
| --- | --- | --- |
| F3 | Page opened 30 s before the 27-hour mark, then the clock advances 60 s | "Daily run late · 26 h ago" with overdue styling (Spec 021) becomes "Data may be out of date · 27 h ago" with stale styling, without a reload |
| F4 | `/api/feed` returns `generatedAt: "not-a-time"` | three Feed cards render; the topbar shows no age and keeps "Published snapshot" |

## Acceptance

### Behavior
- F1: with `generatedAt` two hours before now, the topbar reads "Updated 2 h
  ago" (en) and "資料更新於 2 小時前" (zh-Hant); 45 minutes reads in minutes.
- F2: at 27 h 1 s the topbar shows the stale styling and the out-of-date
  message; at exactly 27 h, at 23 h 59 min 59 s and at 24 h 10 min (a daily
  run about to start, and one still finishing) it does not (from 24 h 30 min
  it shows Spec 021's overdue warning instead); the threshold is the cadence
  plus the grace, not a second number.
- F7: a stale age below 48 h reads in hours ("47 h ago"); from 48 h it reads
  in days ("2 d ago" / "2 天前", "7 d ago").

### Failure and retry
- F3: with the page open, the label changes to stale (from Spec 021's
  overdue warning) when the 27-hour mark passes, without a reload.
- F4: with an unparsable `generatedAt`, the Feed renders its entries and the
  topbar shows no age.
- F5: with `generatedAt` 60 s in the future, the topbar reads "just now" /
  "剛剛".

### Budget
- Not applicable: no request, payload, or server work is added.

### Observability
- F6: [deploy] on development, the topbar's time agrees with `/health`
  `lastRun.completedAt`, and it shows the stale message whenever the last
  successful run is more than 27 hours old.

## Non-goals

- Alerting or notifications (a later observability spec).
- Freshness for Search or Detail views.
- Correcting a wrong browser clock beyond clamping future times.
- Narrow screens: the topbar pill is hidden below 420 px, and the maintainer
  who watches publication uses a desktop.
