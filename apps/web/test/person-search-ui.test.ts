/**
 * Spec 019 slice 3 (W7): how the Feed merges person results of several projects, and which
 * projects it asks. Browser checks (placement, layout at 320/375 px) live in `e2e/people.spec.ts`.
 */
import { describe, expect, test } from "bun:test";

import { PEOPLE_SEARCH_SCHEMA, type PeopleSearchV1, type PersonMatchV1 } from "@oss-knowledge-base/reference-pipeline/people/search";

import { mergePersonResults, personSearchProjects } from "../src/person-search";

const response = (project: string, people: readonly (readonly [string, PersonMatchV1["match"]])[]): PeopleSearchV1 => ({
  schema: PEOPLE_SEARCH_SCHEMA,
  project,
  query: "x",
  people: people.map(([login, match]) => ({ id: `github:${login}`, source: "github", display: login, match })),
});

const listed = (responses: readonly PeopleSearchV1[]) =>
  mergePersonResults(responses).map((result) => `${result.projectKey} ${result.display} ${result.match}`);

describe("Spec 019 slice 3: merging person results", () => {
  test("W7: an exact match in any project comes before every prefix match; at most 3 in all", () => {
    expect(listed([
      response("kafka", [["alamb-x", "prefix"], ["alamb-y", "prefix"], ["alamb-z", "prefix"]]),
      response("datafusion", [["alamb", "exact"], ["alamb-a", "prefix"]]),
    ])).toEqual(["datafusion alamb exact", "datafusion alamb-a prefix", "kafka alamb-x prefix"]);
  });

  test("W7: the same login in two projects keeps both, in project order", () => {
    expect(listed([
      response("datafusion", [["chia7712", "exact"]]),
      response("kafka", [["chia7712", "exact"]]),
    ])).toEqual(["kafka chia7712 exact", "datafusion chia7712 exact"]);
  });

  test("W7: prefix matches are alphabetical without regard to case", () => {
    expect(listed([response("kafka", [["lu-a", "prefix"], ["Lu-C", "prefix"]]), response("datafusion", [["lu-b", "prefix"]])]))
      .toEqual(["kafka lu-a prefix", "datafusion lu-b prefix", "kafka Lu-C prefix"]);
  });

  test("W7: a result links to the profile route with the id encoded", () => {
    expect(mergePersonResults([response("kafka", [["chia7712", "exact"]])])[0]?.route).toBe("/kafka/people/github%3Achia7712");
    expect(mergePersonResults([response("kafka", [["chia7712", "exact"]])])[0]?.projectLabel).toBe("Apache Kafka");
  });

  test("W7: no project filter asks every project with profiles; a filter asks only that one", () => {
    expect(personSearchProjects("")).toEqual(["kafka", "datafusion"]);
    expect(personSearchProjects("datafusion")).toEqual(["datafusion"]);
    expect(personSearchProjects("flink")).toEqual([]);
  });
});
