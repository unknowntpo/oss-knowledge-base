/**
 * Spec 016 Behavior 24: every error text the embedding path stores, returns, or logs goes through
 * here. Redaction comes before the cut, so a credential that straddles the limit does not survive
 * in part.
 *
 * 1. `Bearer <anything up to the next space>` becomes `Bearer [redacted]`.
 * 2. A run of 32 or more token characters (letters, digits, `_ - + / =`) is a token and becomes
 *    `[redacted]`, unless it is a path: it holds a `/`, holds no `+` or `=`, and none of its
 *    words (split on `/ - _`) mixes lower-case and upper-case letters, which base64 does and
 *    object keys and URL paths do not. In a path only a segment that is itself 32 or more
 *    characters (a digest, an account id) is redacted.
 */
const TOKEN_LENGTH = 32;

function redactRun(run: string): string {
  const pathLike = run.includes("/") && !/[+=]/u.test(run) &&
    run.split(/[/_-]/u).every((word) => !(/[a-z]/u.test(word) && /[A-Z]/u.test(word)));
  if (!pathLike) return "[redacted]";
  return run.split("/").map((segment) => (segment.length >= TOKEN_LENGTH ? "[redacted]" : segment)).join("/");
}

export function sanitizeErrorMessage(text: string): string {
  return text
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(new RegExp(`[A-Za-z0-9_+/=-]{${TOKEN_LENGTH},}`, "gu"), redactRun)
    .slice(0, 200);
}

/** The message of anything thrown, sanitized. */
export function errorText(error: unknown): string {
  return sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
}
