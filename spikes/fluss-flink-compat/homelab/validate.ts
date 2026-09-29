import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const repoDir = "/workspace";
const spikeDir = join(repoDir, "spikes", "fluss-flink-compat");
const evidenceDir = process.env.EVIDENCE_DIR ?? "/evidence";
const bootstrapServers = required("FLUSS_BOOTSTRAP_SERVERS");
const restAddress = required("FLINK_REST_ADDRESS");
const restPort = Number(process.env.FLINK_REST_PORT ?? "8081");
const runId = new Date().toISOString().replaceAll(":", "-");
const database = `osskb_homelab_${runId.replaceAll(/[^0-9A-Za-z]/g, "_")}`;
const candidatePath = join(evidenceDir, `${runId}-candidate.json`);
const evidencePath = join(evidenceDir, `${runId}-evidence.json`);
const fixturePath = join(repoDir, "packages/reference-pipeline/test/fixtures/github-events.v1.json");
const oraclePath = join(repoDir, "packages/reference-pipeline/test/fixtures/github-feed-projection.v1.json");

async function run(command: string[]): Promise<void> {
  const process = Bun.spawn(command, { cwd: repoDir, stdout: "inherit", stderr: "inherit" });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed (${exitCode})`);
}

async function waitForFlink(): Promise<Record<string, unknown>> {
  const endpoint = `http://${restAddress}:${restPort}/overview`;
  const deadline = Date.now() + 120_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const overview = await response.json() as Record<string, unknown>;
        if (Number(overview.taskmanagers ?? 0) >= 1) return overview;
        lastError = new Error("Flink REST is ready but no TaskManager is registered");
      } else {
        lastError = new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`Flink REST did not become ready: ${String(lastError)}`);
}

await mkdir(evidenceDir, { recursive: true });
const startedAt = new Date().toISOString();
const overview = await waitForFlink();
let outcome = "failed";

try {
  await run([
    "mvn", "-B", "test", "-f", join(spikeDir, "pom.xml"),
    "-Dtest=ClusterSliceIT",
    "-Dfluss.it=true",
    `-Dfluss.bootstrap.servers=${bootstrapServers}`,
    `-Dfluss.database=${database}`,
    `-Dfluss.fixture=${fixturePath}`,
    `-Dfluss.candidate=${candidatePath}`,
    `-Dflink.rest.address=${restAddress}`,
    `-Dflink.rest.port=${restPort}`,
  ]);
  await run([
    "bun", join(repoDir, "packages/reference-pipeline/scripts/verify-parity.ts"),
    candidatePath, oraclePath,
  ]);
  outcome = "passed";
} finally {
  const candidate = await readFile(candidatePath, "utf8").then(JSON.parse, () => undefined);
  await writeFile(evidencePath, JSON.stringify({
    schema: "osskb.fluss-flink-homelab-evidence.v1",
    runId,
    database,
    deployment: "standalone-session-cluster",
    deploymentTarget: process.env.DEPLOYMENT_TARGET ?? "unknown",
    versions: { fluss: "0.9.1-incubating", flink: "1.20.3", javaBytecode: 17 },
    endpoints: { fluss: bootstrapServers, flinkRest: `${restAddress}:${restPort}` },
    flinkOverview: overview,
    candidatePath,
    candidateDigest: candidate?.digest,
    startedAt,
    finishedAt: new Date().toISOString(),
    outcome,
  }, null, 2));
  console.log(`evidence=${evidencePath}`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
