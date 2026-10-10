/**
 * Spec 016 Behavior 24: every error text the embedding path stores, returns, or logs goes through
 * here. Redaction comes before the cut, so a credential that straddles the limit does not survive
 * in part. A run of 32 or more base64, base64url, or hex characters is treated as one token.
 */
export function sanitizeErrorMessage(text: string): string {
  return text
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/[A-Za-z0-9_+/=-]{32,}/gu, "[redacted]")
    .slice(0, 200);
}

/** The message of anything thrown, sanitized. */
export function errorText(error: unknown): string {
  return sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
}
