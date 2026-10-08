// Cloudflare Access service-token headers for the Dev Pages site.
// Mostly pure: the deployed E2E (apps/web/deployed-e2e) and verify:ui / verify:health
// share these rules so the token is sent to the Dev Pages origin and nowhere else.

import type { Route } from "playwright";

/** Dev Pages production host; preview deployments are its subdomains. */
export const accessProtectedHost = "oss-knowledge-base-dev.pages.dev";

export type AccessHeaders = Readonly<Record<"CF-Access-Client-Id" | "CF-Access-Client-Secret", string>>;

export class AccessConfigError extends Error {}

/**
 * Headers from CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET; undefined when neither is set.
 * Values are not trimmed: the exact value is what GitHub masks in logs and what redaction looks for.
 */
export function readAccessHeaders(env: Readonly<Record<string, string | undefined>>): AccessHeaders | undefined {
  const id = env.CF_ACCESS_CLIENT_ID ?? "";
  const secret = env.CF_ACCESS_CLIENT_SECRET ?? "";
  if (id === "" && secret === "") return undefined;
  if (id === "" || secret === "") {
    throw new AccessConfigError("set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or neither");
  }
  return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
}

/** True only for https URLs on the Dev Pages host or one of its preview subdomains. */
export function isAccessProtected(url: string | URL): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return parsed.protocol === "https:" && (host === accessProtectedHost || host.endsWith(`.${accessProtectedHost}`));
}

/** The headers to attach to a request for `url`: the token for the Dev Pages origin, nothing elsewhere. */
export function accessHeadersFor(url: string | URL, headers: AccessHeaders | undefined): Record<string, string> {
  return headers !== undefined && isAccessProtected(url) ? { ...headers } : {};
}

function isAccessHost(url: string | null | undefined, base?: string): boolean {
  if (url === null || url === undefined || url === "") return false;
  try {
    const host = new URL(url, base).hostname.toLowerCase();
    return host === "cloudflareaccess.com" || host.endsWith(".cloudflareaccess.com");
  } catch {
    return false;
  }
}

/**
 * An Access challenge or rejection: a redirect (or a 401/403) pointing to *.cloudflareaccess.com,
 * a 401/403 from the Dev Pages host itself (how Access answers a missing or bad service token),
 * or a successful response that ended on the Access login page after redirects were followed.
 */
export function isAccessChallenge(response: {
  readonly status: number;
  readonly url?: string;
  readonly location?: string | null;
}): boolean {
  const { status } = response;
  const redirect = status >= 300 && status < 400;
  const denied = status === 401 || status === 403;
  if (status >= 200 && status < 300) return isAccessHost(response.url);
  if (redirect) return isAccessHost(response.location, response.url);
  if (denied) {
    return isAccessHost(response.location, response.url) || isAccessHost(response.url)
      || (response.url !== undefined && isAccessProtected(response.url));
  }
  return false;
}

/** Why a Dev Pages request was challenged and what to do about it. Never includes header values. */
export function accessChallengeMessage(url: string, sentToken: boolean, status?: number): string {
  const code = status === undefined ? "" : ` (HTTP ${status})`;
  return sentToken
    ? `Cloudflare Access rejected the service token for ${url}${code}. Check that CF_ACCESS_CLIENT_ID and ` +
        "CF_ACCESS_CLIENT_SECRET belong to a token the Dev Access application allows."
    : `${url} is behind Cloudflare Access${code}. Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET ` +
        "(for example from the macOS Keychain: " +
        "export CF_ACCESS_CLIENT_ID=$(security find-generic-password -s oss-kb-cf-access-id -w)) and rerun.";
}

/** Replaces every occurrence of each non-empty value with ***. */
export function redactSecrets(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) if (value !== "") out = out.split(value).join("***");
  return out;
}

function redactError(error: unknown, values: readonly string[]): unknown {
  if (!(error instanceof Error)) return typeof error === "string" ? redactSecrets(error, values) : error;
  // A new error: Playwright's original (with its "Call log" listing every request header) is not passed on.
  const redacted = new Error(redactSecrets(error.message, values));
  redacted.name = error.name;
  redacted.stack = redactSecrets(error.stack ?? "", values);
  return redacted;
}

const requestMethods = new Set(["get", "head", "post", "put", "patch", "delete", "fetch"]);

/**
 * Wraps the token-bearing APIRequestContext: errors are rethrown with the token values
 * replaced by ***, and absolute URLs off the Dev Pages host are refused before any request,
 * because the context's extraHTTPHeaders would otherwise go to them.
 */
export function scopeAccessRequest<T extends object>(context: T, headers: AccessHeaders | undefined): T {
  const values = headers === undefined ? [] : Object.values(headers);
  return new Proxy(context, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const first = args[0];
        if (requestMethods.has(String(property)) && typeof first === "string" && URL.canParse(first) && !isAccessProtected(first)) {
          return Promise.reject(new Error(`the token-bearing request context is only for the Dev Pages origin, not ${new URL(first).origin}`));
        }
        try {
          const result: unknown = value.apply(target, args);
          return result instanceof Promise ? result.catch((error: unknown) => { throw redactError(error, values); }) : result;
        } catch (error) {
          throw redactError(error, values);
        }
      };
    },
  });
}

type AccessRoute = Pick<Route, "fetch" | "fulfill" | "continue" | "abort"> & {
  request(): { url(): string; headers(): Record<string, string> };
};

/**
 * Browser route handler for Dev Pages requests. The request is fetched with the token and
 * without following redirects, and the response (a 3xx included) goes back to the browser.
 * The browser then follows a redirect as a fresh request that this host check sees again,
 * so the token never rides a redirect to another host.
 */
export function accessRouteHandler(
  headers: AccessHeaders | undefined,
  log: (line: string) => void = (line) => console.error(line),
): (route: AccessRoute) => Promise<void> {
  const values = headers === undefined ? [] : Object.values(headers);
  return async (route) => {
    const request = route.request();
    const extra = accessHeadersFor(request.url(), headers);
    if (Object.keys(extra).length === 0) {
      await route.continue();
      return;
    }
    try {
      const response = await route.fetch({ headers: { ...request.headers(), ...extra }, maxRedirects: 0 });
      await route.fulfill({ response });
    } catch (error) {
      log(`access route ${request.url()}: ${redactSecrets(error instanceof Error ? error.message : String(error), values)}`);
      await route.abort("failed").catch(() => undefined);
    }
  };
}

export class AccessChallengeError extends Error {}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * GET `url` with the token attached only when `url` is on the Dev Pages origin.
 * Redirects are not followed, so an Access login redirect becomes a clear error
 * instead of an HTML login page parsed as JSON.
 */
export async function getWithAccess(
  url: string,
  headers: AccessHeaders | undefined,
  fetchImpl: Fetch = fetch,
): Promise<Response> {
  const response = await fetchImpl(url, { headers: accessHeadersFor(url, headers), redirect: "manual" });
  if (isAccessChallenge({ status: response.status, url: response.url || url, location: response.headers.get("location") })) {
    const sentToken = accessHeadersFor(url, headers)["CF-Access-Client-Id"] !== undefined;
    throw new AccessChallengeError(accessChallengeMessage(url, sentToken, response.status));
  }
  return response;
}
