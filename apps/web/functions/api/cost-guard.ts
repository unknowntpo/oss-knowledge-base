import { jsonResponse } from "../_shared/r2-projection";

/** The data Worker's cost-guard Durable Object; the Worker names the same object. */
export const COST_GUARD_OBJECT_NAME = "cost-guard-v1";

const STATUSES: ReadonlySet<unknown> = new Set(["ok", "warn", "tripped", "unconfigured", "pending", "off"]);

interface Env {
  /** Spec 026: the Worker's cost-guard object (`script_name`); absent means the guard is off here. */
  readonly COST_GUARD_STATE?: DurableObjectNamespace;
}

/** `GET /api/cost-guard` (Spec 026 Behavior 14): `{status, enforced}` only, never the numbers. */
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const namespace = env.COST_GUARD_STATE;
  if (namespace === undefined) return jsonResponse({ status: "off" });
  try {
    const stub = namespace.get(namespace.idFromName(COST_GUARD_OBJECT_NAME));
    const response = await stub.fetch("https://cost-guard.internal/public");
    if (!response.ok) throw new Error(`The cost guard answered ${response.status}`);
    const body = await response.json() as { readonly status?: unknown; readonly enforced?: unknown } | null;
    if (body === null || typeof body !== "object" || !STATUSES.has(body.status) || typeof body.enforced !== "boolean") {
      throw new Error("The cost guard answer is malformed");
    }
    return jsonResponse({ status: body.status, enforced: body.enforced });
  } catch {
    return jsonResponse({ error: "Cost guard state is unavailable" }, { status: 503 });
  }
};
