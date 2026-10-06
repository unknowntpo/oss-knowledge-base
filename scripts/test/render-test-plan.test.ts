import { describe, expect, test } from "bun:test";

import { renderSpec, renderTable } from "../render-test-plan";

const rows = [
  { id: "F1", input: "a|b", expected: "x", stale: false },
  { id: "F4", input: "bad", expected: null, stale: true },
];

describe("test-plan rendering", () => {
  test("renders every case-file row with readable nulls, booleans, and escaped pipes", () => {
    expect(renderTable(rows)).toBe([
      "| id | input | expected | stale |",
      "| --- | --- | --- | --- |",
      "| F1 | a\\|b | x | no |",
      "| F4 | bad | — | yes |",
      "",
    ].join("\n"));
  });

  test("replaces only the generated block and is stable when rendered twice", async () => {
    const spec = "intro\n<!-- test-plan:start cases.ts -->\nold table\n<!-- test-plan:end -->\noutro\n";
    const once = await renderSpec(spec, async () => rows);
    expect(once).toStartWith("intro\n<!-- test-plan:start cases.ts -->\n| id |");
    expect(once).toEndWith("<!-- test-plan:end -->\noutro\n");
    expect(await renderSpec(once, async () => rows)).toBe(once);
  });
});
