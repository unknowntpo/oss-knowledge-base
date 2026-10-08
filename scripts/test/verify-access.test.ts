import { describe, expect, test } from "bun:test";

import {
  AccessChallengeError,
  AccessConfigError,
  accessChallengeMessage,
  accessHeadersFor,
  getWithAccess,
  isAccessChallenge,
  isAccessProtected,
  readAccessHeaders,
} from "../verify/access";

const id = "test-id.access";
const secret = "test-secret";
const headers = { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };

describe("readAccessHeaders", () => {
  test("both variables set: both headers", () => {
    expect(readAccessHeaders({ CF_ACCESS_CLIENT_ID: id, CF_ACCESS_CLIENT_SECRET: secret })).toEqual(headers);
  });

  test("neither set (or blank): no headers, so runs before Access exists are unchanged", () => {
    expect(readAccessHeaders({})).toBeUndefined();
    expect(readAccessHeaders({ CF_ACCESS_CLIENT_ID: " ", CF_ACCESS_CLIENT_SECRET: "" })).toBeUndefined();
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
    [{ status: 403, url: "https://oss-knowledge-base-dev.pages.dev/" }, false],
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

  test("token sent but still challenged: says the token was rejected, without its value", async () => {
    const { impl } = fakeFetch(new Response(null, { status: 403, headers: { location: login } }));
    const call = getWithAccess("https://oss-knowledge-base-dev.pages.dev/api/feed", headers, impl);
    await expect(call).rejects.toThrow(/rejected the service token/u);
    expect(accessChallengeMessage("https://oss-knowledge-base-dev.pages.dev", true)).not.toContain(secret);
  });
});
