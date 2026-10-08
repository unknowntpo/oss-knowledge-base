// Fixtures for the deployed Dev E2E. The Dev Pages site may sit behind Cloudflare
// Access; the service token (CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET) is sent
// only to the Dev Pages origin. Global `use.extraHTTPHeaders` is avoided on purpose:
// it would also reach the publisher on workers.dev and any third-party origin the page loads.
// The token is never sent on a redirect (scripts/verify/access.ts, accessRouteHandler).
import { test as base, expect, type APIRequestContext, type PlaywrightTestOptions, type PlaywrightWorkerArgs } from "@playwright/test";

import {
  accessChallengeMessage,
  accessHeadersFor,
  accessRouteHandler,
  isAccessChallenge,
  isAccessProtected,
  readAccessHeaders,
  scopeAccessRequest,
} from "../../../scripts/verify/access";

const access = readAccessHeaders(process.env);

/**
 * The `request` fixture: API calls to the Pages baseURL only, with no redirects, errors
 * redacted, and other origins refused. A HEAD / probe fails fast on an Access challenge.
 * Exported so the harness can drive it against a challenged host.
 */
export async function pagesRequest(
  { playwright, baseURL, proxy, ignoreHTTPSErrors }: {
    playwright: PlaywrightWorkerArgs["playwright"];
    baseURL: string | undefined;
    proxy: PlaywrightTestOptions["proxy"];
    ignoreHTTPSErrors: boolean | undefined;
  },
  use: (request: APIRequestContext) => Promise<void>,
): Promise<void> {
  if (baseURL === undefined) throw new Error("baseURL is required");
  const headers = isAccessProtected(baseURL) ? access : undefined;
  const context = await playwright.request.newContext({
    baseURL,
    proxy,
    ignoreHTTPSErrors,
    maxRedirects: 0,
    extraHTTPHeaders: accessHeadersFor(baseURL, access),
  });
  try {
    const request = scopeAccessRequest(context, headers, baseURL);
    const probe = await request.head("/");
    if (isAccessChallenge({ status: probe.status(), url: probe.url(), location: probe.headers().location })) {
      throw new Error(accessChallengeMessage(baseURL, headers !== undefined, probe.status()));
    }
    await use(request);
  } finally {
    await context.dispose();
  }
}

export const test = base.extend<{ publisherRequest: APIRequestContext }>({
  // Browser: Dev Pages requests are fetched with the token and without following redirects.
  context: async ({ context }, use) => {
    if (access !== undefined) await context.route((url) => isAccessProtected(url), accessRouteHandler(access));
    await use(context);
  },
  request: pagesRequest,
  // The publisher worker is not behind Access: never send it the token.
  publisherRequest: async ({ playwright, proxy, ignoreHTTPSErrors }, use) => {
    const request = await playwright.request.newContext({ proxy, ignoreHTTPSErrors });
    await use(request);
    await request.dispose();
  },
});

export { expect };
