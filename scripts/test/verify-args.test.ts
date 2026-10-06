import { describe, expect, test } from "bun:test";

import {
  defaultSelectors,
  formatHealth,
  formatUiSummary,
  judgeHealth,
  parseAt,
  parseHealthArgs,
  parseUiArgs,
  resolveAt,
  UsageError,
  type HealthReport,
} from "../verify/args";

const now = new Date("2026-10-06T10:00:00.000Z");
const generatedAt = "2026-08-25T12:00:00Z";
const hour = 3_600_000;

describe("parseUiArgs", () => {
  test("defaults to the local fixture server, Feed, 375 px, English, real clock", () => {
    expect(parseUiArgs([], now)).toEqual({
      target: "local",
      route: "/",
      views: ["feed"],
      query: "KIP-405",
      width: 375,
      height: 800,
      locale: "en",
      at: "now",
      frozen: false,
      selectors: [...defaultSelectors],
      out: "test-results/verify/2026-10-06T10-00-00-000Z",
    });
  });

  test("reads every option, the `--` separator, `=` values and comma-separated views", () => {
    const options = parseUiArgs(
      ["--", "--target", "dev", "--view=feed,search-detail", "--width", "320", "--locale", "zh-Hant",
        "--at", "+3h1s", "--frozen", "--selector", ".brand-mark", "--out", "evidence/v5"],
      now,
    );
    expect(options).toMatchObject({
      target: "dev",
      views: ["feed", "search-detail"],
      width: 320,
      locale: "zh-Hant",
      at: "+3h1s",
      frozen: true,
      out: "evidence/v5",
    });
    expect(options.selectors.at(-1)).toBe(".brand-mark");
  });

  test.each([
    [["--target", "prod"], /--target/u],
    [["--width", "0"], /--width/u],
    [["--locale", "fr"], /--locale/u],
    [["--view", "home"], /--view/u],
    [["--route", "feed"], /--route/u],
    [["--at", "tomorrow"], /--at/u],
    [["--bogus", "1"], /unknown option/u],
    [["--width"], /needs a value/u],
    [["stray"], /unexpected argument/u],
  ])("rejects %p", (argv, message) => {
    expect(() => parseUiArgs(argv, now)).toThrow(message);
    expect(() => parseUiArgs(argv, now)).toThrow(UsageError);
  });

  test("health accepts only a target", () => {
    expect(parseHealthArgs(["--target", "dev"])).toEqual({ target: "dev" });
    expect(() => parseHealthArgs(["--at", "now"])).toThrow(UsageError);
  });
});

describe("clock resolution", () => {
  test.each([
    ["+3h1s", 3 * hour + 1_000],
    ["+3h23m", 3 * hour + 23 * 60_000],
    ["+1h", hour],
    ["-30s", -30_000],
    ["+1d2h3m4s5ms", 86_400_000 + 2 * hour + 3 * 60_000 + 4_005],
  ])("%s is an offset from generatedAt", (at, offset) => {
    expect(resolveAt(parseAt(at), generatedAt)).toBe(Date.parse(generatedAt) + offset);
  });

  test("an ISO time is absolute and ignores generatedAt", () => {
    expect(resolveAt(parseAt("2026-08-25T15:00:01Z"), undefined)).toBe(Date.parse("2026-08-25T15:00:01Z"));
    expect(resolveAt(parseAt("2026-08-25T23:00:00+08:00"), undefined)).toBe(Date.parse("2026-08-25T15:00:00Z"));
  });

  test("now keeps the real clock", () => {
    expect(resolveAt(parseAt("now"), generatedAt)).toBeUndefined();
  });

  test("a time without a zone, or a relative time without a parsable generatedAt, is refused", () => {
    expect(() => parseAt("2026-08-25T15:00:00")).toThrow(UsageError);
    expect(() => parseAt("3h")).toThrow(UsageError);
    expect(() => resolveAt(parseAt("+3h"), "not-a-time")).toThrow(/generatedAt/u);
    expect(() => resolveAt(parseAt("+3h"), undefined)).toThrow(/generatedAt/u);
  });
});

