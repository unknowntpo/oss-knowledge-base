import { describe, expect, test } from "bun:test";

import { acceptanceErrors, acceptanceItems, checkTraceability, markerErrors, runsCaseFile, testPlanCaseFiles, testTitles, untracedItems } from "../check-spec-traceability";

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
      const spec = pendingSpec("Accepted").replace("Traceability: enforced", "Builds on: Spec 001 (Implemented); prose says Status: Implemented mid-line\nTraceability: enforced");
      expect((await checkTraceability({ specs: [{ path: "s.md", markdown: spec }], tests: [runner], rows: (path) => rows[path] ?? [] })).errors).toEqual([]);
    });

    test("a pending item traced by rows of a run case file is a stale tag", async () => {
      const staleRows: Record<string, readonly { id: string }[]> = { "a/now.cases.ts": [{ id: "P1" }, { id: "P2" }], "a/later.cases.ts": [] };
      const result = await checkTraceability({ specs: [{ path: "s.md", markdown: pendingSpec("Accepted") }], tests: [runner], rows: (path) => staleRows[path] ?? [] });
      expect(result.errors).toEqual(["s.md P2: tagged [pending] but a test name contains \"P2:\""]);
    });

    test("rows of a pending case file do not trace their IDs", async () => {
      const spec = pendingSpec("Accepted").replace("- P2: [pending] next slice", "- P2: next slice");
      const errors = (await checkTraceability({ specs: [{ path: "s.md", markdown: spec }], tests: [runner], rows: (path) => rows[path] ?? [] })).errors;
      expect(errors).toEqual(["s.md P2: no test name contains \"P2:\""]);
    });
  });

  describe("fail-closed parsing (verifier F2, F4)", () => {
    test("a malformed test-plan marker is an error, a well-formed one is not", () => {
      expect(markerErrors("<!-- test-plan:start a/x.cases.ts [Pending] -->")).toEqual(["malformed test-plan marker: \"<!-- test-plan:start a/x.cases.ts [Pending] -->\""]);
      expect(markerErrors("<!-- test-plan:start a/x.cases.ts  [pending] -->")).toHaveLength(1);
      expect(markerErrors("<!-- test-plan:start a/x.cases.ts [pending]-->")).toHaveLength(1);
      expect(markerErrors("<!-- test-plan:start a/x.cases.ts [pending] -->\n<!-- test-plan:start a/y.cases.ts -->")).toEqual([]);
    });

    test("combined, unknown, or misplaced tags and malformed bullets are errors", () => {
      const bad = `Traceability: enforced

## Acceptance
- D1: [deploy] [pending] both
- D2: [Pending] wrong case
  - D3: indented
* D4: star bullet
- D5: [measure] fine
- D6:[pending] no space is fine
`;
      expect(acceptanceErrors("s.md", bad)).toEqual([
        "s.md D1: more than one tag ([deploy] [pending]); use one of [deploy], [measure], [pending]",
        "s.md D2: unknown tag [Pending]",
        "s.md: malformed acceptance bullet: \"  - D3: indented\"",
        "s.md: malformed acceptance bullet: \"* D4: star bullet\"",
      ]);
      expect(acceptanceItems("s.md", bad).find((item) => item.id === "D6")).toEqual({ spec: "s.md", id: "D6", tag: "pending" });
      expect(acceptanceErrors("s.md", "Traceability: enforced\n\n## Acceptance criteria\n- D1: x\n")).toEqual(["s.md: enforced spec has no \"## Acceptance\" section"]);
      expect(acceptanceErrors("s.md", spec)).toEqual([]);
    });

    test("the gate reports parse errors", async () => {
      const markdown = `${spec}\n<!-- test-plan:start a/x.cases.ts [Pending] -->\n`;
      const result = await checkTraceability({ specs: [{ path: "s.md", markdown }], tests: [{ path: "t.ts", source: 'test("F1: x", () => {});' }], rows: () => [] });
      expect(result.errors).toContain("s.md: malformed test-plan marker: \"<!-- test-plan:start a/x.cases.ts [Pending] -->\"");
      const combined = spec.replace("- F2: [deploy] visible on Dev", "- F2: [deploy] [pending] visible on Dev");
      const tagged = await checkTraceability({ specs: [{ path: "s.md", markdown: combined }], tests: [{ path: "t.ts", source: 'test("F1: x", () => {});' }], rows: () => [] });
      expect(tagged.errors).toContain("s.md F2: more than one tag ([deploy] [pending]); use one of [deploy], [measure], [pending]");
    });

    test("a type-only import or a commented test.each does not run a case file", () => {
      const path = "apps/web/test/freshness.cases.ts";
      expect(runsCaseFile(`import type { testPlanRows } from "./freshness.cases";\ntest.each(testPlanRows)("$id", () => {});`, path)).toBe(false);
      expect(runsCaseFile(`import { type testPlanRows } from "./freshness.cases";\ntest.each(testPlanRows)("$id", () => {});`, path)).toBe(false);
      expect(runsCaseFile(`import { testPlanRows } from "./freshness.cases";\n// test.each(testPlanRows)("$id", () => {});`, path)).toBe(false);
      expect(runsCaseFile(`import { testPlanRows } from "./freshness.cases";\n/* test.each(testPlanRows) */ test.each(rows)("$id", () => {});`, path)).toBe(false);
      expect(runsCaseFile(`import { parseFilters, testPlanRows } from "./freshness.cases";\ntest.each([...testPlanRows] as Row[])("$id", () => {});`, path)).toBe(true);
    });
  });

  describe("fail-closed parsing, round 2 (PR #33 carry-overs N1–N3)", () => {
    test("N1: a marker with trailing whitespace, a tab, or CRLF is malformed", () => {
      expect(markerErrors("<!-- test-plan:start a/x.cases.ts --> ")).toHaveLength(1);
      expect(markerErrors("<!-- test-plan:start a/x.cases.ts -->\t")).toHaveLength(1);
      expect(markerErrors("<!-- test-plan:start a/x.cases.ts -->\r\n<!-- test-plan:end -->")).toHaveLength(1);
      expect(markerErrors("<!-- test-plan:start a/x.cases.ts -->\n<!-- test-plan:end -->")).toEqual([]);
    });

    test("N2: near-miss acceptance bullets are errors", () => {
      const near = "Traceability: enforced\n\n## Acceptance\n- D1 : spaced\n- d2: lowercase\n- **D3**: bold\n- D4: fine\n";
      expect(acceptanceErrors("s.md", near)).toEqual([
        "s.md: malformed acceptance bullet: \"- D1 : spaced\"",
        "s.md: malformed acceptance bullet: \"- d2: lowercase\"",
        "s.md: malformed acceptance bullet: \"- **D3**: bold\"",
      ]);
    });

    test("N3: only running the whole case file counts, from the case file's own path", () => {
      const casePath = "apps/web/test/freshness.cases.ts";
      const testPath = "apps/web/test/freshness.test.ts";
      const whole = `import { testPlanRows } from "./freshness.cases";\ntest.each(testPlanRows)("$id", () => {});`;
      expect(runsCaseFile(whole, casePath, testPath)).toBe(true);
      expect(runsCaseFile(`import { testPlanRows } from "./freshness.cases";\ntest.each([...testPlanRows] as Row[])("$id", () => {});`, casePath, testPath)).toBe(true);
      expect(runsCaseFile(`import { testPlanRows } from "./freshness.cases";\ntest.each(testPlanRows.filter((row) => row.id === "F1"))("$id", () => {});`, casePath, testPath)).toBe(false);
      expect(runsCaseFile(`import { testPlanRows } from "./freshness.cases";\ntest.each(testPlanRows.slice(0, 1))("$id", () => {});`, casePath, testPath)).toBe(false);
      expect(runsCaseFile("const note = `import { testPlanRows } from './freshness.cases'`;\ntest.each(testPlanRows)(\"$id\", () => {});", casePath, testPath)).toBe(false);
      expect(runsCaseFile(whole, casePath, "packages/other/test/freshness.test.ts")).toBe(false);
      expect(runsCaseFile(`import { testPlanRows } from "../test/freshness.cases";\ntest.each(testPlanRows)("$id", () => {});`, casePath, "apps/web/e2e/x.spec.ts")).toBe(true);
    });
  });
});

