export interface FeedFreshness {
  readonly labelKey: "freshness.justNow" | "freshness.minutes" | "freshness.hours";
  readonly value: number;
  readonly stale: boolean;
}

/** Spec 010: age of `metadata.manifest.generatedAt` relative to the browser clock. */
export function feedFreshness(_generatedAt: unknown, _now: number): FeedFreshness | undefined {
  return undefined;
}