describe("summaries", () => {
  test("the UI summary prints one line per present element, flags overflow, and skips absent ones", () => {
    const text = formatUiSummary({
      target: "dev",
      baseUrl: "https://example.test",
      width: 375,
      height: 800,
      locale: "en",
      generatedAt,
      clock: "2026-08-25T15:23:00.000Z",
      frozen: false,
      captures: [
        {
          view: "feed",
          url: "https://example.test/#/",
          screenshot: "/tmp/feed.png",
          htmlLang: "en",
          pageOverflowX: false,
          elements: [
            {
              selector: ".demo-pill",
              count: 1,
              visible: true,
              className: "demo-pill is-stale",
              text: "Data may be out of date ·\n 3 h ago",
              box: { x: 60.4, y: 10, width: 200.2, height: 40 },
              overflowX: false,
            },
            { selector: ".search-card", count: 0, visible: false },
            { selector: ".topic-wrap", count: 1, visible: false, className: "topic-wrap", overflowX: true },
          ],
        },
      ],
    });
    expect(text).toBe(
      [
        "dev https://example.test 375x800 en clock=2026-08-25T15:23:00.000Z generatedAt=2026-08-25T12:00:00Z",
        "[feed] https://example.test/#/ lang=en pageOverflowX=false",
        '  .demo-pill x1 visible class="demo-pill is-stale" box=60,10,200x40 "Data may be out of date · 3 h ago"',
        '  .topic-wrap x1 hidden,overflowX class="topic-wrap"',
      ].join("\n"),
    );
  });

  const report = (overrides: Partial<HealthReport> = {}): HealthReport => ({
    target: "dev",
    now: "2026-08-25T13:00:00.000Z",
    publisher: {
      url: "https://worker.test",
      running: false,
      phase: null,
      lastRunOk: true,
      completedAt: "2026-08-25T12:00:00.000Z",
      feedReleaseId: "r1",
    },
    feed: { url: "https://pages.test", generatedAt: "2026-08-25T12:00:00.000Z", releaseId: "r1" },
    ...overrides,
  });

  test("health is consistent when both sides name the same release and time", () => {
    const verdict = judgeHealth(report(), 3 * hour);
    expect(verdict).toEqual({ consistent: true, ageMinutes: 60, staleInUi: false });
    expect(formatHealth(report(), verdict).split("\n").at(-1)).toBe("consistent=true age=60m staleInUi=false");
  });

  test("a feed behind the publisher is inconsistent; past 3 h or metadata.stale is stale", () => {
    const behind = report({ feed: { url: "https://pages.test", generatedAt: "2026-08-25T11:00:00.000Z", releaseId: "r0" } });
    expect(judgeHealth(behind, 3 * hour).consistent).toBe(false);
    expect(judgeHealth(report({ now: "2026-08-25T15:00:01.000Z" }), 3 * hour).staleInUi).toBe(true);
    expect(judgeHealth(report({ now: "2026-08-25T15:00:00.000Z" }), 3 * hour).staleInUi).toBe(false);
    const cached = report({ feed: { url: "https://pages.test", generatedAt: "2026-08-25T12:00:00.000Z", releaseId: "r1", stale: true } });
    expect(judgeHealth(cached, 3 * hour).staleInUi).toBe(true);
  });

  test("the same time with another release is inconsistent (verify:health exits 1)", () => {
    const otherRelease = report({ feed: { url: "https://pages.test", generatedAt: "2026-08-25T12:00:00.000Z", releaseId: "r2" } });
    expect(judgeHealth(otherRelease, 3 * hour).consistent).toBe(false);
  });

  test("age rounds down to whole minutes and a feed ahead of the clock is age 0", () => {
    expect(judgeHealth(report({ now: "2026-08-25T12:59:59.000Z" }), 3 * hour).ageMinutes).toBe(59);
    expect(judgeHealth(report({ now: "2026-08-25T11:00:00.000Z" }), 3 * hour)).toMatchObject({ ageMinutes: 0, staleInUi: false });
  });

  test("a target without a publisher reports consistency as n/a", () => {
    const { publisher: _omit, ...local } = report({ target: "local" });
    const verdict = judgeHealth(local, 3 * hour);
    expect(verdict.consistent).toBeUndefined();
    expect(formatHealth(local, verdict)).toContain("publisher (none for this target)");
  });
});
