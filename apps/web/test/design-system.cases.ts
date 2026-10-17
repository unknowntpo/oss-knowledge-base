/**
 * Spec 023 test plan: the single source for `design-system.test.ts` and for the table in
 * docs/specs/023-design-system/spec.md (`bun run docs:test-plan` regenerates it).
 *
 * Each row is a colour pair. `foreground` and `background` are a token of `apps/web/styles.css`
 * (`--name`, resolved through aliases) or a literal. `ratio` is the measured WCAG 2.x contrast,
 * rounded to two decimals; the test fails when the stylesheet's value no longer gives it or
 * when it is below `min`.
 */
export const testPlanRows = [
  { id: "DS1", pair: "avatar initials on --avatar-1 (indigo)", foreground: "#ffffff", background: "--avatar-1", min: 4.5, ratio: 6.9 },
  { id: "DS1", pair: "avatar initials on --avatar-2 (green)", foreground: "#ffffff", background: "--avatar-2", min: 4.5, ratio: 5.2 },
  { id: "DS1", pair: "avatar initials on --avatar-3 (rust)", foreground: "#ffffff", background: "--avatar-3", min: 4.5, ratio: 5.44 },
  { id: "DS1", pair: "avatar initials on --avatar-4 (purple)", foreground: "#ffffff", background: "--avatar-4", min: 4.5, ratio: 7.37 },
  { id: "DS1", pair: "avatar initials on --avatar-5 (steel blue, legacy #3f7fa0 darkened)", foreground: "#ffffff", background: "--avatar-5", min: 4.5, ratio: 4.86 },
  { id: "DS1", pair: "avatar initials on --avatar-6 (brown)", foreground: "#ffffff", background: "--avatar-6", min: 4.5, ratio: 5.25 },
  { id: "DS2", pair: "GitHub source badge (.src-github)", foreground: "#4c4959", background: "#eeedf1", min: 4.5, ratio: 7.49 },
  { id: "DS2", pair: "GitHub badge in the profile header (.person-meta .src-github)", foreground: "--accent", background: "--accent-tint", min: 4.5, ratio: 6.11 },
] as const;

/** DS1: authors from the E2E fixture and the hue the legacy viewer's hash gives them. */
export const authorHues = [
  { author: "bob", hue: 2 },
  { author: "alice", hue: 1 },
] as const;
