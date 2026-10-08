/**
 * Spec 014 Behavior 25: protected spans for translation. Spans are replaced by placeholders
 * ⟦n⟧ in a fixed order before translation, and the translation is accepted only when every
 * placeholder survives exactly once and nothing protected-looking was added.
 */

/** Classes 1–6 in match order; names (class 7) are literal and come last. */
export const PROTECTED_PATTERNS: readonly RegExp[] = [
  /`[^`\n]+`/gu,
  /https?:\/\/[^\s)>\]]+/gu,
  /\+1 \((?:non-)?binding\)/gu,
  /\+1(?![0-9])/gu,
  /\b(?:KIP|KAFKA|FLIP)-\d+\b|#\d+\b/gu,
  /\bRC\d+\b|\bRC\b/gu,
  /\b\d+\.\d+(?:\.\d+)?\b/gu,
];

export interface Protected {
  readonly masked: string;
  readonly spans: readonly string[];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function protect(text: string, names: readonly string[]): Protected {
  const spans: string[] = [];
  let masked = text;
  const nameRules = [...new Set(names)].filter((name) => name.length > 0)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .map((name) => new RegExp(`(?<![\\p{L}\\p{N}_-])${escape(name)}(?![\\p{L}\\p{N}_-])`, "gu"));
  for (const pattern of [...PROTECTED_PATTERNS, ...nameRules]) {
    masked = masked.replace(pattern, (match) => {
      spans.push(match);
      return `⟦${spans.length - 1}⟧`;
    });
  }
  return { masked, spans };
}

/** Restores placeholders; `null` when a placeholder is lost or repeated, or a protected span was added. */
export function restore(translated: string, spans: readonly string[]): string | null {
  for (let index = 0; index < spans.length; index += 1) {
    if (translated.split(`⟦${index}⟧`).length !== 2) return null;
  }
  // Only canonical, in-range placeholders: `⟦03⟧` or `⟦7⟧` (of 2) would restore a span twice or as undefined.
  for (const match of translated.matchAll(/⟦(\d+)⟧/gu)) {
    if (match[1] !== String(Number(match[1])) || Number(match[1]) >= spans.length) return null;
  }
  const restored = translated.replace(/⟦(\d+)⟧/gu, (_, n: string) => spans[Number(n)]!);
  const allowed = new Map<string, number>();
  for (const span of spans) allowed.set(span, (allowed.get(span) ?? 0) + 1);
  const found = new Map<string, number>();
  let rest = restored;
  for (const pattern of PROTECTED_PATTERNS) {
    rest = rest.replace(pattern, (match) => {
      found.set(match, (found.get(match) ?? 0) + 1);
      return " ";
    });
  }
  for (const [match, count] of found) if (count > (allowed.get(match) ?? 0)) return null;
  return restored;
}
