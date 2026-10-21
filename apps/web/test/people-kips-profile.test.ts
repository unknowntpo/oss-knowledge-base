/**
 * Spec 019 amendment (7), slice C: the page rows of the profile's KIPs section
 * (`packages/reference-pipeline/test/kip-profile.cases.ts`). The checks are in `people-kips.checks.ts`.
 */
import { beforeAll, describe, expect, test } from "bun:test";

import { testPlanRows } from "../../../packages/reference-pipeline/test/kip-profile.cases";
import { kipProfileChecks, setUpKips } from "./people-kips.checks";

beforeAll(setUpKips);

describe("Spec 019 amendment (7), slice C: the KIPs section (page rows)", () => {
  test("every case row has a check and every check a row", () => {
    expect(Object.keys(kipProfileChecks).sort()).toEqual([...new Set(testPlanRows.map((row) => `${row.id}|${row.case}`))].sort());
  });

  test("W74: every Pages configuration leaves PEOPLE_KIPS unset (merged off; the Dev enable is its own PR)", async () => {
    for (const name of ["wrangler.jsonc", "wrangler.development.jsonc", "wrangler.production.jsonc"]) {
      const config = JSON.parse(await Bun.file(new URL(`../${name}`, import.meta.url)).text()) as { vars?: Record<string, string> };
      expect("PEOPLE_KIPS" in (config.vars ?? {})).toBe(false);
    }
  });

  test.each(testPlanRows)("$id: $case ($data) — $input", async (row) => {
    await kipProfileChecks[`${row.id}|${row.case}`]!();
  });
});
