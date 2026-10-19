/**
 * Spec 020 B19, the status board's rule: the single source for the rows of
 * `feature-map-site.test.ts` and for the table in docs/specs/020-feature-map-site/spec.md
 * (`bun run docs:test-plan`).
 *
 * - `status`: the spec's `Status:` line.
 * - `pending`: its acceptance items tagged `[pending]`.
 * - `inTag`: its directory is in the tree of the newest `v*` tag (what Prod runs).
 * - `offOnProd`: Deployed configuration rows that name the spec and are unset or none on Prod.
 * - `stage`: the board's group.
 */
export const testPlanRows = [
  { id: "B19", status: "Implemented (PR #7)", pending: 0, inTag: true, offOnProd: 0, stage: "prod", why: "built and in the tag Prod runs" },
  { id: "B19", status: "Implemented (PR #7)", pending: 0, inTag: false, offOnProd: 0, stage: "dev", why: "built after the tag: Dev deploys every push to main" },
  { id: "B19", status: "Implemented (PR #7)", pending: 0, inTag: true, offOnProd: 1, stage: "dev", why: "a flag naming the spec is unset on Prod" },
  { id: "B19", status: "Partially implemented: slices 1–2", pending: 3, inTag: false, offOnProd: 0, stage: "progress", why: "partial status with pending items" },
  { id: "B19", status: "Partially implemented: slices 1–2", pending: 0, inTag: true, offOnProd: 0, stage: "progress", why: "the partial status alone, even in the tag" },
  { id: "B19", status: "Implemented", pending: 2, inTag: true, offOnProd: 0, stage: "progress", why: "pending items win over the status word" },
  { id: "B19", status: "Accepted 2026-10-08", pending: 0, inTag: true, offOnProd: 0, stage: "planned", why: "accepted is not built" },
  { id: "B19", status: "Draft for owner review", pending: 4, inTag: false, offOnProd: 0, stage: "planned", why: "a draft with pending items is still planned" },
  { id: "B19", status: "Spike completed (#13)", pending: 0, inTag: false, offOnProd: 0, stage: "other", why: "no known first word" },
  { id: "B19", status: "", pending: 0, inTag: false, offOnProd: 0, stage: "other", why: "no Status line" },
] as const;
