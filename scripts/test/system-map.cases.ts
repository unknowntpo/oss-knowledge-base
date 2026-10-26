/**
 * Spec 033 SM2: the single source for the Deployed configuration cell rule (Behavior 2) in
 * `system-map.test.ts` and for the test-plan table in docs/specs/033-system-map/spec.md
 * (`bun run docs:test-plan`).
 *
 * - `cell`: a Dev or Prod cell as written in docs/feature-map.md (Markdown).
 * - `live`: whether a node gated by that row is live in that environment.
 * - `mode`: the mode chip shown for it, or "—".
 */
export const testPlanRows = [
  { id: "SM2", cell: "unset", live: false, mode: "—", why: "no value: off" },
  { id: "SM2", cell: "unset: off", live: false, mode: "—", why: "the default spelled out" },
  { id: "SM2", cell: "none", live: false, mode: "—", why: "a binding that is not bound" },
  { id: "SM2", cell: "off", live: false, mode: "—", why: "the flag's off value" },
  { id: "SM2", cell: "`off`; no cron", live: false, mode: "—", why: "backticks do not count (Prod `SRE_AGENT`)" },
  { id: "SM2", cell: "no cron", live: false, mode: "—", why: "\"no \" starts an off cell" },
  { id: "SM2", cell: "unset; no cron (Prod unchanged until its own PR, O2)", live: false, mode: "—", why: "explanations after the value do not matter" },
  { id: "SM2", cell: "`dry-run`; `17 10 * * *` with its cron entry", live: true, mode: "dry-run", why: "a dry run is live, shown with its mode" },
  { id: "SM2", cell: "`monitor` (Spec 026 rollout step 1)", live: true, mode: "monitor", why: "monitor is live, shown with its mode" },
  { id: "SM2", cell: "`true` (Spec 016 slice 3 enable, 2026-10-13)", live: true, mode: "—", why: "a value is on" },
  { id: "SM2", cell: "`bge-m3@1` (Spec 016 H52, 2026-10-12)", live: true, mode: "—", why: "a revision is on" },
  { id: "SM2", cell: "bound (2026-10-13)", live: true, mode: "—", why: "a bound binding is on" },
  { id: "SM2", cell: "Workers AI", live: true, mode: "—", why: "any other text is on" },
] as const;
