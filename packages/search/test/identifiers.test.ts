import { describe, expect, test } from "bun:test";

import {
  buildLexicalIndex,
  codeTextLexicalSearchConfig,
  compileIdentifierProfiles,
  defaultLexicalSearchConfig,
  lexicalQueryTerms,
  lexicalShardPostings,
  searchLexicalIndex,
  type IdentifierPatternV1,
  type IdentifierProfilesV1,
} from "../src";
import { testPlanRows } from "./identifiers.cases";
import { codeTextConfig, loadGoldenV2 } from "./support/golden-v2";

interface CaseRow {
  readonly id: string;
  readonly case: string;
  readonly query: string;
  readonly projects: string | null;
  readonly exact: string;
}

async function search(query: string, projects: string | null = null) {
  const golden = await loadGoldenV2();
  const index = buildLexicalIndex({ indexRevision: "test", chunks: golden.chunks, config: codeTextConfig(golden) });
  return searchLexicalIndex(index, {
    query,
    ...(projects === null ? {} : { filters: { projectIds: projects.split(" ") } }),
    limit: 20,
  });
}

describe("Spec 016 community identifiers (bm25-reference@2 with profiles)", () => {
  test.each([...testPlanRows] as CaseRow[])("$id: $case ($query)", async ({ query, projects, exact }) => {
    const results = await search(query, projects);
    const exactRoots = results.filter((result) => result.exactMatch).map((result) => result.groupRootRecordId);
    expect(exactRoots.join(" ")).toBe(exact);
    // Exact matches are a prefix of the ranking.
    expect(results.slice(0, exactRoots.length).every((result) => result.exactMatch)).toBeTrue();
  });

  test("H3: KIP770 returns exactly what KIP-770 returns", async () => {
    const canonical = await search("KIP-770");
    expect(canonical.length).toBeGreaterThan(2);
    for (const spelling of ["KIP770", "kip770", "kip-770", " KIP770 "]) {
      expect(await search(spelling), spelling).toEqual(canonical);
    }
  });

  test("H3: a spelling inside a longer query is normalized too", async () => {
    const golden = await loadGoldenV2();
    const config = codeTextConfig(golden);
    expect(lexicalQueryTerms("KIP770 buffer", config)).toEqual(lexicalQueryTerms("KIP-770 buffer", config));
    expect(lexicalQueryTerms("KIP770 buffer", config)).toEqual(["kip-770", "kip", "770", "buffer"]);
    // Without a profile the spelling stays one opaque token.
    expect(lexicalQueryTerms("KIP770 buffer", codeTextLexicalSearchConfig)).toEqual(["kip770", "buffer"]);
  });

  test("H3: a title written without the hyphen is indexed under the canonical identifier", () => {
    const profiles: IdentifierProfilesV1 = {
      p: [{ kind: "kip", canonicalPrefix: "KIP-", textPattern: "\\bKIP-?(\\d+)\\b" }],
    };
    const chunk = {
      schema: "osskb.source-record-chunk.v1", id: "c1", projectId: "p", sourceInstanceId: "s", recordId: "r1",
      groupRootRecordId: "r1", ordinal: 0, title: "Notes on kip770", text: "body", canonicalUrl: "https://example.org/1",
      author: "a", occurredAt: "2026-01-01T00:00:00Z", sourceVersion: "v", tags: [], contentHash: `sha256:${"0".repeat(64)}`,
    } as const;
    const index = buildLexicalIndex({ indexRevision: "test", chunks: [chunk], config: { ...codeTextLexicalSearchConfig, identifiers: profiles } });
    expect(searchLexicalIndex(index, { query: "KIP-770" }).map((result) => result.exactMatch)).toEqual([true]);
    const withoutProfile = buildLexicalIndex({ indexRevision: "test", chunks: [chunk], config: codeTextLexicalSearchConfig });
    expect(searchLexicalIndex(withoutProfile, { query: "KIP-770" })).toEqual([]);
  });

  test("H4: without a profile a bare number is an ordinary term, not an identifier", async () => {
    const golden = await loadGoldenV2();
    const index = buildLexicalIndex({ indexRevision: "test", chunks: golden.chunks, config: codeTextLexicalSearchConfig });
    const results = searchLexicalIndex(index, { query: "770", limit: 20 });
    expect(results.some((result) => result.exactMatch)).toBeFalse();
    expect(results.map((result) => result.groupRootRecordId)).not.toContain("datafusion:github:pull:770");
    // Positive control: the same query with the profile lists the pull request.
    expect((await search("770")).map((result) => result.groupRootRecordId)).toContain("datafusion:github:pull:770");
  });

  test("H15: identifier profiles are rejected with bm25-reference@1", () => {
    const identifiers: IdentifierProfilesV1 = { p: [{ kind: "kip", canonicalPrefix: "KIP-", textPattern: "KIP-?(\\d+)" }] };
    expect(() => buildLexicalIndex({ indexRevision: "test", chunks: [], config: { ...defaultLexicalSearchConfig, identifiers } }))
      .toThrow("Identifier profiles require bm25-reference@2, not bm25-reference@1");
    expect(() => lexicalShardPostings([], { ...defaultLexicalSearchConfig, identifiers })).toThrow("require bm25-reference@2");
    expect(buildLexicalIndex({ indexRevision: "test", chunks: [], config: { ...codeTextLexicalSearchConfig, identifiers } }).lexicalRevision)
      .toBe("bm25-reference@2");
  });

  const rejectedPatterns: readonly (readonly [string, IdentifierPatternV1, string])[] = [
    ["no pattern at all", { kind: "kip", canonicalPrefix: "KIP-" }, "needs a textPattern or a recordIdPattern"],
    ["no capture group", { kind: "kip", canonicalPrefix: "KIP-", textPattern: "KIP-?\\d+" }, "exactly one capture group"],
    ["two capture groups", { kind: "kip", canonicalPrefix: "KIP-", textPattern: "(KIP)-?(\\d+)" }, "exactly one capture group"],
    ["invalid expression", { kind: "kip", canonicalPrefix: "KIP-", recordIdPattern: "(\\d+" }, "is not a valid RegExp"],
    ["empty prefix", { kind: "kip", canonicalPrefix: " ", textPattern: "KIP-?(\\d+)" }, "needs a canonicalPrefix"],
    ["empty kind", { kind: "", canonicalPrefix: "KIP-", textPattern: "KIP-?(\\d+)" }, "needs a kind"],
    ["a quantified group that holds a quantifier", { kind: "kip", canonicalPrefix: "KIP-", textPattern: "KIP-?(\\d+)+x" }, "nested quantifier"],
    ["a starred group that holds a quantifier", { kind: "kip", canonicalPrefix: "KIP-", recordIdPattern: "(?:a+)*:(\\d+)$" }, "nested quantifier"],
  ];

  test.each(rejectedPatterns)("H15: a profile pattern with %s is rejected", (_case, pattern, message) => {
    expect(() => compileIdentifierProfiles({ p: [pattern] })).toThrow(message);
    expect(() => compileIdentifierProfiles({ p: [{ kind: "kip", canonicalPrefix: "KIP-", textPattern: "KIP-?(\\d+)" }] })).not.toThrow();
  });

  const optionalNumbers: readonly (readonly [string, IdentifierPatternV1, string, string])[] = [
    ["an optional capture group", { kind: "k", canonicalPrefix: "K-", textPattern: "\\bK(\\d+)?\\b" }, "K", "K notes"],
    ["a capture group that can be empty", { kind: "k", canonicalPrefix: "K-", textPattern: "\\bK(\\d*)\\b" }, "K", "K notes"],
    ["a capture group that is not a number", { kind: "k", canonicalPrefix: "K-", textPattern: "\\bK-(\\w+)\\b" }, "K-abc", "K-abc notes"],
    ["an optional group in the record id", { kind: "k", canonicalPrefix: "K-", recordIdPattern: "^r(\\d+)?" }, "K", "K notes"],
  ];

  test.each(optionalNumbers)("H15: a match of %s without a number is not an identifier", (_case, pattern, query, title) => {
    const profiles = compileIdentifierProfiles({ p: [pattern] });
    expect(profiles.canonicalizeQuery(query)).toBe(query);
    expect(profiles.identifiersOf("p", title, "r")).toEqual([]);
    // Positive control: with a number the same pattern yields the canonical identifier.
    if (pattern.textPattern !== undefined && pattern.textPattern.includes("\\d")) {
      expect(profiles.canonicalizeQuery("K7")).toBe("K-7");
      expect(profiles.identifiersOf("p", "K7 notes", "r")).toEqual(["k-7"]);
    }
    if (pattern.recordIdPattern !== undefined) expect(profiles.identifiersOf("p", title, "r7")).toEqual(["k-7"]);
  });

  test("H15: every fixture profile pattern stays fast on long adversarial input", async () => {
    const golden = await loadGoldenV2();
    const profiles = compileIdentifierProfiles(golden.identifierProfiles);
    const size = 50_000;
    const inputs = [
      "7".repeat(size), "KIP-".repeat(size / 4), `KIP-${"7".repeat(size)}x`, `KAFKA${"7".repeat(size)}x`,
      "#".repeat(size), `#${"7".repeat(size)}x`, "KIP-7 ".repeat(size / 6), `:github:pull:${"7".repeat(size)}x`,
    ];
    expect(Object.values(golden.identifierProfiles).flat().length).toBe(4);
    for (const input of inputs) {
      const startedAt = performance.now();
      profiles.canonicalizeQuery(input);
      for (const projectId of Object.keys(golden.identifierProfiles)) profiles.identifiersOf(projectId, input, input);
      expect(performance.now() - startedAt, input.slice(0, 16)).toBeLessThan(500);
    }
    // Positive control: the inputs do exercise the patterns.
    expect(profiles.canonicalizeQuery("KIP7 ".repeat(3))).toBe("KIP-7 KIP-7 KIP-7 ");
  });
});
