/**
 * Spec 020 slug rule: the single source for the rows of `feature-map-site.test.ts` (B4) and for the
 * table in docs/specs/020-feature-map-site/spec.md (`bun run docs:test-plan`).
 *
 * - `ref`: a branch or tag name as git prints it.
 * - `slug`: the directory the ref's page is published in (`/<slug>/index.html`).
 */
export const testPlanRows = [
  { id: "B4", ref: "main", slug: "main", why: "unchanged" },
  { id: "B4", ref: "v0.2.0", slug: "v0.2.0", why: "dots and digits are kept" },
  { id: "B4", ref: "release/1.0", slug: "release-1.0", why: "a slash would be a directory" },
  { id: "B4", ref: "release/2.x/hotfix", slug: "release-2.x-hotfix", why: "every slash" },
  { id: "B4", ref: "Release/RC_1", slug: "release-rc_1", why: "lower case: Pages paths are case-sensitive" },
  { id: "B4", ref: "feat/搜尋 v2", slug: "feat-v2", why: "anything outside a-z 0-9 . _ - becomes one hyphen" },
  { id: "B4", ref: "../../etc", slug: "etc", why: "no leading dots or hyphens, so no path traversal" },
  { id: "B4", ref: "a..b", slug: "a.b", why: "repeated dots collapse" },
  { id: "B4", ref: "-x-", slug: "x", why: "trimmed" },
  { id: "B4", ref: "///", slug: "ref", why: "nothing left: a fixed name" },
  { id: "B4", ref: "versions.json", slug: "versions.json-ref", why: "reserved root file" },
  { id: "B4", ref: "index.html", slug: "index.html-ref", why: "reserved root file" },
] as const;
