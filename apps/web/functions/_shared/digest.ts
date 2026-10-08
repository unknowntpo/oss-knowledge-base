/**
 * Spec 014 Behavior 13 and 29: read the current weekly digest for one project and locale.
 * Only known projects are accepted (the project id builds an R2 key); a known project without a
 * digest is a 404, an unknown project or locale a 400, any other failure a 503.
 */
import {
  DATAFUSION_DIGEST_PROFILE, KAFKA_DIGEST_PROFILE, type DigestV1,
} from "@oss-knowledge-base/reference-pipeline/digest";

export const DIGEST_ROOT = "public/digest/v1/";
export const DIGEST_LOCALES = ["en", "zh-Hant"] as const;
export type DigestLocale = (typeof DIGEST_LOCALES)[number];

/** Projects the web knows; `digest: false` has no weekly digest yet (Spec 014 v1). */
export const DIGEST_PROJECTS: Readonly<Record<string, { readonly digest: boolean }>> = Object.fromEntries(
  [KAFKA_DIGEST_PROFILE, DATAFUSION_DIGEST_PROFILE].map((profile) => [profile.projectId, { digest: profile.digest }]),
);

export type DigestRead =
  | { readonly status: 200; readonly body: Omit<DigestV1, "features" | "translations"> & { readonly localeFallback: boolean } }
  | { readonly status: 400 | 404 | 503; readonly body: { readonly error: string } };

interface Bucket {
  get(key: string): Promise<{ json<T>(): Promise<T> } | null>;
}

async function json<T>(bucket: Bucket, key: string): Promise<T | undefined> {
  const object = await bucket.get(key);
  return object === null ? undefined : object.json<T>();
}

export async function readDigest(bucket: Bucket, projectId: string | null, localeParam: string | null): Promise<DigestRead> {
  if (projectId === null || !Object.hasOwn(DIGEST_PROJECTS, projectId)) return { status: 400, body: { error: "Unknown project" } };
  const locale = localeParam ?? "en";
  if (!(DIGEST_LOCALES as readonly string[]).includes(locale)) return { status: 400, body: { error: "Unsupported locale" } };
  if (!DIGEST_PROJECTS[projectId]!.digest) return { status: 404, body: { error: "No weekly digest for this project" } };
  try {
    const prefix = `${DIGEST_ROOT}${projectId}/`;
    const pointer = await json<{ objectKeys?: Partial<Record<DigestLocale, string>> }>(bucket, `${prefix}current.json`);
    if (pointer === undefined) return { status: 404, body: { error: "No weekly digest published yet" } };
    const keys = pointer.objectKeys ?? {};
    const wanted = keys[locale as DigestLocale];
    const key = wanted ?? keys.en;
    // The pointer is data from R2; a key outside this project's prefix is never read.
    if (key === undefined || !key.startsWith(prefix) || key.includes("..")) throw new Error("Digest pointer is invalid");
    const digest = await json<DigestV1>(bucket, key);
    if (digest?.schema !== "osskb.digest.v1") throw new Error("Digest object is missing");
    const { features: _features, translations: _translations, ...visible } = digest;
    return { status: 200, body: { ...visible, localeFallback: wanted === undefined && locale !== "en" } };
  } catch (error) {
    return { status: 503, body: { error: error instanceof Error ? error.message : "Unable to read the digest" } };
  }
}
