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

export function styleOf(texts: readonly string[]): { readonly sentences: number; readonly personLed: number } {
  return { sentences: texts.length, personLed: texts.filter(personLed).length };
}
