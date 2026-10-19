/**
 * Spec 020 B19, the status board's rule: the single source for the rows of
 * `feature-map-site.test.ts` and for the table in docs/specs/020-feature-map-site/spec.md
 * (`bun run docs:test-plan`).
 *
 * - `status`: the spec's `Status:` line.
 * - `pending`: its acceptance items tagged `[pending]`.
 * - `inTag`: its directory is in the tree of the newest `v*` tag (what Prod runs).
 * - `offOnProd`: Deployed configuration rows that name the spec and are unset or none on Prod.
 * - `runsOn`: the spec's "Runs on" cell in the feature map's Acceptance table after B27 accepted it
 *   (`—`: no cell, or a rejected one: a claim the evidence contradicts never reaches this rule).
 * - `stage`: the board's group.
 */
export const testPlanRows = [
  { id: "B19", status: "Implemented (PR #7)", pending: 0, inTag: true, offOnProd: 0, runsOn: null, stage: "prod", why: "built and in the tag Prod runs" },
  { id: "B19", status: "Implemented (PR #7)", pending: 0, inTag: false, offOnProd: 0, runsOn: null, stage: "dev", why: "built after the tag: Dev deploys every push to main" },
  { id: "B19", status: "Implemented (PR #7)", pending: 0, inTag: true, offOnProd: 1, runsOn: null, stage: "dev", why: "a flag naming the spec is unset on Prod" },
  { id: "B19", status: "Partially implemented: slices 1–2", pending: 3, inTag: false, offOnProd: 0, runsOn: null, stage: "progress", why: "partial status with pending items" },
  { id: "B19", status: "Partially implemented: slices 1–2", pending: 0, inTag: true, offOnProd: 0, runsOn: null, stage: "progress", why: "the partial status alone, even in the tag" },
  { id: "B19", status: "Implemented", pending: 2, inTag: true, offOnProd: 0, runsOn: null, stage: "progress", why: "pending items win over the status word" },
  { id: "B19", status: "Accepted 2026-10-08", pending: 0, inTag: true, offOnProd: 0, runsOn: null, stage: "planned", why: "accepted is not built" },
  { id: "B19", status: "Draft for owner review", pending: 4, inTag: false, offOnProd: 0, runsOn: null, stage: "planned", why: "a draft with pending items is still planned" },
  { id: "B19", status: "Spike completed (#13)", pending: 0, inTag: false, offOnProd: 0, runsOn: null, stage: "other", why: "no known first word" },
  { id: "B19", status: "", pending: 0, inTag: false, offOnProd: 0, runsOn: null, stage: "other", why: "no Status line" },
  { id: "B19", status: "Implemented (#66)", pending: 0, inTag: false, offOnProd: 0, runsOn: "GitHub Pages", stage: "pages", why: "an accepted GitHub Pages claim: the site workflow publishes it" },
  { id: "B19", status: "Implemented (#1)", pending: 0, inTag: true, offOnProd: 0, runsOn: "Dev", stage: "dev", why: "narrowing: a spec in the Prod tag marked Dev" },
  { id: "B19", status: "Implemented (#1)", pending: 0, inTag: true, offOnProd: 0, runsOn: "Prod", stage: "prod", why: "an accepted Prod claim agrees with the tag" },
  { id: "B19", status: "Implemented (#1)", pending: 0, inTag: false, offOnProd: 0, runsOn: "none", stage: "other", why: "built but runs nowhere" },
  { id: "B19", status: "Partially implemented", pending: 1, inTag: false, offOnProd: 0, runsOn: "GitHub Pages", stage: "progress", why: "unfinished work stays in progress wherever it runs" },
  { id: "B19", status: "Accepted", pending: 0, inTag: false, offOnProd: 0, runsOn: "none", stage: "planned", why: "not built: Runs on does not apply" },
  { id: "B19", status: "Implemented (#66)", pending: 0, inTag: false, offOnProd: 0, runsOn: null, stage: "dev", why: "no claim and not published by the site workflow" },
] as const;
