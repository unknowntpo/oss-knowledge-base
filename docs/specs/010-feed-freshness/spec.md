# Spec 010: Feed freshness

Status: Draft (workflow pilot 001)
Date: 2026-10-04
Traceability: enforced
Builds on: Spec 003, Spec 008

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
| 2026-10-04 02:07:14 | stale styling, "Data may be out of date · 3 h ago" |

## Simplification review

- No API change. `metadata.manifest.generatedAt` already carries the only
  value needed. Server-computed age or a `stale` flag would be cached for up
  to 150 s (`max-age=30, stale-while-revalidate=120`) and be less accurate
  than computing in the browser.
- The 3-hour threshold is display policy and lives in the UI.
- Owner of the live re-render (F3): the maintainer who leaves the page open to
  watch publication.

## Behavior

1. The topbar shows the age of `metadata.manifest.generatedAt` relative to the
   browser clock: minutes below one hour, hours otherwise.
2. Above three hours the topbar uses the existing stale styling and says the
   data may be out of date.
3. The label is recomputed every minute while the page is open.
4. Freshness never blocks the Feed: an unparsable or missing `generatedAt`
   hides the label; a `generatedAt` in the future (clock skew) reads as
   "just now".

## Test plan

Generated from `apps/web/test/freshness.cases.ts` by `bun run docs:test-plan`;
the unit tests run exactly these rows. Edit the case file, not this table.
`now` is the browser clock; `—` means no freshness label.

<!-- test-plan:start apps/web/test/freshness.cases.ts -->
| id | generatedAt | now | en | zh | stale |
| --- | --- | --- | --- | --- | --- |
| F1 | 2026-10-03T23:07:13Z | 2026-10-04T01:07:13Z | Updated 2 h ago | 資料更新於 2 小時前 | no |
| F1 | 2026-10-03T23:07:13Z | 2026-10-03T23:35:37Z | Updated 28 min ago | 資料更新於 28 分鐘前 | no |
| F1 | 2026-10-03T23:07:13Z | 2026-10-03T23:52:13Z | Updated 45 min ago | 資料更新於 45 分鐘前 | no |
| F2 | 2026-10-03T23:07:13Z | 2026-10-04T02:07:13Z | Updated 3 h ago | 資料更新於 3 小時前 | no |
| F2 | 2026-10-03T23:07:13Z | 2026-10-04T02:07:14Z | Data may be out of date · 3 h ago | 資料可能過期 · 3 小時前 | yes |
| F4 | not-a-time | 2026-10-04T01:07:13Z | — | — | — |
| F5 | 2026-10-03T23:08:13Z | 2026-10-03T23:07:13Z | Updated just now | 資料剛剛更新 | no |
<!-- test-plan:end -->

Step-based scenarios run as E2E tests in `apps/web/e2e/feed-freshness.spec.ts`:

| ID | Scenario | Expected |
| --- | --- | --- |
| F3 | Page opened 30 s before the three-hour mark, then the clock advances 60 s | "Updated 2 h ago" with live styling becomes "Data may be out of date · 3 h ago" with stale styling, without a reload |
| F4 | `/api/feed` returns `generatedAt: "not-a-time"` | three Feed cards render; the topbar shows no age |

## Acceptance

### Behavior
- F1: with `generatedAt` two hours before now, the topbar reads "Updated 2 h
  ago" (en) and "資料更新於 2 小時前" (zh-Hant); 45 minutes reads in minutes.
- F2: at 3 h 1 s the topbar shows the stale styling and the out-of-date
  message; at exactly 3 h it does not.

### Failure and retry
- F3: with the page open, the label changes from fresh to stale when the
  three-hour mark passes, without a reload.
- F4: with an unparsable `generatedAt`, the Feed renders its entries and the
  topbar shows no age.
- F5: with `generatedAt` 60 s in the future, the topbar reads "just now" /
  "剛剛".

### Budget
- Not applicable: no request, payload, or server work is added.

### Observability
- F6: [deploy] on development, the topbar's time agrees with `/health`
  `lastRun.completedAt`, and it shows the stale message whenever the last
  successful run is more than three hours old.

## Non-goals

- Alerting or notifications (a later observability spec).
- Freshness for Search or Detail views.
- Correcting a wrong browser clock beyond clamping future times.
