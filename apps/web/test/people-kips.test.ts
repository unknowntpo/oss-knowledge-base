/**
 * Spec 019 amendment (7), slice C: the KIP-authors rows of the profile's KIPs section
 * (`packages/reference-pipeline/test/kip-authors.cases.ts`), and the response scans of W110.
 * The checks and fixtures are in `people-kips.checks.ts`.
 */
import { beforeAll, describe, expect, test } from "bun:test";

import { identityLinksKey } from "@oss-knowledge-base/reference-pipeline";
import { profileIdentityLinksKey, type PersonProfileV1 } from "@oss-knowledge-base/reference-pipeline/people";

import { testPlanRows } from "../../../packages/reference-pipeline/test/kip-authors.cases";
import {
  api,
  authorsTable,
  bases,
  GITHUB_LOGINS,
  JIRA,
  KAFKA,
  kipAuthorChecks,
  lineOf,
  Month,
  page,
  profile,
  render,
  setUpKips,
  withRecorded,
} from "./people-kips.checks";

beforeAll(setUpKips);

describe("Spec 019 amendment (7), slice C: the KIPs section", () => {
  test("every case row has a check and every check a row", () => {
    expect(Object.keys(kipAuthorChecks).sort()).toEqual([...new Set(testPlanRows.map((row) => `${row.id}|${row.case}`))].sort());
  });

  test.each(testPlanRows)("$id: $case ($data) — $input", async (row) => {
    await kipAuthorChecks[`${row.id}|${row.case}`]!();
  });

  test("W110: no /api/people response or page carries a Jira account key, user name, time zone or avatar", async () => {
    const keys = JIRA.response.issues.flatMap((issue) => (issue.fields.assignee == null ? [] : [issue.fields.assignee.key, issue.fields.assignee.name]))
      .filter((value) => !GITHUB_LOGINS.has(value.toLowerCase()));
    expect(keys).toContain("JIRAUSER306218");
    const month = new Month("2026-10").issue("KAFKA-90008", "TengYao Chi", null).build();
    for (const person of ["github:unknowntpo", "mail:eric chang", "jira:tengyao chi", "mail:viktor somogyi-vass"]) {
      const response = await api(person, { flag: "true", months: withRecorded(month) });
      expect(response.status).toBe(200);
      const json = await response.text();
      for (const output of [json, await render(JSON.parse(json) as PersonProfileV1)]) {
        // Display names are shown; keys and user names never (a key equal to a GitHub login could only appear as that login's own profile id).
        for (const key of keys) expect(output).not.toMatch(new RegExp(`(?<![\\w:/])${key}(?![\\w])`, "u"));
        expect(output).not.toMatch(/timeZone|avatarUrls|"active"|emailAddress/u);
      }
    }
    // Positive control: the recorded TengYao Chi holds two KIP-1128 issues, named on his page by display name only.
    const body = await profile("jira:tengyao chi", { months: withRecorded(month) });
    expect(bases(lineOf(body, "KIP-1128"))).toEqual(["assignee KAFKA-17178,KAFKA-19688"]);
  });

  test("W94: a renumbered KIP (two pages, one number): the discussion is a line of its own, never pinned to either page", async () => {
    const month = new Month("2026-10").mail("t9800", "[DISCUSS] KIP-9800: second use", "Renumber Person", "04", true).build();
    const authors = authorsTable([page(9800, { title: "First use" }), { ...page(9800, { title: "Second use" }), pageId: "990001" }]);
    const body = await profile("mail:renumber person", { months: [month], authors });
    expect(body.kips!.lines.map((line) => [line.kip, line.pageUrl, bases(line)])).toEqual([["KIP-9800", undefined, ["starter"]]]);
    // Positive control: with one page, the discussion is on that page's line.
    const single = await profile("mail:renumber person", { months: [month], authors: authorsTable([page(9800)]) });
    expect(single.kips!.lines[0]!.pageUrl).toStartWith("https://cwiki.apache.org/");
  });

  test("W87: the page reads the identity-link job's own key", () => {
    expect(profileIdentityLinksKey(KAFKA)).toBe(identityLinksKey(KAFKA));
  });
});
