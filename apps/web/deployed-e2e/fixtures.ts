// Fixtures for the deployed Dev E2E. The Dev Pages site may sit behind Cloudflare
// Access; the service token (CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET) is sent
// only to the Dev Pages origin. Global `use.extraHTTPHeaders` is avoided on purpose:
// it would also reach the publisher on workers.dev and any third-party origin the page loads.
import { test as base, expect, type APIRequestContext } from "@playwright/test";

import {
  accessChallengeMessage,
  accessHeadersFor,
  isAccessChallenge,
  isAccessProtected,
  readAccessHeaders,
} from "../../../scripts/verify/access";

const access = readAccessHeaders(process.env);

export const test = base.extend<{ publisherRequest: APIRequestContext }>({
  // Browser: add the token to Dev Pages requests only.
  context: async ({ context }, use) => {
    if (access !== undefined) {
      await context.route(
        (url) => isAccessProtected(url),
        (route) => route.continue({ headers: { ...route.request().headers(), ...accessHeadersFor(route.request().url(), access) } }),
      );
    }
    await use(context);
  },
  // API calls to the Pages baseURL; fails fast with a clear message on an Access challenge.
  request: async ({ playwright, baseURL }, use) => {
    if (baseURL === undefined) throw new Error("baseURL is required");
    const request = await playwright.request.newContext({ baseURL, extraHTTPHeaders: accessHeadersFor(baseURL, access) });
    const probe = await request.head("/", { maxRedirects: 0 });
    if (isAccessChallenge({ status: probe.status(), url: probe.url(), location: probe.headers().location })) {
      throw new Error(accessChallengeMessage(baseURL, access !== undefined && isAccessProtected(baseURL)));
    }
    await use(request);
    await request.dispose();
  },
  // The publisher worker is not behind Access: never send it the token.
  publisherRequest: async ({ playwright }, use) => {
    const request = await playwright.request.newContext();
    await use(request);
    await request.dispose();
  },
});

export { expect };
