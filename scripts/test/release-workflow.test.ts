// The production deploy job checks the Prod Worker's runtime secrets before it deploys anything
// (runbook "First Prod release"): a tag pushed without them must change nothing.
import { expect, test } from "bun:test";

interface Step { readonly name?: string; readonly run?: string }

test("deploy-production requires the Prod Worker secrets before the Pages and Worker deploys", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(new URL("../../.github/workflows/ci.yml", import.meta.url)).text()) as {
    readonly jobs: Record<string, { readonly steps: readonly Step[] }>;
  };
  const steps = workflow.jobs["deploy-production"]!.steps;
  const index = (name: string) => steps.findIndex((step) => step.name === name);
  const check = index("Require provisioned production runtime secrets");
  expect(check).toBeGreaterThan(-1);
  expect(steps[check]!.run).toContain("wrangler secret list -c wrangler.production.jsonc");
  for (const name of ["GITHUB_SOURCE_TOKEN", "MANUAL_TRIGGER_TOKEN"]) expect(steps[check]!.run).toContain(name);
  const deploys = steps.flatMap((step, n) => (/deploy/iu.test(step.run ?? "") && /wrangler pages deploy|deploy-pages|deploy:production/u.test(step.run ?? "") ? [n] : []));
  expect(deploys.length).toBe(2);
  for (const n of deploys) expect(check).toBeLessThan(n);
});
