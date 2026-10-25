/**
 * Spec 031 Behavior 3: the app used hash routing until 2026-10-25, so old links look like
 * `/#/kafka/people/github%3Am1a2st`. A hash that starts with `#/` is such a route and maps to its
 * path form; the path before it is ignored, as the hash router ignored it. Any other hash is an
 * in-page anchor and is left alone (`null`). `#//host` and `#/\host` are refused: as a URL they
 * name another origin, which `history.replaceState` rejects with an exception.
 */
export function legacyHashPath(hash: string): string | null {
  if (!hash.startsWith("#/") || hash[2] === "/" || hash[2] === "\\") return null;
  return hash.slice(1);
}
