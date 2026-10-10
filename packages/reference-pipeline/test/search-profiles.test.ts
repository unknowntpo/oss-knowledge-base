/** Spec 016 H26: community search profiles, the one source the publisher and the Pages reader share. */
import { describe, expect, test } from "bun:test";
import { compileIdentifierProfiles, lexicalQueryTerms, lexicalSearchConfigFor } from "@oss-knowledge-base/search";

import { communitySourceProfiles, DATAFUSION_DIGEST_PROFILE, githubProjectProfiles, KAFKA_DIGEST_PROFILE } from "../src";
import {
  DATAFUSION_SEARCH_PROFILE,
  KAFKA_SEARCH_PROFILE,
  SEARCH_PROFILES,
  searchIdentifierProfiles,
} from "../src/search/profiles";

const goldenV2 = new URL("../../search/test/fixtures/golden-queries.v2.json", import.meta.url);

describe("Spec 016 community search profiles", () => {
  test("H26: every published project has a search profile, keyed by its project id", () => {
    const published = [...new Set([...githubProjectProfiles, ...communitySourceProfiles].map((profile) => profile.projectId))].sort();
    expect(published).toEqual(["apache-datafusion", "apache-kafka"]);
    expect(Object.keys(searchIdentifierProfiles).sort()).toEqual(published);
    expect(SEARCH_PROFILES.map((profile) => profile.projectId).sort()).toEqual(published);
    expect(KAFKA_SEARCH_PROFILE.projectId).toBe(KAFKA_DIGEST_PROFILE.projectId);
    expect(DATAFUSION_SEARCH_PROFILE.projectId).toBe(DATAFUSION_DIGEST_PROFILE.projectId);
    expect(searchIdentifierProfiles["apache-kafka"]).toBe(KAFKA_SEARCH_PROFILE.identifiers);
  });

  test("H26: Kafka names KIP, Jira, and GitHub numbers; DataFusion names GitHub numbers", () => {
    expect(KAFKA_SEARCH_PROFILE.identifiers.map((pattern) => `${pattern.kind} ${pattern.canonicalPrefix}`))
      .toEqual(["kip KIP-", "jira KAFKA-", "github-number #"]);
    expect(DATAFUSION_SEARCH_PROFILE.identifiers.map((pattern) => `${pattern.kind} ${pattern.canonicalPrefix}`))
      .toEqual(["github-number #"]);

    const profiles = compileIdentifierProfiles(searchIdentifierProfiles);
    expect(profiles.canonicalizeQuery("KIP770 kafka13152 #42")).toBe("KIP-770 KAFKA-13152 #42");
    expect(profiles.identifiersOf("apache-kafka", "KAFKA-13152: Add input.buffer.max.bytes based on KIP-770", "kafka:github:pull:22458"))
      .toEqual(["kip-770", "kafka-13152", "#22458"]);
    expect(profiles.identifiersOf("apache-kafka", "Improve heartbeat request manager", "kafka:jira:issue:KAFKA-19804")).toEqual(["kafka-19804"]);
    expect(profiles.identifiersOf("apache-datafusion", "KIP-770 is not a DataFusion identifier", "datafusion:github:issue:770")).toEqual(["#770"]);
    // A comment is not the pull request it belongs to; a mail message has no number.
    expect(profiles.identifiersOf("apache-kafka", "Re: a thread", "kafka:github:pull:22458:comment:9")).toEqual([]);
    expect(profiles.identifiersOf("apache-kafka", "Re: a thread", "kafka:mail:dev:message:abc770")).toEqual([]);
    expect(profiles.numberCandidates("apache-kafka", "770")).toEqual(["kip-770", "kafka-770", "#770"]);
    expect(profiles.numberCandidates("apache-datafusion", "770")).toEqual(["#770"]);
  });

  test("H26: a space is not an identifier spelling, so a version number is not an issue key", () => {
    const profiles = compileIdentifierProfiles(searchIdentifierProfiles);
    // A leading zero is kept: KIP-0770 is not KIP-770.
    expect(profiles.identifiersOf("apache-kafka", "KIP-0770 and KIP-770", "kafka:mail:dev:message:x")).toEqual(["kip-0770", "kip-770"]);
    expect(profiles.identifiersOf("apache-kafka", "[ANNOUNCE] Apache Kafka 4.2.0", "kafka:mail:dev:message:x")).toEqual([]);
    expect(profiles.canonicalizeQuery("kafka 4 KIP 770")).toBe("kafka 4 KIP 770");
    // Positive control: the hyphen-less spelling of the same text is one.
    expect(profiles.canonicalizeQuery("kafka4 KIP770")).toBe("KAFKA-4 KIP-770");
  });

  test("H26: the profiles are the ones golden v2 is evaluated with", async () => {
    const fixture = await Bun.file(goldenV2).json() as { readonly identifierProfiles: unknown };
    expect(JSON.parse(JSON.stringify(searchIdentifierProfiles))).toEqual(fixture.identifierProfiles);
  });

  test("H26: the profiles pass the lexical config validation, only from bm25-reference@2", () => {
    const config = lexicalSearchConfigFor("bm25-reference@2", searchIdentifierProfiles);
    expect(config.identifiers).toBe(searchIdentifierProfiles);
    expect(lexicalQueryTerms("KIP770", config)).toEqual(["kip-770", "kip", "770"]);
    expect(lexicalSearchConfigFor("bm25-reference@1", searchIdentifierProfiles).identifiers).toBeUndefined();
    expect(lexicalQueryTerms("KIP770", lexicalSearchConfigFor("bm25-reference@1", searchIdentifierProfiles))).toEqual(["kip770"]);
  });

  test("H26: every profile pattern stays fast on long adversarial input", () => {
    const profiles = compileIdentifierProfiles(searchIdentifierProfiles);
    const size = 50_000;
    const inputs = [
      "7".repeat(size), "KIP-".repeat(size / 4), `KIP-${"7".repeat(size)}x`, `KAFKA${"7".repeat(size)}x`,
      "#".repeat(size), `#${"7".repeat(size)}x`, "KIP-7 ".repeat(size / 6), `:github:pull:${"7".repeat(size)}x`,
      `:jira:issue:KAFKA-${"7".repeat(size)}x`, "KAFKA-".repeat(size / 6),
    ];
    expect(SEARCH_PROFILES.flatMap((profile) => profile.identifiers)).toHaveLength(4);
    for (const input of inputs) {
      const startedAt = performance.now();
      profiles.canonicalizeQuery(input);
      for (const projectId of Object.keys(searchIdentifierProfiles)) profiles.identifiersOf(projectId, input, input);
      expect(performance.now() - startedAt, input.slice(0, 16)).toBeLessThan(500);
    }
    // Positive control: the inputs do exercise the patterns.
    expect(profiles.canonicalizeQuery("KIP7 ".repeat(3))).toBe("KIP-7 KIP-7 KIP-7 ");
  });

  test("H26: core search, the serving contract, and the Pages reader hold no community literal", async () => {
    const roots = ["../../search/src", "../../serving-contract/src", "../../../apps/web/functions"];
    const literal = /\b(?:KIP|KAFKA|kafka|datafusion)\b/u;
    const offending: string[] = [];
    let files = 0;
    for (const root of roots) {
      const directory = new URL(`${root}/`, import.meta.url).pathname;
      for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: directory })) {
        files += 1;
        const code = (await Bun.file(`${directory}${path}`).text())
          .replace(/\/\*[\s\S]*?\*\//gu, "")
          .replace(/^\s*\/\/.*$/gmu, "");
        if (literal.test(code)) offending.push(`${root}/${path}`);
      }
    }
    expect(files).toBeGreaterThan(20);
    expect(offending).toEqual([]);
    // Positive control: the profile module is where the literals live.
    expect(literal.test(await Bun.file(new URL("../src/search/profiles.ts", import.meta.url)).text())).toBeTrue();
  });
});
