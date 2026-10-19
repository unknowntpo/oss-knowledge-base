/**
 * Spec 018 T17–T19 (amendment 2026-10-19): `GITHUB_INITIAL_LOOKBACK_DAYS` sets how far back a
 * publisher with no GitHub cursor reads (closed gardening G95). Prod sets 30; Dev keeps the default 1.
 */
import { describe, expect, test } from "bun:test";
import { GitHubConnector, type GitHubJsonTransport } from "@oss-knowledge-base/github-publisher/github-connector";

import { githubInitialLookbackDays } from "../src/index";

const OBSERVED_AT = "2026-10-19T22:37:00.000Z";
const DAY = 86_400_000;

async function sinceOf(days: number, previous?: Parameters<GitHubConnector["poll"]>[0]): Promise<string[]> {
  const sinces: string[] = [];
  const transport: GitHubJsonTransport = {
    async getJson<T>(url: string): Promise<T> {
      const since = new URL(url).searchParams.get("since");
      if (since !== null) sinces.push(since);
      return [] as T;
    },
  };
  await new GitHubConnector({ transport, initialLookbackDays: days, maxIssuesPerSource: 200 }).poll(previous, OBSERVED_AT);
  return sinces;
}

const config = async (environment: string) =>
  JSON.parse(await Bun.file(new URL(`../wrangler.${environment}.jsonc`, import.meta.url)).text()) as { readonly vars: Readonly<Record<string, string>> };

describe("GITHUB_INITIAL_LOOKBACK_DAYS", () => {
  test.each([
    [undefined, 1],
    ["", 1],
    ["30", 30],
    ["1", 1],
    ["35", 35],
    ["36", 35],
    ["365", 35],
    ["0", 1],
    ["-5", 1],
    ["abc", 1],
    ["7.5", 1],
    ["30d", 1],
  ])("T17: %p reads %p days back (unset or garbage 1, clamped to 1..35)", (value, days) => {
    expect(githubInitialLookbackDays({ GITHUB_INITIAL_LOOKBACK_DAYS: value })).toBe(days);
  });

  test("T18: with no cursor, 30 days reads every repository from 30 days before the run", async () => {
    const days = githubInitialLookbackDays({ GITHUB_INITIAL_LOOKBACK_DAYS: "30" });
    const expected = new Date(Date.parse(OBSERVED_AT) - 30 * DAY).toISOString();
    expect(await sinceOf(days)).toEqual([expected, expected]);
    // Unset keeps the one-day default.
    const oneDay = new Date(Date.parse(OBSERVED_AT) - DAY).toISOString();
    expect(await sinceOf(githubInitialLookbackDays({}))).toEqual([oneDay, oneDay]);
  });

  test("T18: once a repository has a cursor, the lookback is ignored for it", async () => {
    const days = githubInitialLookbackDays({ GITHUB_INITIAL_LOOKBACK_DAYS: "30" });
    const cursor = "2026-10-18T22:40:00.000Z";
    const previous = { schema: "osskb.github-checkpoint.v1", sources: { "kafka:github": { updatedAt: cursor } } } as unknown as Parameters<GitHubConnector["poll"]>[0];
    const [kafka, datafusion] = await sinceOf(days, previous);
    expect(kafka).toBe(new Date(Date.parse(cursor) - 300_000).toISOString());
    expect(datafusion).toBe(new Date(Date.parse(OBSERVED_AT) - 30 * DAY).toISOString());
  });

  test("T19: Prod sets 30; Dev leaves it unset (one day)", async () => {
    const production = await config("production");
    const development = await config("development");
    expect(production.vars.GITHUB_INITIAL_LOOKBACK_DAYS).toBe("30");
    expect(githubInitialLookbackDays(production.vars)).toBe(30);
    expect(Object.hasOwn(development.vars, "GITHUB_INITIAL_LOOKBACK_DAYS")).toBe(false);
    expect(githubInitialLookbackDays(development.vars)).toBe(1);
  });
});
