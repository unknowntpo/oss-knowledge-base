// scripts/release/put-prod-secrets.sh against fake `bunx`, `security` and `openssl` on PATH:
// it must put both Prod secrets through stdin only and never print a value.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../release/put-prod-secrets.sh");
const GENERATED = "a".repeat(64);
const GITHUB = "github_pat_FAKEVALUE0123456789";

let dir: string;

function fake(name: string, body: string): void {
  const path = join(dir, "bin", name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "put-prod-secrets-"));
  Bun.spawnSync(["mkdir", "-p", join(dir, "bin")]);
  // bunx wrangler …: log the arguments and stdin; `secret list` answers from $FAKE_SECRETS.
  fake(
    "bunx",
    `echo "ARGS $* CWD $(basename "$PWD")" >> "$FAKE_DIR/wrangler.log"
if [[ "$2 $3" == "secret list" ]]; then printf '%s' "$FAKE_SECRETS"; exit 0; fi
echo "STDIN $(cat)" >> "$FAKE_DIR/wrangler.log"`,
  );
  fake(
    "security",
    `case "$1" in
  find-generic-password)
    [[ -f "$FAKE_DIR/keychain" ]] || exit 44
    if [[ " $* " == *" -w "* || "\${@: -1}" == "-w" ]]; then cat "$FAKE_DIR/keychain"; fi ;;
  add-generic-password)
    echo "ADD $*" >> "$FAKE_DIR/security.log"
    printf '%s' "\${@: -1}" > "$FAKE_DIR/keychain" ;;
esac`,
  );
  fake("openssl", `printf '%s' "${GENERATED}"`);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], stdin: string, secrets = "") {
  const result = Bun.spawnSync(["bash", script, ...args], {
    stdin: new TextEncoder().encode(stdin),
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, FAKE_DIR: dir, FAKE_SECRETS: secrets },
  });
  const read = (file: string) => {
    try {
      return readFileSync(join(dir, file), "utf8");
    } catch {
      return "";
    }
  };
  return { code: result.exitCode, out: `${result.stdout}${result.stderr}`, wrangler: read("wrangler.log"), security: read("security.log") };
}

describe("put-prod-secrets.sh", () => {
  test("generates the trigger token into the Keychain, puts both secrets on stdin, and prints no value", () => {
    const { code, out, wrangler } = run([], `${GITHUB}\n`);
    expect(code).toBe(0);
    expect(wrangler).toContain("ARGS wrangler secret put MANUAL_TRIGGER_TOKEN -c wrangler.production.jsonc CWD data-publisher-worker");
    expect(wrangler).toContain(`STDIN ${GENERATED}`);
    expect(wrangler).toContain("ARGS wrangler secret put GITHUB_SOURCE_TOKEN -c wrangler.production.jsonc CWD data-publisher-worker");
    expect(wrangler).toContain(`STDIN ${GITHUB}`);
    expect(wrangler).not.toContain("development");
    expect(out).toContain("put: MANUAL_TRIGGER_TOKEN");
    expect(out).toContain("put: GITHUB_SOURCE_TOKEN");
    expect(out).not.toContain(GENERATED);
    expect(out).not.toContain(GITHUB);
    // No value is ever a wrangler argument.
    for (const line of wrangler.split("\n").filter((l) => l.startsWith("ARGS"))) {
      expect(line).not.toContain(GENERATED);
      expect(line).not.toContain(GITHUB);
    }
  });

  test("reuses an existing Keychain token instead of generating a new one", () => {
    writeFileSync(join(dir, "keychain"), "b".repeat(64));
    const { code, out, wrangler, security } = run([], `${GITHUB}\n`);
    expect(code).toBe(0);
    expect(security).toBe("");
    expect(wrangler).toContain(`STDIN ${"b".repeat(64)}`);
    expect(out).toContain("reused from Keychain");
  });

  test("an empty GitHub token puts nothing for it and fails", () => {
    const { code, wrangler } = run([], "\n");
    expect(code).toBe(1);
    expect(wrangler).not.toContain("GITHUB_SOURCE_TOKEN");
  });

  test("--check lists names only and fails while one is missing", () => {
    const missing = run(["--check"], "", '[{"name": "MANUAL_TRIGGER_TOKEN", "type": "secret_text"}]');
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("present: MANUAL_TRIGGER_TOKEN");
    expect(missing.out).toContain("missing: GITHUB_SOURCE_TOKEN");
    const both = run(["--check"], "", '[{"name": "GITHUB_SOURCE_TOKEN"}, {"name": "MANUAL_TRIGGER_TOKEN"}]');
    expect(both.code).toBe(0);
    expect(both.wrangler).not.toContain("secret put");
  });
});
