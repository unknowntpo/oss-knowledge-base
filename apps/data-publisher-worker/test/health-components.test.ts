/**
 * Spec 033 slice 2: `/health` `components` (Behavior 7) and the CORS header of `GET /health`
 * (Behavior 8). The status rules run on the case file; the Worker tests serve `/health` from fakes
 * (no network, no Cloudflare binding).
 */
import { describe, expect, test } from "bun:test";
import worker from "../src/index";
import { healthComponents } from "../src/signals/components";
import { COMPONENT_IDS } from "../src/signals/profile";
import { BASE_HEALTH, NOW, testPlanRows } from "./health-components.cases";

type Entry = { readonly id: string; readonly status: string; readonly at: string | null; readonly reason?: string };

describe("Spec 033 Behavior 7: component status rules", () => {
  test.each([...testPlanRows])("$id: $component, $why → $status", (row) => {
    const body: Record<string, unknown> = { ...BASE_HEALTH, ...(JSON.parse(row.state) as Record<string, unknown>) };
    if (row.off !== "—") delete body[row.off];
    const components = healthComponents(body, Date.parse(NOW), { digest: true, embedding: true }) as readonly Entry[];
    if (row.component === "every id") {
      expect(components.map((entry) => entry.id).sort()).toEqual([...COMPONENT_IDS].sort());
      expect(components.filter((entry) => entry.status !== "ok")).toEqual([]);
      return;
    }
    const entry = components.find((candidate) => candidate.id === row.component);
    if (row.status === "absent") {
      expect(entry).toBeUndefined();
      // The other jobs stay listed: only the job that is off goes.
      expect(components.length).toBe(COMPONENT_IDS.length - 1);
      return;
    }
    expect(entry?.status).toBe(row.status);
    if (row.reason === "—") expect(entry).not.toHaveProperty("reason");
    else expect(entry!.reason).toContain(row.reason);
    // Every listed entry has the contract's shape.
    for (const candidate of components) {
      expect(["ok", "warn", "failed", "stale", "unknown"]).toContain(candidate.status);
      expect(candidate.at === null || !Number.isNaN(Date.parse(candidate.at))).toBe(true);
    }
  });

  test("SM10: a digest or embedding object that did not answer is listed only while its flag is on", () => {
    const body = { ...BASE_HEALTH, digest: null, searchEmbedding: null };
    const ids = (on: { digest: boolean; embedding: boolean }) => healthComponents(body, Date.parse(NOW), on).map((entry) => entry.id);
    expect(ids({ digest: false, embedding: false })).not.toContain("digest");
    expect(ids({ digest: false, embedding: false })).not.toContain("embedding");
    expect(ids({ digest: true, embedding: true })).toEqual(expect.arrayContaining(["digest", "embedding"]));
  });
});

const AGO = (ms: number) => new Date(Date.now() - ms).toISOString();

class KeyBucket {
  readonly objects = new Map<string, string>();
  readonly operations: string[] = [];
  async get(key: string) {
    this.operations.push(`get ${key}`);
    const body = this.objects.get(key);
    return body === undefined ? null : { text: async () => body, json: async () => JSON.parse(body) };
  }
  async put(key: string) { this.operations.push(`put ${key}`); return { key }; }
  async list() { this.operations.push("list"); return { objects: [], truncated: false }; }
  async delete(key: string) { this.operations.push(`delete ${key}`); }
}

const jsonObject = (body: unknown, status = 200) => ({ idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json(body, { status }) }) });

/** Dev on 2026-10-26: every job on; kip-pages' last run failed on a cwiki 503. */
function devEnv(overrides: Record<string, unknown> = {}) {
  const recent = AGO(60_000);
  const bucket = new KeyBucket();
  bucket.objects.set("internal/kips/v1/last-run.json", JSON.stringify({
    revision: "authors@1", lastRun: { ok: false, status: "failed", at: recent, durationMs: 970, error: "cwiki.apache.org answered 503" }, lastGoodAt: AGO(3_600_000), coverageFrom: null,
  }));
  bucket.objects.set("internal/identity/v1/last-run.json", JSON.stringify({ revision: "corroborated@1", lastRun: { ok: true, status: "ok", at: recent, durationMs: 1 }, lastGoodAt: recent }));
  bucket.objects.set("internal/sre/v1/dev/state.json", JSON.stringify({ lastRun: { runId: "sre-agent-x", at: recent, status: "ok", firings: 1, diagnosed: 1, notDiagnosed: 0, modelCalls: 1, neurons: 1, verdicts: ["inconclusive"], recordKey: "k" }, today: null }));
  const sources = { github: { ok: true, lastSuccessAt: recent }, mail: { ok: true, lastSuccessAt: recent }, jira: { ok: true, lastSuccessAt: recent } };
  const env = {
    PUBLICATION_ENVIRONMENT: "development",
    PIPELINE_STATE: jsonObject({ environment: "development", running: false, scheduled: false, followUp: null, phase: null, lastRun: { ok: true, completedAt: recent, sources }, sources }),
    DIGEST_RUN: jsonObject({ enabled: true, running: false, lastRun: { ok: true, completedAt: recent } }),
    DIGEST_ENABLED: "true",
    COST_GUARD: "monitor",
    COST_GUARD_STATE: jsonObject({ mode: "monitor", status: "tripped", reason: null, checkedAt: recent, metrics: { r2ClassA: { percent: 207.81, status: "tripped" } } }),
    IDENTITY_LINKS: "corroborated@1",
    KIP_PAGES: "authors@1",
    SRE_AGENT: "live",
    MANUAL_TRIGGER_TOKEN: "token-under-test",
    OSS_KB_BUCKET: bucket,
    ...overrides,
  };
  return { env, bucket };
}

