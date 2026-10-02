import { GitHubConnector } from "@oss-knowledge-base/github-publisher/github-connector";
import { DurableObjectPipelineState } from "./durable-object-state";
import { GitHubFetchTransport } from "./github-transport";
import { R2PublicationDestination } from "./r2-destination";
import { runPending } from "./run-schedule";
import { runDataPublication, type PipelinePhaseMarker, type PipelineRunStatus } from "./pipeline";

interface Env {
  readonly PUBLICATION_ENVIRONMENT: "development" | "production";
  readonly GITHUB_SOURCE_TOKEN?: string;
  readonly MANUAL_TRIGGER_TOKEN?: string;
  readonly OSS_KB_BUCKET: R2Bucket;
  readonly PIPELINE_STATE: DurableObjectNamespace;
}

const STATE_OBJECT_NAME = "github-feed-search-pipeline-v1";
// Keeps one run under the Durable Object memory limit; a larger backlog catches up over later runs.
const MAX_ISSUES_PER_SOURCE = 200;

export default {
  async scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    const stub = env.PIPELINE_STATE.get(env.PIPELINE_STATE.idFromName(STATE_OBJECT_NAME));
    context.waitUntil(stub.fetch("https://pipeline.internal/run", {
      method: "POST",
      headers: { "x-scheduled-at": new Date(controller.scheduledTime).toISOString() },
    }).then(async (response) => {
      // 409 means a run is already scheduled or active; the next Cron tick picks up the rest.
      if (!response.ok && response.status !== 409) {
        throw new Error(`Scheduling publication failed: ${await response.text()}`);
      }
    }));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const stub = env.PIPELINE_STATE.get(env.PIPELINE_STATE.idFromName(STATE_OBJECT_NAME));
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return stub.fetch("https://pipeline.internal/status");
    }
    if (request.method === "POST" && url.pathname === "/run") {
      const authorization = request.headers.get("authorization");
      const manualToken = env.MANUAL_TRIGGER_TOKEN?.trim() ?? "";
      if (manualToken.length === 0 || authorization !== `Bearer ${manualToken}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      return stub.fetch("https://pipeline.internal/run", {
        method: "POST",
        headers: { "x-scheduled-at": new Date().toISOString() },
      });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Runs publish from the object's alarm instead of the triggering request. The runtime never runs
 * two alarms at once and retries one that dies, so no lease is needed, and a run no longer depends
 * on the Cron invocation or the manual caller staying connected.
 */
export class PipelineState implements DurableObject {
  private running = false;

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/status") {
      const status = await this.ctx.storage.get<PipelineRunStatus>("status");
      const phase = await this.ctx.storage.get<PipelinePhaseMarker>("phase");
      return Response.json({
        environment: this.env.PUBLICATION_ENVIRONMENT,
        running: this.running,
        scheduled: runPending(false, await this.ctx.storage.getAlarm(), Date.now()),
        // Set while a run is unfinished; left by a run the platform killed until a later run completes.
        phase: phase ?? null,
        lastRun: status ?? null,
      });
    }
    if (request.method !== "POST" || path !== "/run") return new Response("Not found", { status: 404 });
    // A stale alarm (its retries exhausted) is overwritten below instead of blocking every trigger.
    if (runPending(this.running, await this.ctx.storage.getAlarm(), Date.now())) {
      return Response.json({ ok: false, skipped: "already-running" }, { status: 409 });
    }
    await this.ctx.storage.put("requested-at", request.headers.get("x-scheduled-at") ?? new Date().toISOString());
    await this.ctx.storage.delete("run-lease"); // written by the pre-alarm implementation
    await this.ctx.storage.setAlarm(Date.now());
    return Response.json({ ok: true, scheduled: true }, { status: 202 });
  }

  async alarm(): Promise<void> {
    this.running = true;
    try {
      const materializedAt = await this.ctx.storage.get<string>("requested-at") ?? new Date().toISOString();
      await runDataPublication({
        environment: this.env.PUBLICATION_ENVIRONMENT,
        materializedAt,
        connector: new GitHubConnector({
          transport: new GitHubFetchTransport(this.env.GITHUB_SOURCE_TOKEN ?? ""),
          maxIssuesPerSource: MAX_ISSUES_PER_SOURCE,
        }),
        state: new DurableObjectPipelineState(this.ctx.storage),
        destination: new R2PublicationDestination(this.env.OSS_KB_BUCKET),
      });
    } finally {
      this.running = false;
    }
  }
}
