import { afterEach, describe, expect, test } from "bun:test";
import { KIP_PAGES_LAST_RUN_KEY, kipAuthorsKey } from "@oss-knowledge-base/reference-pipeline/kip-pages";
import worker from "../src/index";
import { testPlanRows } from "./kip-pages-worker.cases";

const KIP_CRON = "43 3 * * *";
const PUBLICATION_CRON = "7 22 * * *";
const NOW = Date.parse("2026-10-21T03:43:00Z");
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Options {
  readonly flag?: string;
  readonly cwiki?: "empty" | "throws";
  readonly stored?: Record<string, string>;
  readonly failPuts?: boolean;
  readonly failGets?: boolean;
}

function environment(options: Options = {}) {
  const bucketCalls: string[] = [];
  const objects = new Map(Object.entries(options.stored ?? {}));
  const jobs: string[] = [];
  const outbound: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    outbound.push(url);
    if (options.cwiki === "throws") throw new Error("cwiki is down");
    if (url.startsWith("https://cwiki.apache.org/")) return Response.json({ results: [], start: 0, limit: 50, size: 0, _links: { base: "https://cwiki.apache.org/confluence" } });
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const object = (name: string, body: unknown) => ({
    idFromName: (id: string) => id,
    get: () => ({
      fetch: async (url: string, init?: RequestInit) => {
        jobs.push(`${name} ${init?.method ?? "GET"} ${url}`);
        return Response.json(body, { status: url.endsWith("/run") ? 202 : 200 });
      },
    }),
  });
  const env = {
    PUBLICATION_ENVIRONMENT: "development",
    MANUAL_TRIGGER_TOKEN: "manual-under-test",
    KIP_PAGES_CRON: KIP_CRON,
    DIGEST_CRON: "47 22 * * *",
    PIPELINE_STATE: object("publication", { environment: "development", running: false }),
    DIGEST_RUN: object("digest", { running: false }),
    OSS_KB_BUCKET: {
      get: async (key: string) => {
        bucketCalls.push(`get ${key}`);
        if (options.failGets === true) throw new Error("R2 get failed");
        const body = objects.get(key);
        return body === undefined ? null : { text: async () => body, json: async () => JSON.parse(body) };
      },
      put: async (key: string, body: string) => {
        bucketCalls.push(`put ${key}`);
        if (options.failPuts === true) throw new Error("R2 put failed");
        objects.set(key, body);
        return {};
      },
    },
    ...(options.flag === undefined ? {} : { KIP_PAGES: options.flag }),
  };
  const tick = async (cron: string) => {
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ cron, scheduledTime: NOW } as never, env as never, { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as never);
    await Promise.all(pending);
  };
  const request = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://data.example${path}`, init), env as never);
  return { env, bucketCalls, objects, jobs, outbound, tick, request };
}

const run = (token?: string) => ({ method: "POST", ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }) });

