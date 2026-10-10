import { describe, expect, test } from "bun:test";

import {
  AccessChallengeError,
  AccessConfigError,
  accessChallengeMessage,
  accessHeadersFor,
  getWithAccess,
  isAccessChallenge,
  isAccessProtected,
  accessRouteHandler,
  readAccessHeaders,
  redactSecrets,
  scopeAccessRequest,
} from "../verify/access";

const id = "test-id.access";
const secret = "test-secret";
const headers = { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };

describe("readAccessHeaders", () => {
  test("both variables set: both headers", () => {
    expect(readAccessHeaders({ CF_ACCESS_CLIENT_ID: id, CF_ACCESS_CLIENT_SECRET: secret })).toEqual(headers);
  });

  test("neither set (or empty, as GitHub passes a missing secret): no headers, so runs before Access exists are unchanged", () => {
    expect(readAccessHeaders({})).toBeUndefined();
    expect(readAccessHeaders({ CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" })).toBeUndefined();
  });

  test("values are used verbatim, not trimmed, so they still match GitHub's log masking", () => {
    expect(readAccessHeaders({ CF_ACCESS_CLIENT_ID: ` ${id}`, CF_ACCESS_CLIENT_SECRET: `${secret}\n` })).toEqual({
      "CF-Access-Client-Id": ` ${id}`,
      "CF-Access-Client-Secret": `${secret}\n`,
    });
  });

  test("only one set: a configuration error that does not print the value", () => {
    expect(() => readAccessHeaders({ CF_ACCESS_CLIENT_ID: id })).toThrow(AccessConfigError);
    try {
      readAccessHeaders({ CF_ACCESS_CLIENT_SECRET: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe("header scoping", () => {
  test.each([
    ["https://oss-knowledge-base-dev.pages.dev/api/feed", true],
    ["https://oss-knowledge-base-dev.pages.dev", true],
    ["https://1a2b3c4d.oss-knowledge-base-dev.pages.dev/#/kafka/threads", true],
    ["https://codex-branch.oss-knowledge-base-dev.pages.dev/api/search?q=x", true],
    ["https://OSS-KNOWLEDGE-BASE-DEV.pages.dev/", true],
    // Not the Dev Pages site: the token must never go here.
    ["https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/health", false],
    ["https://oss-knowledge-base.pages.dev/api/feed", false],
    ["https://evil-oss-knowledge-base-dev.pages.dev/", false],
    ["https://oss-knowledge-base-dev.pages.dev.evil.example/", false],
    ["http://oss-knowledge-base-dev.pages.dev/", false],
    ["http://127.0.0.1:8788/api/feed", false],
    ["https://fonts.googleapis.com/css2", false],
    ["not a url", false],
  ])("%s -> protected=%p", (url, protectedOrigin) => {
    expect(isAccessProtected(url)).toBe(protectedOrigin);
    expect(accessHeadersFor(url, headers)).toEqual(protectedOrigin ? headers : {});
  });

  test("no token configured: no headers anywhere", () => {
    expect(accessHeadersFor("https://oss-knowledge-base-dev.pages.dev/", undefined)).toEqual({});
  });
});

describe("isAccessChallenge", () => {
  const login = "https://unknowntpo.cloudflareaccess.com/cdn-cgi/access/login/oss-knowledge-base-dev.pages.dev?redirect_url=%2F";
  test.each([
    [{ status: 302, url: "https://oss-knowledge-base-dev.pages.dev/api/feed", location: login }, true],
    [{ status: 403, url: "https://oss-knowledge-base-dev.pages.dev/", location: login }, true],
    [{ status: 401, location: login }, true],
    [{ status: 200, url: login }, true],
    [{ status: 302, location: "https://oss-knowledge-base-dev.pages.dev/#/kafka/" }, false],
    [{ status: 302, location: "/login" }, false],
    // Access answers a missing or rejected service token on the protected host with 401/403 and no Location.
    [{ status: 403, url: "https://oss-knowledge-base-dev.pages.dev/" }, true],
    [{ status: 401, url: "https://abc123.oss-knowledge-base-dev.pages.dev/api/feed" }, true],
    [{ status: 403, url: "https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/health" }, false],
    // Status matters: a non-redirect, non-denial with an Access Location is not a challenge.
    [{ status: 200, url: "https://oss-knowledge-base-dev.pages.dev/", location: login }, false],
    [{ status: 500, url: "https://oss-knowledge-base-dev.pages.dev/", location: login }, false],
    [{ status: 200, url: "https://oss-knowledge-base-dev.pages.dev/api/feed", location: null }, false],
    [{ status: 302, location: "https://cloudflareaccess.com.evil.example/" }, false],
  ])("%j -> %p", (response, expected) => {
    expect(isAccessChallenge(response)).toBe(expected);
  });
});

describe("getWithAccess", () => {
  const login = "https://unknowntpo.cloudflareaccess.com/cdn-cgi/access/login/x";
  function fakeFetch(response: Response) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const impl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return response;
    };
    return { calls, impl };
  }

  test("sends the token to Dev Pages without following redirects", async () => {
    const { calls, impl } = fakeFetch(new Response("{}", { status: 200 }));
    await getWithAccess("https://oss-knowledge-base-dev.pages.dev/api/feed", headers, impl);
    expect(calls[0]?.init).toEqual({ headers, redirect: "manual" });
  });

  test("never sends the token to the publisher", async () => {
    const { calls, impl } = fakeFetch(new Response("{}", { status: 200 }));
    await getWithAccess("https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/health", headers, impl);
    expect(calls[0]?.init?.headers).toEqual({});
  });

  test("unset token and an Access redirect: tells the user to set the env vars", async () => {
    const { impl } = fakeFetch(new Response(null, { status: 302, headers: { location: login } }));
    const call = getWithAccess("https://oss-knowledge-base-dev.pages.dev/api/feed", undefined, impl);
    await expect(call).rejects.toThrow(AccessChallengeError);
    await expect(call).rejects.toThrow(/Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET/u);
  });

  test("token sent and a bare 403 from Dev Pages: says the token was rejected, with the status", async () => {
    const { impl } = fakeFetch(new Response("Forbidden", { status: 403 }));
    const call = getWithAccess("https://oss-knowledge-base-dev.pages.dev/api/feed", headers, impl);
    await expect(call).rejects.toThrow(/rejected the service token .*HTTP 403/u);
  });

  test("token sent but still challenged: says the token was rejected, without its value", async () => {
    const { impl } = fakeFetch(new Response(null, { status: 403, headers: { location: login } }));
    const call = getWithAccess("https://oss-knowledge-base-dev.pages.dev/api/feed", headers, impl);
    await expect(call).rejects.toThrow(/rejected the service token/u);
    expect(accessChallengeMessage("https://oss-knowledge-base-dev.pages.dev", true)).not.toContain(secret);
  });
});

describe("redactSecrets", () => {
  test("replaces every occurrence of each value", () => {
    expect(redactSecrets(`CF-Access-Client-Id: ${id}\nCF-Access-Client-Secret: ${secret} ${secret}`, [id, secret]))
      .toBe("CF-Access-Client-Id: ***\nCF-Access-Client-Secret: *** ***");
  });

  test("empty values are ignored", () => {
    expect(redactSecrets("abc", ["", secret])).toBe("abc");
  });
});

describe("scopeAccessRequest", () => {
  function fakeContext(behavior: "ok" | "reject" | "throw") {
    const calls: unknown[][] = [];
    const leak = new Error(`apiRequestContext.get: connect ECONNREFUSED\nCall log:\n  - CF-Access-Client-Secret: ${secret}`);
    const context = {
      label: "pages",
      get(...args: unknown[]) {
        calls.push(args);
        if (behavior === "throw") throw leak;
        return behavior === "reject" ? Promise.reject(leak) : Promise.resolve({ status: () => 200 });
      },
    };
    return { calls, context };
  }

  test("a rejected call is rethrown without the token values", async () => {
    const { context } = fakeContext("reject");
    const error = await scopeAccessRequest(context, headers, "https://oss-knowledge-base-dev.pages.dev").get("/api/feed").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain(secret);
    expect(String((error as Error).stack)).not.toContain(secret);
    expect(String((error as Error).message)).toContain("CF-Access-Client-Secret: ***");
  });

  test("a synchronous throw is redacted too", () => {
    const { context } = fakeContext("throw");
    expect(() => scopeAccessRequest(context, headers, "https://oss-knowledge-base-dev.pages.dev").get("/")).toThrow(/CF-Access-Client-Secret: \*\*\*/u);
  });

  const base = "https://oss-knowledge-base-dev.pages.dev";

  test("relative paths and Dev Pages URLs pass through; other properties are untouched", async () => {
    const { calls, context } = fakeContext("ok");
    const scoped = scopeAccessRequest(context, headers, base);
    await scoped.get("/api/feed");
    await scoped.get("https://abc123.oss-knowledge-base-dev.pages.dev/api/feed");
    await scoped.get("//abc123.oss-knowledge-base-dev.pages.dev/api/feed");
    await scoped.get("HTTPS://OSS-KNOWLEDGE-BASE-DEV.pages.dev/x");
    expect(calls.map((call) => call[0])).toEqual([
      "/api/feed",
      "https://abc123.oss-knowledge-base-dev.pages.dev/api/feed",
      "//abc123.oss-knowledge-base-dev.pages.dev/api/feed",
      "HTTPS://OSS-KNOWLEDGE-BASE-DEV.pages.dev/x",
    ]);
    expect(scoped.label).toBe("pages");
  });

  // Every target is resolved against the baseURL first, the way the request is actually sent.
  test.each([
    ["absolute publisher URL", "https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/health"],
    ["absolute look-alike", "https://evil-oss-knowledge-base-dev.pages.dev/"],
    ["http Dev host", "http://oss-knowledge-base-dev.pages.dev/"],
    ["protocol-relative look-alike", "//evil-oss-knowledge-base-dev.pages.dev/x"],
    ["backslash look-alike", "\\\\evil-oss-knowledge-base-dev.pages.dev/x"],
    ["slash-backslash look-alike", "/\\evil-oss-knowledge-base-dev.pages.dev/x"],
    ["mixed-case scheme look-alike", "hTtPs://evil-oss-knowledge-base-dev.pages.dev/x"],
    ["mixed-case http Dev host", "HtTp://oss-knowledge-base-dev.pages.dev/"],
    ["leading-space look-alike", " https://evil-oss-knowledge-base-dev.pages.dev/x"],
  ])("refuses a target off the Dev Pages host: %s", async (_name, url) => {
    const { calls, context } = fakeContext("ok");
    await expect(scopeAccessRequest(context, headers, base).get(url)).rejects.toThrow(/only for the Dev Pages origin/u);
    expect(calls).toEqual([]);
  });

  test("refuses a Request object whose URL is off the Dev Pages host (fetch)", async () => {
    const calls: unknown[] = [];
    const context = { fetch: async (input: unknown) => { calls.push(input); return {}; } };
    const scoped = scopeAccessRequest(context, headers, base);
    await expect(scoped.fetch({ url: () => "https://evil-oss-knowledge-base-dev.pages.dev/x" })).rejects.toThrow(/only for the Dev Pages origin/u);
    await scoped.fetch({ url: () => `${base}/api/feed` });
    expect(calls).toHaveLength(1);
  });

  test("without a token nothing is refused (nothing to leak)", async () => {
    const { calls, context } = fakeContext("ok");
    await scopeAccessRequest(context, undefined, "http://127.0.0.1:8788").get("https://example.com/");
    expect(calls).toHaveLength(1);
  });
});

describe("accessRouteHandler", () => {
  function fakeRoute(url: string, fetchBehavior: "ok" | "fail" = "ok") {
    const events: { action: string; options?: unknown }[] = [];
    const response = { status: () => 302 };
    const route = {
      request: () => ({ url: () => url, headers: () => ({ accept: "*/*" }) }),
      fetch: async (options?: unknown) => {
        events.push({ action: "fetch", options });
        if (fetchBehavior === "fail") throw new Error(`route.fetch: ECONNRESET CF-Access-Client-Secret: ${secret}`);
        return response;
      },
      fulfill: async (options?: unknown) => { events.push({ action: "fulfill", options }); },
      continue: async (options?: unknown) => { events.push({ action: "continue", options }); },
      abort: async (options?: unknown) => { events.push({ action: "abort", options }); },
    };
    return { events, response, route };
  }

  test("Dev Pages: fetched with the token and no redirects, then the 3xx goes back to the browser", async () => {
    const { events, response, route } = fakeRoute("https://oss-knowledge-base-dev.pages.dev/");
    await accessRouteHandler(headers)(route);
    expect(events).toEqual([
      { action: "fetch", options: { headers: { accept: "*/*", ...headers }, maxRedirects: 0 } },
      { action: "fulfill", options: { response } },
    ]);
  });

  test("any other host (e.g. a redirect target): continued untouched", async () => {
    const { events, route } = fakeRoute("https://evil-oss-knowledge-base-dev.pages.dev/after");
    await accessRouteHandler(headers)(route);
    expect(events).toEqual([{ action: "continue", options: undefined }]);
  });

  test("a failed fetch aborts the request and logs without the token", async () => {
    const { events, route } = fakeRoute("https://oss-knowledge-base-dev.pages.dev/", "fail");
    const logged: string[] = [];
    await accessRouteHandler(headers, (line) => logged.push(line))(route);
    expect(events.at(-1)).toEqual({ action: "abort", options: "failed" });
    expect(logged.join("\n")).not.toContain(secret);
    expect(logged.join("\n")).toContain("ECONNRESET");
  });
});
