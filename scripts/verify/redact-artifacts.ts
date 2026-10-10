// bun scripts/verify/redact-artifacts.ts <dir>...
// Before CI uploads Playwright evidence from a public repository: replaces the Cloudflare
// Access token values (CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET) with *** in every
// file under the given directories, including files inside zips (traces) and the zip the
// HTML report embeds as base64 in index.html. Then exits 1 if any value, or a base64
// encoding of one, is still found anywhere, so the upload step never runs. Prints paths, never values.
// Not detected (docs/gardening.md G30): gzip, hex, \u-escaped JSON, UTF-16, a value split
// across lines, or reversed. Playwright writes none of these for header values today.
// Needs the `zip` and `unzip` commands (present on GitHub's ubuntu runners and macOS).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const embeddedZip = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/gu;

function isZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  if (statSync(root).isFile()) return [root];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** Calls `visit` on the extracted tree of a zip; when it returns true the zip is rebuilt from that tree. */
function withZip(zip: Buffer, visit: (dir: string) => boolean): Buffer | undefined {
  const dir = mkdtempSync(join(tmpdir(), "redact-zip-"));
  try {
    const source = join(dir, "in.zip");
    const tree = join(dir, "tree");
    writeFileSync(source, zip);
    execFileSync("unzip", ["-qq", "-o", source, "-d", tree]);
    if (!visit(tree)) return undefined;
    const out = join(dir, "out.zip");
    execFileSync("zip", ["-qr", "-X", out, "."], { cwd: tree });
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Base64 fragments that appear whenever `value` is base64-encoded, whatever its byte offset. */
function base64Forms(value: string): string[] {
  const forms: string[] = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const encoded = Buffer.concat([Buffer.alloc(offset), Buffer.from(value)]).toString("base64").replace(/=+$/u, "");
    // Drop the characters that mix in the neighbouring bytes on either side.
    const core = encoded.slice(offset === 0 ? 0 : offset + 1, -2);
    if (core.length >= 8) forms.push(core);
  }
  return forms;
}

function redactBuffer(buffer: Buffer, values: readonly string[]): Buffer | undefined {
  if (isZip(buffer)) return withZip(buffer, (tree) => redactFiles(tree, values));
  let text = buffer.toString("latin1");
  let changed = false;
  text = text.replace(embeddedZip, (match, data: string) => {
    const rebuilt = redactBuffer(Buffer.from(data, "base64"), values);
    if (rebuilt === undefined) return match;
    changed = true;
    return `data:application/zip;base64,${rebuilt.toString("base64")}`;
  });
  for (const value of values) {
    const raw = Buffer.from(value).toString("latin1");
    if (raw !== "" && text.includes(raw)) {
      text = text.split(raw).join("***");
      changed = true;
    }
  }
  return changed ? Buffer.from(text, "latin1") : undefined;
}

function redactFiles(root: string, values: readonly string[]): boolean {
  let changed = false;
  for (const file of files(root)) {
    const rebuilt = redactBuffer(readFileSync(file), values);
    if (rebuilt !== undefined) {
      writeFileSync(file, rebuilt);
      changed = true;
    }
  }
  return changed;
}

/** Rewrites every file under `roots` so that no value remains in plain text (zips included). */
export function redactTree(roots: readonly string[], values: readonly string[]): void {
  const nonEmpty = values.filter((value) => value !== "");
  if (nonEmpty.length === 0) return;
  for (const root of roots) redactFiles(root, nonEmpty);
}

function findInBuffer(buffer: Buffer, label: string, values: readonly string[], hits: string[]): void {
  if (isZip(buffer)) {
    withZip(buffer, (tree) => {
      for (const file of files(tree)) findInBuffer(readFileSync(file), `${label} ${relative(tree, file)}`, values, hits);
      return false;
    });
    return;
  }
  const text = buffer.toString("latin1");
  for (const [, data] of text.matchAll(embeddedZip)) {
    findInBuffer(Buffer.from(data!, "base64"), `${label} (embedded zip)`, values, hits);
  }
  const plain = values.some((value) => text.includes(Buffer.from(value).toString("latin1")));
  const encoded = values.some((value) => base64Forms(value).some((form) => text.includes(form)));
  if (plain || encoded) hits.push(label);
}

/** Where any value (or a base64 encoding of it) still appears; labels only, never values. */
export function findSecrets(roots: readonly string[], values: readonly string[]): string[] {
  const nonEmpty = values.filter((value) => value !== "");
  const hits: string[] = [];
  if (nonEmpty.length === 0) return hits;
  for (const root of roots) for (const file of files(root)) findInBuffer(readFileSync(file), file, nonEmpty, hits);
  return hits;
}

function main(): void {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    console.error("usage: bun scripts/verify/redact-artifacts.ts <dir>...");
    process.exit(2);
  }
  const values = [process.env.CF_ACCESS_CLIENT_ID ?? "", process.env.CF_ACCESS_CLIENT_SECRET ?? ""].filter((v) => v !== "");
  if (values.length === 0) {
    console.log("redact-artifacts: no Access token configured; nothing to redact");
    return;
  }
  redactTree(roots, values);
  const hits = findSecrets(roots, values);
  if (hits.length > 0) {
    console.error(`redact-artifacts: an Access token value is still present in ${hits.length} file(s); do not upload:`);
    for (const hit of hits) console.error(`  ${hit}`);
    process.exit(1);
  }
  console.log(`redact-artifacts: no Access token value left under ${roots.join(", ")}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