const checks: Record<string, () => Promise<void>> = {
  "W98 isolation": async () => {
    const failing = environment({ flag: "authors@1", cwiki: "throws", failPuts: true });
    await failing.tick(KIP_CRON);
    expect(failing.jobs).toEqual([]);
    expect(failing.outbound.length).toBe(1);
    expect(failing.bucketCalls.every((call) => call.split(" ")[1]!.startsWith("internal/kips/v1/"))).toBe(true);
    // A bucket that fails its reads as well: still nothing else started, and the tick resolves.
    const unreadable = environment({ flag: "authors@1", failGets: true, failPuts: true });
    await unreadable.tick(KIP_CRON);
    expect([unreadable.jobs, unreadable.outbound]).toEqual([[], []]);
    expect(unreadable.bucketCalls.every((call) => call.split(" ")[1]!.startsWith("internal/kips/v1/"))).toBe(true);
  },
  "W98 the publication tick": async () => {
    const on = environment({ flag: "authors@1" });
    await on.tick(PUBLICATION_CRON);
    expect(on.jobs).toEqual(["publication POST https://pipeline.internal/run"]);
    expect(on.outbound.filter((url) => url.includes("cwiki.apache.org") || url.includes("issues.apache.org"))).toEqual([]);
    expect(on.bucketCalls.filter((call) => call.includes("internal/kips/"))).toEqual([]);
    const digest = environment({ flag: "authors@1" });
    await digest.tick("47 22 * * *");
    expect(digest.jobs).toEqual(["digest POST https://digest.internal/run"]);
    expect(digest.outbound).toEqual([]);
  },
  "W99 job off": async () => {
    for (const flag of [undefined, "", "  "]) {
      const off = environment(flag === undefined ? {} : { flag });
      await off.tick(KIP_CRON);
      expect([off.jobs, off.outbound, off.bucketCalls]).toEqual([[], [], []]);
      for (const token of [undefined, "manual-under-test"]) {
        const response = await off.request("/kip-pages/run", run(token));
        expect(response.status).toBe(404);
      }
      expect([off.outbound, off.bucketCalls]).toEqual([[], []]);
      const health = await (await off.request("/health")).json() as Record<string, unknown>;
      expect("kipPages" in health).toBe(false);
      expect(off.bucketCalls.filter((call) => call.includes("internal/kips/"))).toEqual([]);
    }
  },
  "W99 positive control": async () => {
    const on = environment({ flag: "authors@1" });
    await on.tick(KIP_CRON);
    expect(on.jobs).toEqual([]);
    expect(on.outbound.length).toBe(1);
    expect(on.outbound[0]).toStartWith("https://cwiki.apache.org/confluence/rest/api/content/search?");
    expect(on.bucketCalls).toContain(`put ${KIP_PAGES_LAST_RUN_KEY}`);
    expect(on.bucketCalls).toContain(`put ${kipAuthorsKey("apache-kafka")}`);
    expect((await on.request("/kip-pages/run", run())).status).toBe(401);
    expect((await on.request("/kip-pages/run", run("wrong"))).status).toBe(401);
    const manual = await on.request("/kip-pages/run?dryRun=1", run("manual-under-test"));
    expect(manual.status).toBe(200);
    const body = await manual.json() as { lastRun: { ok: boolean; status: string; r2: { classA: number } } };
    expect(body.lastRun).toMatchObject({ ok: true, status: "unchanged", r2: { classA: 0 } });
  },
  "W100 health shape": async () => {
    const on = environment({ flag: "authors@1" });
    await on.tick(KIP_CRON);
    const health = await (await on.request("/health")).json() as { kipPages: Record<string, unknown> };
    expect(health.kipPages).toEqual(JSON.parse(on.objects.get(KIP_PAGES_LAST_RUN_KEY)!));
    expect(Object.keys(health.kipPages).sort()).toEqual(["coverageFrom", "lastGoodAt", "lastRun", "revision"]);
    expect(Object.keys(health.kipPages.lastRun as object).sort()).toEqual(["at", "bytesWritten", "durationMs", "issuesRead", "jiraRequests", "listed", "ok", "pagesChanged", "pagesRead", "r2", "requests", "since", "status", "unassigned", "unparsed"]);
    const before = environment({ flag: "authors@1" });
    expect((await (await before.request("/health")).json() as { kipPages: unknown }).kipPages).toEqual({ revision: "authors@1", lastRun: null, lastGoodAt: null, coverageFrom: null });
    const unreadable = environment({ flag: "authors@1", stored: { [KIP_PAGES_LAST_RUN_KEY]: "{not json" } });
    const body = await (await unreadable.request("/health")).json() as Record<string, unknown>;
    expect("kipPages" in body && body.kipPages === null).toBe(true);
  },
};

describe("Spec 019 amendment (7) slice B: the kip-pages job in the publisher Worker", () => {
  test("every case row has a check and every check a row", () => {
    expect(Object.keys(checks).sort()).toEqual(testPlanRows.map((row) => `${row.id} ${row.case}`).sort());
  });

  test.each([...testPlanRows])("$id: $case ($data)", async (row) => {
    const check = checks[`${row.id} ${row.case}`];
    if (check === undefined) throw new Error(`no check for ${row.id} ${row.case}`);
    await check();
  });

  test("W99: both Worker configurations leave KIP_PAGES, KIP_PAGES_CRON and the 03:43 cron entry unset", async () => {
    for (const name of ["development", "production"]) {
      const text = await Bun.file(new URL(`../wrangler.${name}.jsonc`, import.meta.url)).text();
      const config = JSON.parse(text) as { vars?: Record<string, string>; triggers?: { crons?: string[] } };
      expect("KIP_PAGES" in (config.vars ?? {})).toBe(false);
      expect("KIP_PAGES_CRON" in (config.vars ?? {})).toBe(false);
      expect(config.triggers?.crons ?? []).not.toContain(KIP_CRON);
    }
  });
});
