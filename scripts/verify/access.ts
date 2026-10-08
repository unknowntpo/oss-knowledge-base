// Cloudflare Access service-token headers for the Dev Pages site.
// Pure: the deployed E2E (apps/web/deployed-e2e) and verify:ui / verify:health
// share these rules so the token is sent to the Dev Pages origin and nowhere else.

/** Dev Pages production host; preview deployments are its subdomains. */
export const accessProtectedHost = "oss-knowledge-base-dev.pages.dev";

export type AccessHeaders = Readonly<Record<"CF-Access-Client-Id" | "CF-Access-Client-Secret", string>>;

export class AccessConfigError extends Error {}

/** Headers from CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET; undefined when neither is set. */
export function readAccessHeaders(env: Readonly<Record<string, string | undefined>>): AccessHeaders | undefined {
  const id = env.CF_ACCESS_CLIENT_ID?.trim() ?? "";
  const secret = env.CF_ACCESS_CLIENT_SECRET?.trim() ?? "";
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

/** An Access login challenge: a redirect to *.cloudflareaccess.com, or a 401/403 that ended up there. */
export function isAccessChallenge(response: {
  readonly status: number;
  readonly url?: string;
  readonly location?: string | null;
}): boolean {
  if (isAccessHost(response.url)) return true;
  const redirect = response.status >= 300 && response.status < 400;
  const denied = response.status === 401 || response.status === 403;
  return (redirect || denied) && isAccessHost(response.location, response.url);
}

/** Why a Dev Pages request was challenged and what to do about it. Never includes header values. */
export function accessChallengeMessage(url: string, sentToken: boolean): string {
  return sentToken
    ? `Cloudflare Access rejected the service token for ${url}. Check that CF_ACCESS_CLIENT_ID and ` +
        "CF_ACCESS_CLIENT_SECRET belong to a token the Dev Access application allows."
    : `${url} is behind Cloudflare Access. Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET ` +
        "(for example from the macOS Keychain: " +
        "export CF_ACCESS_CLIENT_ID=$(security find-generic-password -s oss-kb-cf-access-id -w)) and rerun.";
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
    throw new AccessChallengeError(accessChallengeMessage(url, accessHeadersFor(url, headers)["CF-Access-Client-Id"] !== undefined));
  }
  return response;
}
