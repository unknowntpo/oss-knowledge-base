import { describe, expect, test } from "bun:test";

import { R2PublicationDestination } from "../src/r2-destination";
import { CountingR2Bucket } from "./support/counting-r2-bucket";

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

  test("C8: an immutable object that already exists costs one head and no put", async () => {
    const bucket = new CountingR2Bucket();
    const destination = new R2PublicationDestination(bucket.asBucket(), async () => undefined);
    const body = new TextEncoder().encode("detail");
    const object = await poolObject(body);
    bucket.objects.set(object.key, body);

    expect(await destination.putVerifiedImmutableIfAbsent(object, body)).toBe("exists");

    expect(bucket.calls.map((call) => call.op)).toEqual(["head"]);
    expect(destination.operationCounts()).toEqual({ classA: 0, classB: 1 });
  });

  test("C8: an absent immutable object is written once, with if-none-match and its sha256", async () => {
    const bucket = new CountingR2Bucket();
    const destination = new R2PublicationDestination(bucket.asBucket(), async () => undefined);
    const body = new TextEncoder().encode("detail");
    const object = await poolObject(body);

    expect(await destination.putVerifiedImmutableIfAbsent(object, body)).toBe("created");

    expect(bucket.calls.map((call) => call.op)).toEqual(["head", "put"]);
    const options = bucket.calls[1]!.options!;
    expect(options.sha256).toBe(object.sha256.replace("sha256:", ""));
    expect(new Headers(options.onlyIf as HeadersInit).get("if-none-match")).toBe("*");
    expect(options.httpMetadata).toEqual({ cacheControl: "public, max-age=31536000, immutable" });
    expect(bucket.objects.get(object.key)).toEqual(body);
    expect(destination.operationCounts()).toEqual({ classA: 1, classB: 1 });
  });

  test("C8: bytes that differ from the declared sha256 are rejected by the store and never written", async () => {
    const bucket = new CountingR2Bucket();
    const destination = new R2PublicationDestination(bucket.asBucket(), async () => undefined);
    const object = await poolObject(new TextEncoder().encode("detail"));

    await expect(destination.putVerifiedImmutableIfAbsent(object, new TextEncoder().encode("other"))).rejects.toThrow("checksum");
    expect(bucket.objects.has(object.key)).toBe(false);
  });

  test("C8: an object created by another writer between the head and the put is reported as existing", async () => {
    const bucket = new CountingR2Bucket();
    const body = new TextEncoder().encode("detail");
    const object = await poolObject(body);
    const head = bucket.head.bind(bucket);
    bucket.head = async (key) => {
      const result = await head(key);
      bucket.objects.set(key, body);
      return result;
    };
    const destination = new R2PublicationDestination(bucket.asBucket(), async () => undefined);

    expect(await destination.putVerifiedImmutableIfAbsent(object, body)).toBe("exists");
    // The put whose precondition failed is still billed as a Class A operation.
    expect(destination.operationCounts()).toEqual({ classA: 1, classB: 1 });
  });

  test("C8: a transient head failure is retried, and each attempt is counted", async () => {
    const bucket = new CountingR2Bucket();
    const body = new TextEncoder().encode("detail");
    const object = await poolObject(body);
    bucket.objects.set(object.key, body);
    bucket.failures.push({ op: "head", message: "head: internal error (10001)" });
    const delays: number[] = [];
    const destination = new R2PublicationDestination(bucket.asBucket(), async (ms) => { delays.push(ms); });

    expect(await destination.putVerifiedImmutableIfAbsent(object, body)).toBe("exists");
    expect(bucket.count("head")).toBe(2);
    expect(delays).toEqual([250]);
    expect(destination.operationCounts()).toEqual({ classA: 0, classB: 2 });

    bucket.failures.push(...[1, 2, 3].map(() => ({ op: "head" as const, message: "head: internal error (10001)" })));
    await expect(destination.putVerifiedImmutableIfAbsent(object, body)).rejects.toThrow("10001");
    expect(bucket.count("put")).toBe(0);
  });

  test("C9: pointer and evidence requests are counted by class; unchanged evidence is not rewritten", async () => {
    const bucket = new CountingR2Bucket();
    const destination = new R2PublicationDestination(bucket.asBucket(), async () => undefined);
    const body = new Uint8Array([1]);

    await destination.putCurrent("public/v2/current.json", body);
    expect(destination.operationCounts()).toEqual({ classA: 1, classB: 0 });
    await destination.putEvidence("publication-sets/v1/a.json", body);
    expect(destination.operationCounts()).toEqual({ classA: 2, classB: 1 });
    await destination.putEvidence("publication-sets/v1/a.json", body);
    expect(destination.operationCounts()).toEqual({ classA: 2, classB: 2 });
    await destination.get("public/v2/current.json");
    await destination.putImmutableIfAbsent("public/v2/current.json", body);
    expect(destination.operationCounts()).toEqual({ classA: 2, classB: 4 });
    expect({ classA: bucket.classA, classB: bucket.classB }).toEqual(destination.operationCounts());
  });
});

async function poolObject(body: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body.slice().buffer as ArrayBuffer));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { key: `public/v2/objects/details/${hex}.json`, sha256: `sha256:${hex}`, byteLength: body.byteLength } as const;
}
