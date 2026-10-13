/**
 * An in-memory R2 bucket that counts the requests it receives by billing class, the way
 * Cloudflare bills them: every `put` and `list` is Class A, including a conditional put whose
 * precondition fails; every `get` and `head` is Class B.
 */
export class CountingR2Bucket {
  readonly objects = new Map<string, Uint8Array>();
  readonly calls: { readonly op: "get" | "head" | "put"; readonly key: string; readonly options?: R2PutOptions }[] = [];
  /** Throws from the next matching calls; each entry is consumed by one call. */
  readonly failures: { readonly op: "get" | "head" | "put"; readonly message: string }[] = [];
  inFlight = 0;
  maxInFlight = 0;

  get classA(): number { return this.calls.filter((call) => call.op === "put").length; }
  get classB(): number { return this.calls.filter((call) => call.op !== "put").length; }
  count(op: "get" | "head" | "put", prefix = ""): number {
    return this.calls.filter((call) => call.op === op && call.key.startsWith(prefix)).length;
  }
  reset(): void { this.calls.length = 0; this.maxInFlight = 0; }

  asBucket(): R2Bucket { return this as unknown as R2Bucket; }

  async head(key: string): Promise<{ readonly key: string } | null> {
    return this.request("head", key, undefined, () => this.objects.has(key) ? { key } : null);
  }

  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    return this.request("get", key, undefined, () => {
      const body = this.objects.get(key);
      return body === undefined ? null : { arrayBuffer: async () => body.slice().buffer as ArrayBuffer };
    });
  }

  async put(key: string, body: Uint8Array, options: R2PutOptions = {}): Promise<{ readonly key: string } | null> {
    return this.request("put", key, options, async () => {
      if (typeof options.sha256 === "string") {
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body.slice().buffer as ArrayBuffer));
        const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        if (hex !== options.sha256) throw new Error(`put: The SHA-256 checksum you specified did not match what we received (${key})`);
      }
      const ifNoneMatch = options.onlyIf instanceof Headers ? options.onlyIf.get("if-none-match") : null;
      if (ifNoneMatch === "*" && this.objects.has(key)) return null;
      this.objects.set(key, body);
      return { key };
    });
  }

  private async request<T>(op: "get" | "head" | "put", key: string, options: R2PutOptions | undefined, run: () => T | Promise<T>): Promise<T> {
    this.calls.push({ op, key, ...(options === undefined ? {} : { options }) });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await Promise.resolve();
      const failure = this.failures.findIndex((item) => item.op === op);
      if (failure >= 0) throw new Error(this.failures.splice(failure, 1)[0]!.message);
      return await run();
    } finally {
      this.inFlight -= 1;
    }
  }
}
