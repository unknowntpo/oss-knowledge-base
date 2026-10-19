/**
 * Spec 014 D95: the runtime boundary for error text. Every body the Worker serves (`/health`, a Durable
 * Object's `/status`, a run's response) passes through `redactRecord`, which sanitizes every string
 * under an `error`, `message` or `reason` key at any depth with Spec 016 Behavior 24's rule. Paths
 * that already sanitize are unchanged (the rule is idempotent); a path that forgets is still covered.
 */
import { sanitizeErrorMessage } from "@oss-knowledge-base/semantic-vectorize";

const ERROR_KEYS = new Set(["error", "message", "reason"]);

export function redactRecord<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactRecord(item)) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    ERROR_KEYS.has(key) && typeof item === "string" ? sanitizeErrorMessage(item) : redactRecord(item),
  ])) as T;
}
