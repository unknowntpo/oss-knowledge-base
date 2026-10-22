// Spec 028 slice 0 (OB30): the Analytics SQL binding (`"analytics"`) needs Wrangler >= 4.145.0,
// so both Worker packages and the lockfile must stay at or above it.
import { expect, test } from "bun:test";

const MINIMUM = [4, 145, 0] as const;
const root = new URL("../../", import.meta.url);

const atLeastMinimum = (version: string): boolean => {
  const parts = version.split(".").map(Number);
  for (let i = 0; i < MINIMUM.length; i += 1) {
    if (parts[i]! !== MINIMUM[i]) return parts[i]! > MINIMUM[i]!;
  }
  return true;
};

test("OB30: both Worker packages and bun.lock pin Wrangler >= 4.145.0", async () => {
  for (const pkg of ["apps/data-publisher-worker", "apps/web"]) {
    const manifest = await Bun.file(new URL(`${pkg}/package.json`, root)).json() as { devDependencies?: Record<string, string> };
    const range = manifest.devDependencies?.wrangler ?? "";
    expect(range, pkg).toMatch(/^\^\d+\.\d+\.\d+$/u);
    expect(atLeastMinimum(range.slice(1)), `${pkg} wrangler ${range}`).toBe(true);
  }
  const lock = await Bun.file(new URL("bun.lock", root)).text();
  const resolved = [...lock.matchAll(/"wrangler@(\d+\.\d+\.\d+)"/gu)].map((match) => match[1]!);
  expect(resolved.length).toBe(1);
  expect(atLeastMinimum(resolved[0]!), `bun.lock wrangler@${resolved[0]}`).toBe(true);
});

test("OB30 positive control: the comparison rejects the previous lock (4.125.0) and accepts the boundary", () => {
  expect(atLeastMinimum("4.125.0")).toBe(false);
  expect(atLeastMinimum("4.144.9")).toBe(false);
  expect(atLeastMinimum("4.145.0")).toBe(true);
  expect(atLeastMinimum("4.148.0")).toBe(true);
  expect(atLeastMinimum("5.0.0")).toBe(true);
});
