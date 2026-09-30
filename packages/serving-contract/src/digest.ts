export type Sha256Digest = `sha256:${string}`;

export async function sha256Digest(body: Uint8Array | string): Promise<Sha256Digest> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

/**
 * Key of a content-addressed detail object (ADR-0013). The name is the digest of the
 * exact bytes, so an existing key never needs to be read back to know what it holds.
 */
export function detailPoolKey(pool: string, digest: Sha256Digest): string {
  if (!isSha256Digest(digest)) throw new Error("Detail digest must be a SHA-256 digest");
  return `${pool}${digest.slice("sha256:".length)}.json`;
}

/** Returns the digest a pool key names, or undefined when the key is not exactly `<pool><hex>.json`. */
export function digestOfPoolKey(pool: string, key: string): Sha256Digest | undefined {
  if (!key.startsWith(pool)) return undefined;
  const match = /^([0-9a-f]{64})\.json$/u.exec(key.slice(pool.length));
  return match === null ? undefined : `sha256:${match[1]}`;
}
