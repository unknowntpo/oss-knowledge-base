/** Keeps a surfaced error short and free of anything that looks like a credential. */
export function sanitizeErrorMessage(text: string): string {
  return text
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]")
    .slice(0, 200);
}
