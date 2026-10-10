# Spec 011: Stalled publication visible everywhere

Status: Accepted 2026-10-06, design delegated by the human
Date: 2026-10-06
Traceability: enforced
Builds on: Spec 010

## Intent

When the data pipeline stalls, anyone looking at the Dashboard sees it, on
every view and on a phone. "Stalled" is Spec 010's rule: the newest
publication is more than three hours old. No push notification is needed.

## Evidence

- From 2026-09-30 01:07 to 2026-10-02 02:42 UTC Dev published nothing for
  about 49 h.
- Spec 010 shows the age and a stale warning in the topbar pill. Captured on
  https://oss-knowledge-base-dev.pages.dev on 2026-10-06 around 07:30Z with the
  browser clock set to 2026-10-06T10:30:00Z (3 h 23 min after the newest
  publication), Feed, Feed detail (`#/feed/…`) and Search detail
  (`#/search/sdr1.…`), en and zh-Hant:

  | Viewport | Pill on all three views |
  | --- | --- |
  | 1280 × 800 | visible: "Data may be out of date · 3 h ago" / "資料可能過期 · 3 小時前" |
  | 375 × 812 | hidden (`@media (max-width: 420px) { .demo-pill { display: none; } }`) |

  The pill lives in `App.vue`'s topbar, so it already covers every route on
  desktop. The only gap is narrow screens, where a stall is invisible.

## Example

Captured from Dev at 2026-10-06T07:22:48Z:

```json
// /api/feed metadata.manifest
{ "releaseId": "2026-10-06T07-07-13-000Z", "generatedAt": "2026-10-06T07:07:13.000Z" }
// /api/search?q=kafka retrieval
{ "indexRevision": "feed-2026-10-06T07-07-13-000Z", "generatedAt": "2026-10-06T07:07:13.000Z", "stale": false }
```

| Browser clock (UTC) | Width | Topbar pill (en) |
| --- | --- | --- |
| 2026-10-06 10:07:13 | 375 px | hidden (fresh, as today) |
| 2026-10-06 10:07:14 | 375 px | "Data may be out of date · 3 h ago", stale styling, inside the viewport |
| 2026-10-06 10:07:14 | 1280 px | unchanged from Spec 010 |

## Simplification review

1. **Question every requirement.**
   - Owner: the maintainer (and any reader) who opens the Dashboard on a
     phone and must not mistake stalled data for current data.
   - "Every view": already true; the pill is in the global topbar and every
     route loads `/api/feed` (Evidence). Nothing to build.
   - The age on narrow screens while fresh: nobody needs it there; the
     intent is the stall. It stays hidden to keep the narrow topbar as is.
2. **Delete.**
   - The GitHub-issue alert Worker of the first draft (separate Cron
     Worker, `GITHUB_ALERT_TOKEN`, `publication-alert` label, 18 acceptance
     items). The human's need is visibility in the UI, not a push; the
     Worker needed a credential, a second failure domain, and a drill that
     creates real issues. Dropped with it, from its independent review:
     notification gaps for the token owner's own activity, labels silently
     dropped without push access, flapping issues on single failed runs,
     unbounded GitHub call time, and token expiry going unnoticed. None of
     these exist in a CSS-only change. A UI signal also covers a run the
     platform kills, which never records `lastRun.ok: false`.
   - Search freshness from `retrieval.generatedAt` / `retrieval.stale`:
     `retrieval.stale` is hard-coded `false`
     (`apps/web/functions/_shared/search-projection.ts`), and the publisher
     switches the Search pointer before the Feed pointer
     (`packages/serving-contract/src/publication-set.ts`), so Search is
     never older than the Feed; the Feed's `generatedAt` is a lower bound
     for every view.
   - A per-view banner, new i18n strings, a new API field, a new Worker,
     credentials: the existing pill, texts, and `feedFreshness` /
     `freshnessText` already say it.
3. **Simplify.** One CSS change in the existing `max-width: 420px` block:
   hide the pill only when it is not stale, and let the stale pill wrap
   instead of overflowing.
4. **Shorten the cycle.** No logic changes, so no new unit cases: Spec
   010's generated table already proves the texts and the 3 h boundary. The
   E2E tests below take their expected texts from that case file and run at
   fixed widths with a controlled clock.
