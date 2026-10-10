import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { findSecrets, redactTree } from "../verify/redact-artifacts";

// Dummy values only.
const id = "dummy-id-redact-0001.access";
const secret = "dummy-secret-redact-9f8e7d6c5b4a";
const values = [id, secret];
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "redact-test-"));
  dirs.push(dir);
  return dir;
}

function zipOf(files: Record<string, string>): Buffer {
  const source = tempDir();
  for (const [name, content] of Object.entries(files)) writeFileSync(join(source, name), content);
  const out = join(tempDir(), "x.zip");
  execFileSync("zip", ["-qr", "-X", out, "."], { cwd: source });
  return readFileSync(out);
}

/** An uploaded artifact tree with the token in every shape Playwright writes. */
function leakyTree(): string {
  const root = tempDir();
  mkdirSync(join(root, "test-results", "case"), { recursive: true });
  mkdirSync(join(root, "report", "data"), { recursive: true });
  writeFileSync(join(root, "test-results", "case", "error-context.md"), `Call log:\n  - CF-Access-Client-Secret: ${secret}\n`);
  writeFileSync(join(root, "report", "data", "abc.md"), `CF-Access-Client-Id: ${id}`);
  // A trace: headers inside a zipped NDJSON file.
  writeFileSync(join(root, "test-results", "case", "trace.zip"), zipOf({ "0-trace.network": `{"name":"cf-access-client-secret","value":"${secret}"}\n` }));
  // The HTML report embeds its data as a base64 zip in index.html.
  const embedded = zipOf({ "report.json": JSON.stringify({ error: `CF-Access-Client-Id: ${id}` }) }).toString("base64");
  writeFileSync(join(root, "report", "index.html"), `<script>window.playwrightReportBase64 = "data:application/zip;base64,${embedded}";</script>`);
  // Base64 of a header value, as a binary resource could carry it.
  writeFileSync(join(root, "report", "data", "blob.txt"), Buffer.from(`xx${secret}yy`).toString("base64"));
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("findSecrets", () => {
  test("finds the value in plain files, trace zips, the report's embedded zip, and base64 text", () => {
    const root = leakyTree();
    expect(findSecrets([root], values).map((hit) => hit.replace(root, "")).sort()).toEqual([
      "/report/data/abc.md",
      "/report/data/blob.txt",
      "/report/index.html (embedded zip) report.json",
      "/test-results/case/error-context.md",
      "/test-results/case/trace.zip 0-trace.network",
    ]);
  });

  test("a clean tree has no findings", () => {
    const root = tempDir();
    writeFileSync(join(root, "a.md"), "nothing here");
    expect(findSecrets([root], values)).toEqual([]);
  });
});

describe("redactTree", () => {
  test("after redaction no plain value is left, and the files stay readable", () => {
    const root = leakyTree();
    redactTree([root], values);
    // Base64-encoded copies cannot be rewritten in place; the gate keeps failing on them, so the upload is skipped.
    expect(findSecrets([root], values).map((hit) => hit.replace(root, ""))).toEqual(["/report/data/blob.txt"]);
    expect(readFileSync(join(root, "test-results", "case", "error-context.md"), "utf8")).toContain("CF-Access-Client-Secret: ***");
    const listing = execFileSync("unzip", ["-p", join(root, "test-results", "case", "trace.zip")]).toString();
    expect(listing).toContain('"value":"***"');
    expect(readFileSync(join(root, "report", "index.html"), "utf8")).toContain("data:application/zip;base64,");
  });

  test("missing directories are skipped", () => {
    expect(() => redactTree([join(tempDir(), "absent")], values)).not.toThrow();
  });
});

describe("redact-artifacts CLI (the CI step before upload)", () => {
  const script = resolve(import.meta.dir, "../verify/redact-artifacts.ts");
  function cli(root: string, env: Record<string, string>) {
    const { CF_ACCESS_CLIENT_ID: _id, CF_ACCESS_CLIENT_SECRET: _secret, ...rest } = process.env;
    return spawnSync("bun", [script, root], { env: { ...rest, ...env }, encoding: "utf8" });
  }

  test("no token configured: nothing to do, exit 0", () => {
    const run = cli(leakyTree(), {});
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("nothing to redact");
  });

  test("a copy it cannot rewrite (base64): exit 1 naming the file, never the value", () => {
    const run = cli(leakyTree(), { CF_ACCESS_CLIENT_ID: id, CF_ACCESS_CLIENT_SECRET: secret });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("blob.txt");
    expect(`${run.stdout}${run.stderr}`).not.toContain(secret);
    expect(`${run.stdout}${run.stderr}`).not.toContain(id);
  });

  test("everything rewritable: exit 0", () => {
    const root = leakyTree();
    rmSync(join(root, "report", "data", "blob.txt"));
    const run = cli(root, { CF_ACCESS_CLIENT_ID: id, CF_ACCESS_CLIENT_SECRET: secret });
    expect(run.status).toBe(0);
    expect(findSecrets([root], values)).toEqual([]);
  });
});
