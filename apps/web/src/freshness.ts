export interface FeedFreshness {
  readonly labelKey: "freshness.justNow" | "freshness.minutes" | "freshness.hours";
  readonly value: number;
  readonly stale: boolean;
}

/** Spec 010: age of `metadata.manifest.generatedAt` relative to the browser clock. */
export function feedFreshness(_generatedAt: unknown, _now: number): FeedFreshness | undefined {
  return undefined;
}

/** The topbar text for a freshness; stale data names the out-of-date warning instead. */
export function freshnessText(
  freshness: FeedFreshness,
  t: (key: string, variables?: Readonly<Record<string, string | number>>) => string,
): string {
  return t(freshness.stale ? "freshness.stale" : freshness.labelKey, { n: freshness.value });
}
