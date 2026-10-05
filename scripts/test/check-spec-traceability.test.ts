import { describe, expect, test } from "bun:test";

import { acceptanceItems, runsCaseFile, testPlanCaseFiles, testTitles, untracedItems } from "../check-spec-traceability";

const spec = `# Spec 999
Traceability: enforced

## Acceptance

### Behavior
- F1: shows the age
- F2: [deploy] visible on Dev

## Non-goals
- F9: not an acceptance item
`;

describe("spec traceability", () => {
  test("reads acceptance IDs and tags only from an enforced spec's Acceptance section", () => {
    expect(acceptanceItems("s.md", spec)).toEqual([
      { spec: "s.md", id: "F1" },
      { spec: "s.md", id: "F2", tag: "deploy" },
    ]);
    expect(acceptanceItems("s.md", spec.replace("Traceability: enforced", ""))).toEqual([]);
  });

  test("reports an untagged item without a test whose name contains its ID", () => {
    const items = acceptanceItems("s.md", spec);
    expect(untracedItems(items, [])).toEqual([{ spec: "s.md", id: "F1" }]);
    expect(untracedItems(items, ["F1: shows the age"])).toEqual([]);
    expect(untracedItems(items, ["F11: other"])).toEqual([{ spec: "s.md", id: "F1" }]);
  });

  test("collects test and it titles, including test.each", () => {
    const source = `test("F1: a", () => {});\nit('F2: b', () => {});\ntest.each([1])("F3: c %s", () => {});`;
    expect(testTitles(source)).toEqual(["F1: a", "F2: b", "F3: c %s"]);
  });

  test("counts case-file rows as traced only for the spec that names the case file", () => {
    const items = acceptanceItems("s.md", spec);
    expect(untracedItems(items, [], new Set(["s.md#F1"]))).toEqual([]);
    expect(untracedItems(items, [], new Set(["other.md#F1"]))).toEqual([{ spec: "s.md", id: "F1" }]);
    expect(testPlanCaseFiles("<!-- test-plan:start apps/web/test/x.cases.ts -->")).toEqual(["apps/web/test/x.cases.ts"]);
  });

  test("requires a test that imports the case file and runs it with test.each", () => {
    const path = "apps/web/test/freshness.cases.ts";
    expect(runsCaseFile(`import { testPlanRows } from "./freshness.cases";\ntest.each(testPlanRows)("$id", () => {});`, path)).toBe(true);
    expect(runsCaseFile(`import { testPlanRows } from "./freshness.cases";`, path)).toBe(false);
    expect(runsCaseFile(`test.each(rows)("$id", () => {});`, path)).toBe(false);
  });
});