5. **Automate last.** Nothing new to automate; the existing mobile
   Playwright project runs the new tests in CI.

## Behavior

1. At viewport widths up to 420 px, the topbar pill is shown when it has
   the stale styling (Spec 010 Behavior 2, or `metadata.stale`) and hidden
   otherwise. Above 420 px nothing changes.
2. The narrow stale pill shows the full Spec 010 text, wrapping onto more
   lines if needed; the topbar does not overflow horizontally at 320 px.
3. This holds on every route (Feed, Feed detail, Search detail), in both
   locales, and an open page turns stale without a reload (Spec 010
   Behavior 3).

## Test plan

No new case file: texts and the 3 h boundary come from Spec 010's generated
table (`apps/web/test/freshness.cases.ts`). Named E2E tests in
`apps/web/e2e/stall-visibility.spec.ts`, run at fixed viewport widths with a
controlled clock on the E2E fixture (`generatedAt` 2026-08-25T12:00:00Z):

| ID | Scenario | Expected |
| --- | --- | --- |
| V1 | Widths 320, 375, 420; clock 3 h 1 s after `generatedAt`; Feed, Feed detail, Search detail; en and zh-Hant | pill visible with the Spec 010 F2 stale text and stale styling, fully inside the viewport, text not clipped (pill `scrollWidth` ≤ `clientWidth`), ending left of the locale select; topbar `scrollWidth` ≤ `clientWidth` |
| V2 | Widths 375, 420; clock exactly 3 h after `generatedAt` (F2 boundary) | pill hidden; control: at width 421 the same pill is visible with "Updated 3 h ago" |
| V3 | Width 375; page opened 30 s before the 3 h mark, clock advances 60 s | pill goes from hidden to visible with the stale text, without a reload |
| V4 | Width 375; `/api/feed` `generatedAt` is "not-a-time"; control: same width with a stale `generatedAt` shows the pill | Feed cards render; pill hidden |
| V6 | Width 375; fresh `generatedAt` (2 h); `/api/feed` `metadata.stale` is `true`; control: same page without it hides the pill | pill visible with stale styling |

## Acceptance

### Behavior
- V1: with the newest publication more than 3 h old, at widths 320, 375
  and 420 px, opening Feed, Feed detail, or Search detail in en or zh-Hant
  shows the pill with Spec 010's full stale text and styling inside the
  viewport: the text is not clipped by the pill, the pill ends before the
  locale select, and the topbar has no horizontal overflow → evidence: E2E
  V1.
- V2: with the newest publication exactly 3 h old, at 375 and 420 px the
  pill is hidden, while at 421 px it shows "Updated 3 h ago" → evidence:
  E2E V2.
- V6: with `metadata.stale` `true` and a fresh `generatedAt`, at 375 px the
  pill is shown with stale styling, while the same page without
  `metadata.stale` hides it → evidence: E2E V6.

### Failure and retry
- V3: with a narrow page left open across the 3 h mark, the stale pill
  appears within one minute without a reload → evidence: E2E V3.
- V4: with an unparsable `generatedAt` at 375 px, the Feed renders and no
  pill is shown (no false stall), while a stale `generatedAt` on the same
  path shows it → evidence: E2E V4.

### Budget
- Not applicable: CSS only; no request, payload, or server work is added.

### Observability
- V5: [deploy] on Dev at 375 px with the browser clock more than 3 h after
  `/health` `lastRun.completedAt`, Feed, Feed detail, and Search detail show
  the stale pill; with the real clock (fresh data) they do not.

## Non-goals

- Push notifications, GitHub issues, or any alerting outside the page
  (dropped above).
- Showing the age on narrow screens while data is fresh.
- Freshness of Search independent of the Feed (see Delete).
- Follow-up: the pre-existing horizontal overflow of the Search detail
  page body at 375 px (seen in the Evidence capture; unrelated to the
  topbar). Done in Spec 001 A13.
- Follow-up: with `metadata.stale` `true` and a parsable `generatedAt`, the
  pill has stale styling but non-stale text (for example "Updated 2 h
  ago"), because `App.vue` prefers the freshness text over "Cached". This
  predates Spec 011 and is unchanged here; V6 only asserts the pill shows.
