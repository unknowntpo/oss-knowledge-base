import { describe, expect, test } from "bun:test";

import { R2PublicationDestination } from "../src/r2-destination";

describe("R2 publication destination", () => {
  test("retries a transient R2 failure before writing a pointer", async () => {
    let puts = 0;
    const bucket = {
      put: async () => {
        puts += 1;
        if (puts === 1) throw new Error("put: We encountered an internal error. Please try again. (10001)");
        return null;
      },
    } as unknown as R2Bucket;
    const destination = new R2PublicationDestination(bucket, async () => undefined);

    await destination.putCurrent("public/v2/current.json", new Uint8Array([1]));
    expect(puts).toBe(2);
  });

  test("gives up after three attempts", async () => {
    let heads = 0;
    const bucket = {
      head: async () => {
        heads += 1;
        throw new Error("head: internal error (10001)");
      },
    } as unknown as R2Bucket;
    const destination = new R2PublicationDestination(bucket, async () => undefined);

    await expect(destination.putImmutableIfAbsent("public/v2/x.json", new Uint8Array([1]))).rejects.toThrow("10001");
    expect(heads).toBe(3);
  });
});
