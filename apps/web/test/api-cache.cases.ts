/**
 * Spec 003 R7 test plan: the `cache-control` header of every Pages Function outcome. The single
 * source for `api-cache.test.ts` and for the table in docs/specs/003-r2-feed-projection/spec.md
 * (`bun run docs:test-plan` regenerates it). `outcome` names the scenario the test sets up.
 */
const REVALIDATE = "public, max-age=30, stale-while-revalidate=120";
const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_STORE = "no-store";

export const testPlanRows = [
  { id: "R7", endpoint: "/api/feed", outcome: "current release", status: 200, cacheControl: REVALIDATE },
  { id: "R7", endpoint: "/api/feed", outcome: "no manifest", status: 503, cacheControl: NO_STORE },
  { id: "R7", endpoint: "/api/detail/:id", outcome: "entry of the current release", status: 200, cacheControl: REVALIDATE },
  { id: "R7", endpoint: "/api/detail/:id", outcome: "no id", status: 400, cacheControl: NO_STORE },
  { id: "R7", endpoint: "/api/detail/:id", outcome: "unknown id", status: 404, cacheControl: NO_STORE },
  { id: "R7", endpoint: "/api/detail/:id", outcome: "no manifest", status: 503, cacheControl: NO_STORE },
  { id: "R7", endpoint: "/api/search", outcome: "query with results", status: 200, cacheControl: REVALIDATE },
  { id: "R7", endpoint: "/api/search", outcome: "empty query", status: 400, cacheControl: NO_STORE },
  { id: "R7", endpoint: "/api/search", outcome: "no current pointer", status: 503, cacheControl: NO_STORE },
  { id: "R7", endpoint: "/api/search", outcome: "unsupported lexical revision", status: 503, cacheControl: NO_STORE },
  { id: "R7", endpoint: "/api/search-detail/:ref", outcome: "ref of a published release", status: 200, cacheControl: IMMUTABLE },
  { id: "R7", endpoint: "/api/search-detail/:ref", outcome: "no ref", status: 400, cacheControl: NO_STORE },
  { id: "R7", endpoint: "/api/search-detail/:ref", outcome: "invalid ref", status: 400, cacheControl: NO_STORE },
  { id: "R7", endpoint: "/api/search-detail/:ref", outcome: "detail object absent", status: 404, cacheControl: NO_STORE },
  { id: "R7", endpoint: "/api/search-detail/:ref", outcome: "release manifest absent", status: 503, cacheControl: NO_STORE },
  { id: "R7", endpoint: "/api/digest", outcome: "current digest", status: 200, cacheControl: REVALIDATE },
  { id: "R7", endpoint: "/api/digest", outcome: "unknown project", status: 400, cacheControl: NO_STORE },
  { id: "R7", endpoint: "/api/digest", outcome: "unsupported locale", status: 400, cacheControl: NO_STORE },
  { id: "R7", endpoint: "/api/digest", outcome: "no pointer yet", status: 404, cacheControl: NO_STORE },
  { id: "R7", endpoint: "/api/digest", outcome: "pointer outside the project prefix", status: 503, cacheControl: NO_STORE },
] as const;
