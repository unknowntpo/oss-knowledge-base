/**
 * Spec 025: the single source for the rows of `docs-site.test.ts` and for the test-plan table in
 * docs/specs/025-docs-site/spec.md (`bun run docs:test-plan`).
 *
 * - `change`: what the test does to the minimal valid fixture (the fixture builds and audits clean).
 * - `stage`: `build` (buildDocsSite throws) or `audit` (auditSite on the built files reports it), or
 *   `deploy` (deployDecision; then `change` is `event ref credentials projectStatus`).
 * - `expect`: a substring of the reported problem, or the deploy action.
 */
export const testPlanRows = [
  { id: "DOC15", change: "zh-Hant/search.md deleted", stage: "build", expect: "docs/site/zh-Hant/search.md is missing", why: "every page exists in every locale" },
  { id: "DOC15", change: "en/extra.md added", stage: "build", expect: "is not a registered page", why: "a page must be in the nav (PAGES) to be built" },
  { id: "DOC15", change: "a level-2 heading without {#id}", stage: "build", expect: "needs an explicit {#id}", why: "anchors must not depend on the locale" },
  { id: "DOC15", change: "page starts without a level-1 heading", stage: "build", expect: "must start with one level-1 heading", why: "the H1 is the page title" },
  { id: "DOC15", change: "link to docs/specs/999-none/spec.md", stage: "build", expect: "does not exist: docs/specs/999-none/spec.md", why: "a renamed source breaks the build instead of the link" },
  { id: "DOC15", change: "link to ../../etc/passwd", stage: "build", expect: "link outside the repository", why: "only repository paths are linked to GitHub" },
  { id: "DOC15", change: "link to javascript:alert(1)", stage: "build", expect: "disallowed scheme", why: "only http, https and repository paths" },
  { id: "DOC15", change: "{{value:nope}}", stage: "build", expect: "unknown value {{value:nope}}", why: "a typo in a derived value is not printed" },
  { id: "DOC15", change: "{{flow:nope}}", stage: "build", expect: "unknown flow nope", why: "a flow paragraph must name a flow file" },
  { id: "DOC9", change: "flow node without zh-Hant title", stage: "build", expect: "node a1.title: missing zh-Hant text", why: "every flow text exists in both locales" },
  { id: "DOC9", change: "flow link to an unknown card", stage: "build", expect: "unknown card \"ghost\"", why: "a connector joins two existing cards" },
  { id: "DOC9", change: "flow initial names no node", stage: "build", expect: "initial: must name a node", why: "the selected step on load exists" },
  { id: "DOC9", change: "flow node without sources", stage: "build", expect: "sources: must name at least one repository path", why: "every step cites where its facts come from" },
  { id: "DOC9", change: "flow source path missing", stage: "build", expect: "does not exist: apps/none.ts", why: "flow sources are checked like page links" },
  { id: "DOC8", change: "styles.css without the dark block", stage: "build", expect: "has no \":root[data-theme=\"dark\"] {\" block", why: "the product's dark tokens are required" },
  { id: "DOC3", change: "zh-Hant overview has an extra {#id} section", stage: "audit", expect: "section ids differ between locales", why: "both locales carry the same sections" },
  { id: "DOC3", change: "en overview cites one more source", stage: "audit", expect: "cited sources differ between locales", why: "both locales cite the same evidence" },
  { id: "DOC4", change: "en link to missing.html", stage: "audit", expect: "broken link missing.html", why: "a link to a page that is not built" },
  { id: "DOC4", change: "en link to search.html#nowhere", stage: "audit", expect: "names a missing anchor", why: "a fragment must exist on the target" },
  { id: "DOC6", change: "a <script src> from a CDN", stage: "audit", expect: "loads an external resource from cdn.example.com", why: "only Google Fonts may be loaded" },
  { id: "DOC6", change: "a stylesheet from fonts.googleapis.com", stage: "audit", expect: "", why: "positive control: Google Fonts is allowed" },
  { id: "DOC7", change: "text with dev@kafka.apache.org", stage: "audit", expect: "contains an email address", why: "no email address in the output" },
  { id: "DOC7", change: "text with ghp_ followed by 36 characters", stage: "audit", expect: "contains a GitHub token", why: "no token in the output" },
  { id: "DOC7", change: "text with a workers.dev hostname", stage: "audit", expect: "advertises a Worker hostname", why: "its POST routes spend money" },
  { id: "DOC7", change: "text with POST /digest/run", stage: "audit", expect: "advertises a manual trigger route", why: "cost-bearing route" },
  { id: "DOC7", change: "a link to the Dev /api/search", stage: "audit", expect: "advertises a link to a Dev API", why: "each query can spend Workers AI neurons" },
  { id: "DOC7", change: "text with the Dev site URL only", stage: "audit", expect: "", why: "positive control: the public Dev site may be named" },
  { id: "DOC12", change: "push refs/heads/main yes 200", stage: "deploy", expect: "deploy", why: "the project exists" },
  { id: "DOC12", change: "push refs/heads/main yes 404", stage: "deploy", expect: "skip", why: "the owner has not created the project yet: green, nothing deployed" },
  { id: "DOC12", change: "push refs/heads/main yes 403", stage: "deploy", expect: "fail", why: "a token without Pages access is an error, not a skip" },
  { id: "DOC12", change: "push refs/heads/main no -", stage: "deploy", expect: "fail", why: "missing credentials on main" },
  { id: "DOC12", change: "pull_request refs/pull/1/merge yes 200", stage: "deploy", expect: "skip", why: "pull requests deploy nothing (ci.yml has no preview deploys)" },
  { id: "DOC12", change: "push refs/tags/v0.3.2 yes 200", stage: "deploy", expect: "skip", why: "a tag deploys Prod, not the docs" },
] as const;
