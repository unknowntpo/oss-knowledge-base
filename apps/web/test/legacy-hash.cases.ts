/**
 * Spec 032 test plan: an old `#/…` link and the path it lands on. Rendered into
 * docs/specs/032-path-urls/spec.md by `bun run docs:test-plan`; run by legacy-hash.test.ts.
 * `null` means the hash is not a legacy route and the URL is left alone. `path` is the page's path
 * when the link is opened; the mapping ignores it, as the hash router did.
 */
export const testPlanRows = [
  { id: "U3", case: "a profile link from the hash router", path: "/", hash: "#/kafka/people/github%3Am1a2st", lands: "/kafka/people/github%3Am1a2st" },
  { id: "U3", case: "the old path is ignored, as the hash router ignored it", path: "/kafka/people/x", hash: "#/kafka/", lands: "/kafka/" },
  { id: "U3", case: "bare hash root opens Home (then the last project)", path: "/", hash: "#/", lands: "/" },
  { id: "U3", case: "Detail", path: "/", hash: "#/feed/KAFKA-PR-43", lands: "/feed/KAFKA-PR-43" },
  { id: "U3", case: "Search detail", path: "/", hash: "#/search/sdr1.abc", lands: "/search/sdr1.abc" },
  { id: "U5", case: "an in-page anchor (skip link)", path: "/kafka/threads", hash: "#main", lands: null },
  { id: "U5", case: "an empty fragment", path: "/kafka/", hash: "#", lands: null },
  { id: "U5", case: "no hash", path: "/kafka/", hash: "", lands: null },
  { id: "U5", case: "a fragment that only looks like a path", path: "/kafka/", hash: "#kafka/threads", lands: null },
  { id: "U5", case: "a protocol-relative URL (another origin) is refused", path: "/", hash: "#//evil.example/x", lands: null },
  { id: "U5", case: "a backslash form of the same is refused", path: "/", hash: "#/\\evil.example/x", lands: null },
] as const;
