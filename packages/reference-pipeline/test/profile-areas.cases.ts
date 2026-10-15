/**
 * Spec 019 areas amendment test plan (W46–W49, W51): the one area taxonomy, the one aggregation,
 * and what the profile response carries. The single source for `profile-areas.test.ts` and for the
 * areas table in docs/specs/019-contributor-profile/spec.md (`bun run docs:test-plan`).
 * All rows are constructed; label names are the ones measured on 2026-10-15 (spec Evidence).
 */
export const testPlanRows = [
  { id: "W46", rule: "taxonomy", input: "kafka: clients, small, ci-approved, triage, needs-attention, KIP-932, kip", expected: "areas clients; kips KIP-932" },
  { id: "W46", rule: "taxonomy", input: "kafka: kip-1332 (lower case) and a title KIP-1332", expected: "areas none; kips KIP-1332" },
  { id: "W46", rule: "taxonomy", input: "datafusion: sql, v56.0.0, auto detected api change, bug, rust, auto-dependencies", expected: "areas sql; kips none" },
  { id: "W46", rule: "taxonomy", input: "kafka: a label not in the profile (share-groups)", expected: "areas share-groups; kips none" },
  { id: "W46", rule: "taxonomy", input: "datafusion positive control: core, physical-plan, sqllogictest", expected: "areas core, physical-plan, sqllogictest; kips none" },
  { id: "W47", rule: "distribution", input: "#1 clients, core; #2 clients; #3 triage only", expected: "items 3; unlabelled 1; assignments 3; slices clients 2, core 1" },
  { id: "W47", rule: "distribution", input: "the same pull request listed twice", expected: "items 1; unlabelled 0; assignments 1; slices clients 1" },
  { id: "W47", rule: "distribution", input: "8 areas a..h on 8, 7, …, 1 pull requests", expected: "items 8; unlabelled 0; assignments 36; slices a 8, b 7, c 6, d 5, e 4, f 3, other 3" },
  { id: "W47", rule: "distribution", input: "exactly 6 areas", expected: "items 6; unlabelled 0; assignments 6; slices a 1, b 1, c 1, d 1, e 1, f 1" },
  { id: "W49", rule: "coverage", input: "reviewed #1 and #2; metadata for #1 only", expected: "covered 1 of 2" },
  { id: "W49", rule: "coverage", input: "reviewed #1 twice; metadata for #1", expected: "covered 1 of 1" },
  { id: "W46", rule: "profile", input: "every month of the view with metadata; ada reviewed #10 (clients, triage) and #11 (core, KIP-932)", expected: "pullAreas 10 clients; 11 core KIP-932" },
  { id: "W46", rule: "profile", input: "no month with metadata (metadata@1 only)", expected: "no pullAreas" },
  { id: "W49", rule: "profile", input: "ada's reviews in two months, only the newer with metadata", expected: "pullAreas 11 core KIP-932; #10 not covered" },
  { id: "W46", rule: "profile", input: "#11's labels in an older month and different labels in a newer one", expected: "pullAreas 11 streams" },
  { id: "W51", rule: "profile name", input: "ada named Ada Lovelace in the older month and A. Lovelace in the newer", expected: "name A. Lovelace" },
  { id: "W51", rule: "profile name", input: "no name stored for ada", expected: "no name" },
  { id: "W51", rule: "profile name", input: "a suppressed counterpart with a stored name", expected: "name not in the response" },
] as const;
