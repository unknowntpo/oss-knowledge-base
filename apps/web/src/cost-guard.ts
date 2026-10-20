/**
 * Spec 026 Behavior 14: the top-bar notice for a `GET /api/cost-guard` answer. `warn`, or
 * `tripped` while only monitoring, is the mild notice; `tripped` while enforced says what is
 * paused. Every other answer (`ok`, `pending`, `off`, `unconfigured`, malformed) shows nothing.
 */
export interface CostGuardNotice {
  readonly key: "costGuard.warn" | "costGuard.paused";
  readonly className: "is-warn" | "is-tripped";
}

export function costGuardNotice(body: unknown): CostGuardNotice | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { status, enforced } = body as { readonly status?: unknown; readonly enforced?: unknown };
  if (status === "tripped" && enforced === true) return { key: "costGuard.paused", className: "is-tripped" };
  if (status === "warn" || status === "tripped") return { key: "costGuard.warn", className: "is-warn" };
  return undefined;
}
