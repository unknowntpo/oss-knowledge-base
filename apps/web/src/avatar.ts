/**
 * Spec 019 W53: a GitHub avatar is loaded by the visitor's browser straight from GitHub's avatar
 * host; nothing is stored and no API is called. The URL is built only from a login that passes
 * GitHub's login rule, so nothing else can reach the `src` attribute.
 */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;

export const AVATAR_HOST = "https://avatars.githubusercontent.com";

/** The avatar URL of a GitHub login at `size` CSS pixels (requested at 2x), or undefined for anything that is not a login. */
export function githubAvatarUrl(login: string | null | undefined, size: number): string | undefined {
  if (typeof login !== "string" || !GITHUB_LOGIN.test(login)) return undefined;
  const pixels = Math.min(460, Math.max(16, Math.round(size * 2)));
  return `${AVATAR_HOST}/${login}?s=${pixels}`;
}

/** The number of `--avatar-N` tokens in `styles.css` (Spec 023 DS1). */
export const AVATAR_HUES = 6;

/**
 * Spec 023 DS1: the avatar colour (1..6, `--avatar-N`) of an author in the feed-detail timeline,
 * a deterministic hash of the name, as in the legacy viewer, so an author keeps one colour.
 */
export function authorHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return (hash % AVATAR_HUES) + 1;
}
