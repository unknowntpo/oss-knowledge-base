import type { ImmutableProjectionObjectV1 } from "@oss-knowledge-base/serving-contract";
import type { PublicationDestination } from "./pipeline";

export class R2PublicationDestination implements PublicationDestination {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.retry(async () => {
      const object = await this.bucket.get(key);
      return object === null ? undefined : new Uint8Array(await object.arrayBuffer());
    });
  }

  async putImmutableIfAbsent(key: string, body: Uint8Array): Promise<"created" | "exists"> {
    if (await this.retry(() => this.bucket.head(key)) !== null) return "exists";
    await this.retry(() => this.bucket.put(key, body, {
      httpMetadata: { cacheControl: "public, max-age=31536000, immutable" },
    }));
    return "created";
  }

  /** One conditional R2 request per object; R2 rejects bytes that do not match the digest. */
  async putVerifiedImmutableIfAbsent(object: ImmutableProjectionObjectV1, body: Uint8Array): Promise<"created" | "exists"> {
    const written = await this.retry(() => this.bucket.put(object.key, body, {
      sha256: object.sha256.replace(/^sha256:/u, ""),
      onlyIf: new Headers({ "if-none-match": "*" }),
      httpMetadata: { cacheControl: "public, max-age=31536000, immutable" },
    }));
    return written === null ? "exists" : "created";
  }

  async putCurrent(key: string, body: Uint8Array): Promise<void> {
    await this.retry(() => this.bucket.put(key, body, {
      httpMetadata: { cacheControl: "public, max-age=30, must-revalidate" },
    }));
  }

  async putEvidence(key: string, body: Uint8Array): Promise<void> {
    const existing = await this.get(key);
    if (existing !== undefined) {
      if (!bytesEqual(existing, body)) throw new Error(`Publication evidence conflict: ${key}`);
      return;
    }
    await this.retry(() => this.bucket.put(key, body, {
      httpMetadata: { cacheControl: "private, max-age=31536000, immutable" },
    }));
  }

  /** R2 reports transient failures such as internal error 10001; every call here is idempotent. */
  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= 2) throw error;
        await this.delay(250 * (2 ** attempt));
      }
    }
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
