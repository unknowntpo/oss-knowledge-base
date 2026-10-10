/**
 * Spec 014 Behavior 9 (slice 2c): the person-led measure. A sentence reads as a transcript when a
 * reporting verb appears within its first 6 words, or it ends with ", said <name>". A measure for
 * dry runs, not a validation rule.
 */
const REPORTING = /^(?:said|asked|proposed|questioned|discussed|suggested|noted|argued|requested|introduced|congratulated)$/iu;

export function personLed(text: string): boolean {
  if (/,\s*said\s+[^,.]+\.?\s*$/iu.test(text)) return true;
  const words = text.trim().split(/\s+/u).slice(0, 6).map((word) => word.replace(/[^\p{L}\p{N}-]/gu, ""));
  return words.some((word) => REPORTING.test(word));
}

export function styleOf(texts: readonly string[]): { readonly sentences: number; readonly personLed: number; readonly contentFree: number } {
  return { sentences: texts.length, personLed: texts.filter(personLed).length, contentFree: texts.filter(contentFree).length };
}

const ID = /^(?:[A-Z][A-Z0-9]*-(?:PR-|ISSUE-|MAIL-)?[0-9a-f]+|#\d+|v?\d+(?:\.\d+)+|RC\d*)$/u;
const FILLER = new Set([
  "merged", "open", "opened", "closed", "resolved", "proposed", "proposes", "released", "pending", "remains", "approved",
  "is", "are", "was", "were", "be", "been", "has", "have", "would", "will",
  "a", "an", "the", "to", "of", "for", "in", "on", "at", "by", "with", "and", "or", "as", "from",
  "apache", "kafka",
]);

/** Slice 2d (Behavior 9): fewer than 3 words left after ids, versions, status words and fillers. */
export function contentFree(text: string): boolean {
  const words = text.split(/[\s,;:()]+/u).map((word) => word.replace(/^[^\p{L}\p{N}#]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
  return words.filter((word) => !ID.test(word) && !FILLER.has(word.toLowerCase())).length < 3;
}
