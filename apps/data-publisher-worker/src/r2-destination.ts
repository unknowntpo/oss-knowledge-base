import type { ImmutableProjectionObjectV1 } from "@oss-knowledge-base/serving-contract";
import type { PublicationDestination, R2OperationCounts } from "./pipeline";

/**
 * R2 bills by request class. Class A: every `put` (and `list`), including a conditional put whose
 * precondition fails. Class B: `get` and `head`, about a twelfth of the price with ten times the
 * included volume. So existence is asked with `head`, never with a put that is expected to fail.
 */
export class R2PublicationDestination implements PublicationDestination {
  private classA = 0;
  private classB = 0;

  constructor(
    private readonly bucket: R2Bucket,
    private readonly delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Requests sent so far, retries included. */
  operationCounts(): R2OperationCounts {
    return { classA: this.classA, classB: this.classB };
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.retry(async () => {
      this.classB += 1;
      const object = await this.bucket.get(key);
      return object === null ? undefined : new Uint8Array(await object.arrayBuffer());
    });
  }

  async putImmutableIfAbsent(key: string, body: Uint8Array): Promise<"created" | "exists"> {
    if (await this.exists(key)) return "exists";
    await this.put(key, body, {
      httpMetadata: { cacheControl: "public, max-age=31536000, immutable" },
    });
    return "created";
  }

  /**
   * An existing key costs one `head` and no write. An absent key is written with one conditional
   * put: R2 rejects bytes that do not match the digest, and a key another writer created since
   * the `head` is left as it is.
   */
  async putVerifiedImmutableIfAbsent(object: ImmutableProjectionObjectV1, body: Uint8Array): Promise<"created" | "exists"> {
    if (await this.exists(object.key)) return "exists";
    const written = await this.put(object.key, body, {
      sha256: object.sha256.replace(/^sha256:/u, ""),
      onlyIf: new Headers({ "if-none-match": "*" }),
      httpMetadata: { cacheControl: "public, max-age=31536000, immutable" },
    });
    return written === null ? "exists" : "created";
  }

  async putCurrent(key: string, body: Uint8Array): Promise<void> {
    await this.put(key, body, {
      httpMetadata: { cacheControl: "public, max-age=30, must-revalidate" },
    });
  }

  async putEvidence(key: string, body: Uint8Array): Promise<void> {
    const existing = await this.get(key);
    if (existing !== undefined) {
      if (!bytesEqual(existing, body)) throw new Error(`Publication evidence conflict: ${key}`);
      return;
    }
    await this.put(key, body, {
      httpMetadata: { cacheControl: "private, max-age=31536000, immutable" },
    });
  }

  private async exists(key: string): Promise<boolean> {
    return await this.retry(() => {
      this.classB += 1;
      return this.bucket.head(key);
    }) !== null;
  }

  private put(key: string, body: Uint8Array, options: R2PutOptions): Promise<R2Object | null> {
    return this.retry(() => {
      this.classA += 1;
      return this.bucket.put(key, body, options);
    });
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
