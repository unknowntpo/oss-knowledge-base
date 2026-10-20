/**
 * Spec 025 deploy step (ci.yml job `deploy-docs`):
 *
 *   deploy.ts --dir dist/docs-site --sha <commit>
 *
 * Deploys the built site to the Cloudflare Pages project `oss-knowledge-base-docs` (branch `main`)
 * only on a push to main, and only when that project already exists: this job never creates it.
 * A missing project is a skip with a notice, not a failure. After a deploy it reads the published
 * build.json until it names the commit. Never prints a credential.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_NAME, SITE_URL } from "./generate";

export type Decision = { readonly action: "deploy" | "skip" | "fail"; readonly message: string };

export function deployDecision(input: {
  readonly event: string;
  readonly ref: string;
  readonly hasCredentials: boolean;
  /** HTTP status of GET /accounts/{id}/pages/projects/{name}; null when it was not asked. */
  readonly projectStatus: number | null;
}): Decision {
  if (input.event !== "push" || input.ref !== "refs/heads/main") {
    return { action: "skip", message: `only a push to main deploys the docs site (event ${input.event}, ref ${input.ref})` };
  }
  if (!input.hasCredentials) return { action: "fail", message: "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required" };
  if (input.projectStatus === 200) return { action: "deploy", message: `deploying to Pages project ${PROJECT_NAME}` };
  if (input.projectStatus === 404) {
    return {
      action: "skip",
      message: `Pages project ${PROJECT_NAME} does not exist yet; nothing deployed. Create it once (docs/specs/025-docs-site/spec.md, "One-time setup"); the next push to main deploys.`,
    };
  }
  return { action: "fail", message: `could not read Pages project ${PROJECT_NAME} (HTTP ${input.projectStatus ?? "none"}); check the token's Pages permission` };
}

/** Whether a published build.json names the commit the run built. */
export function publishedMatches(body: string, sha: string): boolean {
  try {
    const parsed = JSON.parse(body) as { schema?: unknown; commit?: unknown };
    return parsed.schema === "docs-site.build.v1" && parsed.commit === sha;
  } catch {
    return false;
  }
}

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value === "") throw new Error(`--${name} is required`);
  return value;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = flag("dir");
  const sha = flag("sha");
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const summary = (line: string) => {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  const event = process.env.GITHUB_EVENT_NAME ?? "local";
  const ref = process.env.GITHUB_REF ?? "";
  const hasCredentials = token !== "" && account !== "";
  let projectStatus: number | null = null;
  if (event === "push" && ref === "refs/heads/main" && hasCredentials) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${PROJECT_NAME}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    projectStatus = response.status;
    await response.body?.cancel();
  }
  const decision = deployDecision({ event, ref, hasCredentials, projectStatus });
  console.log(`${decision.action === "fail" ? "::error::" : decision.action === "skip" ? "::notice::" : ""}${decision.message}`);
  summary(`Docs site: ${decision.action} — ${decision.message}`);
  if (decision.action === "fail") process.exit(1);
  if (decision.action === "skip") process.exit(0);

  const child = spawnSync("bunx", ["wrangler", "pages", "deploy", dir, `--project-name=${PROJECT_NAME}`, "--branch=main", `--commit-hash=${sha}`], {
    stdio: "inherit",
  });
  if (child.status !== 0) {
    console.log("::error::wrangler pages deploy failed");
    process.exit(1);
  }
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await fetch(`${SITE_URL}/build.json`, { headers: { "cache-control": "no-cache" } }).catch(() => null);
    const body = response === null ? "" : await response.text();
    if (response?.ok && publishedMatches(body, sha)) {
      console.log(`${SITE_URL} serves ${sha.slice(0, 7)}`);
      summary(`Published ${SITE_URL} at ${sha.slice(0, 7)}`);
      process.exit(0);
    }
    await new Promise((done) => setTimeout(done, 6000));
  }
  console.log(`::error::${SITE_URL}/build.json does not name ${sha} after 10 tries`);
  process.exit(1);
}
