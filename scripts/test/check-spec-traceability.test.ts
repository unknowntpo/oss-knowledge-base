import { describe, expect, test } from "bun:test";

import { acceptanceItems, checkTraceability, runsCaseFile, testPlanCaseFiles, testTitles, untracedItems } from "../check-spec-traceability";

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
    expect(testPlanCaseFiles("<!-- test-plan:start apps/web/test/x.cases.ts -->")).toEqual([{ path: "apps/web/test/x.cases.ts", pending: false }]);
    expect(testPlanCaseFiles("<!-- test-plan:start a/y.cases.ts [pending] -->")).toEqual([{ path: "a/y.cases.ts", pending: true }]);
  });

  test("requires a test that imports the case file and runs it with test.each", () => {
    const path = "apps/web/test/freshness.cases.ts";
    expect(runsCaseFile(`import { testPlanRows } from "./freshness.cases";\ntest.each(testPlanRows)("$id", () => {});`, path)).toBe(true);
    expect(runsCaseFile(`import { testPlanRows } from "./freshness.cases";`, path)).toBe(false);
    expect(runsCaseFile(`test.each(rows)("$id", () => {});`, path)).toBe(false);
  });

  describe("[pending] items (planned slices)", async () => {
    const pendingSpec = (status: string) => `# Spec 998
Status: ${status}
Traceability: enforced

<!-- test-plan:start a/now.cases.ts -->
<!-- test-plan:end -->
<!-- test-plan:start a/later.cases.ts [pending] -->
<!-- test-plan:end -->

## Acceptance
- P1: covered now
- P2: [pending] next slice
- P3: [measure] a budget
`;
    const runner = { path: "a/now.test.ts", source: `import { testPlanRows } from "./now.cases";\ntest.each(testPlanRows)("$id", async () => {});` };
    const rows: Record<string, readonly { id: string }[]> = { "a/now.cases.ts": [{ id: "P1" }], "a/later.cases.ts": [{ id: "P2" }] };
    const run = (status: string, tests = [runner], extraTitles: string[] = []) => checkTraceability({
      specs: [{ path: "s.md", markdown: pendingSpec(status) }],
      tests: [...tests, { path: "a/extra.test.ts", source: extraTitles.map((title) => `test("${title}", async () => {});`).join("\n") }],
      rows: (path) => rows[path] ?? [],
    });

    test("reads the [pending] tag", async () => {
      expect(acceptanceItems("s.md", pendingSpec("Accepted"))).toEqual([
        { spec: "s.md", id: "P1" },
        { spec: "s.md", id: "P2", tag: "pending" },
        { spec: "s.md", id: "P3", tag: "measure" },
      ]);
    });

    test("a pending item and an unrun pending case file pass and are listed", async () => {
      const result = await run("Accepted");
      expect(result.errors).toEqual([]);
      expect(result.pending).toEqual(["s.md P2: [pending]", "s.md a/later.cases.ts: [pending] case file"]);
    });

    test("positive control: without the runner, the covered item fails", async () => {
      const result = await run("Accepted", []);
      expect(result.errors).toContain("s.md: no test runs a/now.cases.ts with test.each");
    });

    test("a pending item that already has a test is a stale tag", async () => {
      expect((await run("Accepted", [runner], ["P2: now tested"])).errors).toEqual(["s.md P2: tagged [pending] but a test name contains \"P2:\""]);
    });

    test("a pending case file that a test runs is a stale tag", async () => {
      const later = { path: "a/later.test.ts", source: `import { testPlanRows } from "./later.cases";\ntest.each(testPlanRows)("$id", async () => {});` };
      expect((await run("Accepted", [runner, later])).errors).toContain("s.md: a/later.cases.ts is marked [pending] but a test runs it");
    });

    test("an Implemented spec may not keep [pending] items or case files", async () => {
      const errors = (await run("Implemented (PR #33)")).errors;
      expect(errors).toContain("s.md P2: [pending] in a spec whose Status is Implemented");
      expect(errors).toContain("s.md: a/later.cases.ts is [pending] in a spec whose Status is Implemented");
      // Positive control: the same spec without pending parts passes when Implemented.
      const done = pendingSpec("Implemented (PR #33)").replace("- P2: [pending] next slice\n", "").replace(" [pending] -->", " -->");
      const later = { path: "a/later.test.ts", source: `import { testPlanRows } from "./later.cases";\ntest.each(testPlanRows)("$id", async () => {});` };
      expect((await checkTraceability({ specs: [{ path: "s.md", markdown: done }], tests: [runner, later], rows: (path) => rows[path] ?? [] })).errors).toEqual([]);
    });

    test("only the Status line decides Implemented", async () => {
      const spec = pendingSpec("Accepted").replace("Traceability: enforced", "Builds on: Spec 001 (Implemented)\nTraceability: enforced");
      expect((await checkTraceability({ specs: [{ path: "s.md", markdown: spec }], tests: [runner], rows: (path) => rows[path] ?? [] })).errors).toEqual([]);
    });

    test("rows of a pending case file do not trace their IDs", async () => {
      const spec = pendingSpec("Accepted").replace("- P2: [pending] next slice", "- P2: next slice");
      const errors = (await checkTraceability({ specs: [{ path: "s.md", markdown: spec }], tests: [runner], rows: (path) => rows[path] ?? [] })).errors;
      expect(errors).toEqual(["s.md P2: no test name contains \"P2:\""]);
    });
  });
});