const health = async (env: unknown) => {
  const response = await worker.fetch(new Request("https://data.example/health", { headers: { origin: "https://oss-knowledge-base-docs.pages.dev" } }), env as never);
  return { response, body: await response.json() as { components: Entry[] } & Record<string, unknown> };
};

describe("Spec 033 Behavior 7: /health components, served", () => {
  test("SM9: Dev state with kipPages.lastRun.status failed → components has kip-pages failed with the run's error as reason", async () => {
    const { response, body } = await health(devEnv().env);
    expect(response.status).toBe(200);
    const kip = body.components.find((entry) => entry.id === "kip-pages");
    expect(kip).toMatchObject({ id: "kip-pages", status: "failed", reason: "cwiki.apache.org answered 503" });
    expect(kip!.at).toBe((body.kipPages as { lastRun: { at: string } }).lastRun.at);
    // Positive control: the other jobs Dev runs here are listed with their own status; OBSERVABILITY_SIGNALS is unset.
    expect(body).not.toHaveProperty("signals");
    const status = Object.fromEntries(body.components.map((entry) => [entry.id, entry.status]));
    expect(status).toEqual({
      publication: "ok", "source:github": "ok", "source:mail": "ok", "source:jira": "ok", digest: "ok",
      "cost-guard": "warn", "identity-links": "ok", "kip-pages": "failed", "sre-agent": "warn",
    });
  });

  test("SM10: a job that is off is not listed (Prod: SRE_AGENT, COST_GUARD, IDENTITY_LINKS, KIP_PAGES unset; DIGEST_ENABLED unset here too)", async () => {
    const { env } = devEnv({ SRE_AGENT: undefined, COST_GUARD: undefined, DIGEST_ENABLED: undefined, IDENTITY_LINKS: undefined, KIP_PAGES: undefined,
      DIGEST_RUN: jsonObject({ enabled: false, running: false, lastRun: null }) });
    const { body } = await health(env);
    expect(body.components.map((entry) => entry.id)).toEqual(["publication", "source:github", "source:mail", "source:jira"]);
  });

  test("SM18: every job's state missing or unreadable → each entry unknown with a reason, and /health still answers 200", async () => {
    const broken = { idFromName: (name: string) => name, get: () => ({ fetch: async () => { throw new Error("object reset"); } }) };
    const bucket = { get: async () => { throw new Error("R2 unavailable"); }, put: async () => ({}), list: async () => ({ objects: [] }), delete: async () => {} };
    const { env } = devEnv({ DIGEST_RUN: broken, COST_GUARD_STATE: broken, OSS_KB_BUCKET: bucket });
    const { response, body } = await health(env);
    expect(response.status).toBe(200);
    const unknown = body.components.filter((entry) => ["digest", "cost-guard", "identity-links", "kip-pages", "sre-agent"].includes(entry.id));
    expect(unknown.map((entry) => entry.id).sort()).toEqual(["cost-guard", "digest", "identity-links", "kip-pages", "sre-agent"]);
    for (const entry of unknown) {
      expect(entry.status).toBe("unknown");
      expect(entry.reason ?? "").not.toBe("");
    }
  });

  test("SM11: GET /health answers with access-control-allow-origin: *, also when the publisher is not ok", async () => {
    const { response } = await health(devEnv().env);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const down = await worker.fetch(new Request("https://data.example/health"), devEnv({ PIPELINE_STATE: jsonObject({ error: "busy" }, 503) }).env as never);
    expect(down.status).toBe(503);
    expect(down.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("SM11: POST /run and every other route answer without access-control-allow-origin", async () => {
    const { env } = devEnv({ PIPELINE_STATE: jsonObject({ accepted: true }, 202) });
    const requests = [
      new Request("https://data.example/run", { method: "POST" }),
      new Request("https://data.example/run", { method: "POST", headers: { authorization: "Bearer token-under-test" } }),
      new Request("https://data.example/digest/run", { method: "POST" }),
      // A JSON answer through the same json() as /health.
      new Request("https://data.example/github-reviews/run", { method: "POST", headers: { authorization: "Bearer token-under-test" } }),
      new Request("https://data.example/kip-pages/run", { method: "POST" }),
      new Request("https://data.example/health", { method: "POST" }),
      new Request("https://data.example/health", { method: "OPTIONS" }),
      new Request("https://data.example/nope"),
    ];
    const answers = await Promise.all(requests.map(async (request) => {
      const response = await worker.fetch(request, env as never);
      return [`${request.method} ${new URL(request.url).pathname}`, response.status, response.headers.get("access-control-allow-origin")];
    }));
    expect(answers).toEqual([
      ["POST /run", 401, null], ["POST /run", 202, null], ["POST /digest/run", 401, null], ["POST /github-reviews/run", 403, null], ["POST /kip-pages/run", 401, null],
      ["POST /health", 404, null], ["OPTIONS /health", 404, null], ["GET /nope", 404, null],
    ]);
  });
});
