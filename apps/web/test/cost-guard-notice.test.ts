/**
 * Spec 026 CG12 (Behavior 14): the top-bar notice for each cost-guard answer, its text in both
 * locales, its tokens, and the `GET /api/cost-guard` Pages Function with and without the binding.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { COST_GUARD_OBJECT_NAME, onRequestGet } from "../functions/api/cost-guard";
import { costGuardNotice } from "../src/cost-guard";
import { loadTranslations } from "./i18n-harness";
import { testPlanRows } from "./cost-guard-notice.cases";

const translations = await loadTranslations();

function bodyOf(row: (typeof testPlanRows)[number]): unknown {
  const body: Record<string, unknown> = {};
  if (row.status !== null) body.status = row.status;
  if (row.enforced !== null) body.enforced = row.enforced;
  return body;
}

describe("Spec 026 cost-guard notice", () => {
  test.each(testPlanRows)("$id: $case → $en", (row) => {
    const notice = costGuardNotice(bodyOf(row));
    if (row.className === null) {
      expect(notice).toBeUndefined();
      return;
    }
    expect(notice?.className).toBe(row.className);
    expect(translations("en")(notice!.key)).toBe(row.en!);
    expect(translations("zh-Hant")(notice!.key)).toBe(row.zh!);
  });

  test("CG12: a body that is not an object shows nothing", () => {
    for (const body of [null, undefined, "tripped", 1, [], { status: "TRIPPED", enforced: true }]) {
      expect(costGuardNotice(body)).toBeUndefined();
    }
  });

  test("CG12: the pill reuses the overdue and stale tokens, with no colour literal of its own", async () => {
    const css = (await Bun.file(join(import.meta.dir, "..", "styles.css")).text()).replace(/\/\*[\s\S]*?\*\//gu, "");
    const body = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .filter((m) => m[1]!.split(",").map((part) => part.trim()).includes(selector))
      .map((m) => m[2]!).join(";");
    expect(body(".cost-guard-pill.is-warn")).toContain("color: var(--text-pill-overdue)");
    expect(body(".cost-guard-pill.is-warn")).toContain("background: var(--surface-pill-overdue)");
    expect(body(".cost-guard-pill.is-tripped")).toContain("color: var(--text-pill-stale)");
    expect(body(".cost-guard-pill.is-tripped")).toContain("background: var(--surface-pill-stale)");
    for (const selector of [".cost-guard-pill", ".cost-guard-pill.is-warn", ".cost-guard-pill.is-tripped"]) {
      expect(body(selector)).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu);
    }
  });
});

type Handler = typeof onRequestGet;
const call = (env: Record<string, unknown>) =>
  onRequestGet({ env, request: new Request("https://kb.example/api/cost-guard") } as unknown as Parameters<Handler>[0]);

function namespace(answer: () => Promise<Response>) {
  const seen: { name?: string; url?: string } = {};
  return {
    seen,
    idFromName(name: string) { seen.name = name; return { name }; },
    get() { return { fetch: (url: string) => { seen.url = url; return answer(); } }; },
  };
}

describe("Spec 026 GET /api/cost-guard", () => {
  test("CG12: without the COST_GUARD_STATE binding it answers 200 {status: \"off\"}", async () => {
    const response = await call({});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "off" });
  });

  test("CG12: with the binding it returns exactly {status, enforced} from the cost-guard-v1 object", async () => {
    expect(COST_GUARD_OBJECT_NAME).toBe("cost-guard-v1");
    const fake = namespace(async () => Response.json({ status: "tripped", enforced: true, extra: 1, metrics: { a: 99 } }));
    const response = await call({ COST_GUARD_STATE: fake });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "tripped", enforced: true });
    expect(fake.seen).toEqual({ name: "cost-guard-v1", url: "https://cost-guard.internal/public" });
  });

  test.each([
    ["an unknown status", async () => Response.json({ status: "panic", enforced: true })],
    ["a non-boolean enforced", async () => Response.json({ status: "ok", enforced: "yes" })],
    ["a non-JSON body", async () => new Response("<html>")],
    ["a 500", async () => Response.json({ status: "ok", enforced: false }, { status: 500 })],
    ["a thrown fetch", async () => { throw new Error("object unreachable"); }],
  ] as const)("CG12: a binding answering %s is 503 no-store {error}", async (_name, answer) => {
    const response = await call({ COST_GUARD_STATE: namespace(answer) });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["error"]);
    expect(typeof body.error).toBe("string");
  });
});
