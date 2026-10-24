/**
 * Spec 030 slice 1 test plan: the single source for `project-trend.test.ts` and the table in
 * docs/specs/030-project-activity-trend/spec.md (`bun run docs:test-plan` regenerates it).
 *
 * Stores (`project-trend.store.ts`), read at the controlled clock 2026-10-24T03:00Z (view
 * 2025-11 … 2026-10): `constructed` reviews, 20 + i people's reviews in month i plus a GitHub App,
 * a `[bot]` and an author's reply each month; `recorded` activity, the Dev release of 2026-10-14
 * appended from Dev's coverage start 2026-09-10T02:45:16.847Z, plus a Jira issue stored in two
 * months, a `dependabot` comment, and a dev@ message one second before the start.
 *
 * Columns: one `month` of the response with its four counts (`null`: not recorded or unreadable,
 * never 0); `unavailable` = `unavailableMonths`; `coverage` = the response's coverage in short;
 * `card` = whether the page shows the card. The activity counts were tallied from the fixture's
 * raw records by a separate script (creation month for a pull request, last update for a Jira
 * issue, one count per record id), not by this code.
 */
const COVERED = "github-reviews from 2025-11-01; github, jira, mail from 2026-09-10";

export const testPlanRows = [
  { id: "PT1", case: "reviews given by people in the month", data: "constructed", store: "full", month: "2026-01", reviews: 22, github: null, jira: null, mail: null, unavailable: "—", coverage: COVERED, card: "shown" },
  { id: "PT1", case: "a GitHub App, a `[bot]` login and a reply by the pull request's author are not reviews (23 rows stored, 20 counted)", data: "constructed", store: "full", month: "2025-11", reviews: 20, github: null, jira: null, mail: null, unavailable: "—", coverage: COVERED, card: "shown" },
  { id: "PT1", case: "a login GitHub typed `Bot` in another month of the view (no `[bot]` suffix) is not a reviewer: its untyped review is left out (24 people's rows, 23 counted)", data: "constructed", store: "full", month: "2026-02", reviews: 23, github: null, jira: null, mail: null, unavailable: "—", coverage: COVERED, card: "shown" },
  { id: "PT1", case: "activity rows by source; a `dependabot` comment is not counted; the Jira issue stored in September and October counts once, in October", data: "recorded", store: "full", month: "2026-10", reviews: 31, github: 47, jira: 44, mail: 20, unavailable: "—", coverage: COVERED, card: "shown" },
  { id: "PT2", case: "a month before the activity log's coverage: activity series null, never 0", data: "recorded", store: "full", month: "2026-08", reviews: 29, github: null, jira: null, mail: null, unavailable: "—", coverage: COVERED, card: "shown" },
  { id: "PT2", case: "the partial first month counts from 9/10 only: a message one second earlier is left out", data: "recorded", store: "full", month: "2026-09", reviews: 30, github: 112, jira: 58, mail: 39, unavailable: "—", coverage: COVERED, card: "shown" },
  { id: "PT9", case: "one review month unreadable: its reviews null and listed", data: "constructed", store: "review-month-corrupt", month: "2026-03", reviews: null, github: null, jira: null, mail: null, unavailable: "2026-03", coverage: COVERED, card: "shown" },
  { id: "PT9", case: "the other months are still present", data: "constructed", store: "review-month-corrupt", month: "2026-04", reviews: 25, github: null, jira: null, mail: null, unavailable: "2026-03", coverage: COVERED, card: "shown" },
  { id: "PT9", case: "one activity month unreadable: its three activity series null and listed", data: "recorded", store: "activity-month-corrupt", month: "2026-09", reviews: 30, github: null, jira: null, mail: null, unavailable: "2026-09", coverage: COVERED, card: "shown" },
  { id: "PT11", case: "no activity `state.json`: the three series null in every month and not recorded", data: "constructed", store: "no-activity", month: "2026-10", reviews: 31, github: null, jira: null, mail: null, unavailable: "—", coverage: "github-reviews from 2025-11-01; github, jira, mail not recorded", card: "shown" },
  { id: "PT11", case: "neither store recorded: every count null and the card hidden", data: "constructed", store: "nothing", month: "2026-10", reviews: null, github: null, jira: null, mail: null, unavailable: "—", coverage: "github-reviews, github, jira, mail not recorded", card: "hidden" },
] as const;
