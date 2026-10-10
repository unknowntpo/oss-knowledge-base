// Dummy Cloudflare Access token for the header-scoping harness. Never a real value.
export const dummyId = "dummy-id-harness-4c1d.access";
export const dummySecret = "dummy-secret-harness-7e2b9a0f13c5";

/** Overrides whatever is in the environment, so a real token is never used by the harness. */
export function useDummyToken(): void {
  process.env.CF_ACCESS_CLIENT_ID = dummyId;
  process.env.CF_ACCESS_CLIENT_SECRET = dummySecret;
}
