/**
 * Spec 014 D99: the translation status guard. A zh-Hant translation must keep the status word of
 * every English parenthetical ("(KAFKA-1, closed)" → 已關閉) and must not add a status the
 * English parentheses do not carry. A translation that fails is not used: the item keeps its
 * English text, labeled "Not translated" (Behavior 25), and is not cached.
 */
import { TRANSLATION_STATUS } from "./prompts";
import { parentheticalWords } from "./validate";

export interface StatusDrift {
  /** The English status whose zh-Hant word is missing, or null when zh-Hant adds a status. */
  readonly status: string | null;
  /** The zh-Hant status word found in the translation's parentheses, if any. */
  readonly found: string | null;
}

function zhStatusWords(zh: string): { status: string; word: string }[] {
  return parentheticalWords(zh).flatMap((token) => Object.entries(TRANSLATION_STATUS)
    .flatMap(([status, words]) => words.filter((word) => token.includes(word)).slice(0, 1).map((word) => ({ status, word }))));
}

/** `null` when the zh-Hant text keeps the English statuses; otherwise the first drift. */
export function translationStatusDrift(english: string, zh: string): StatusDrift | null {
  const statuses = parentheticalWords(english).filter((word) => Object.hasOwn(TRANSLATION_STATUS, word));
  const found = zhStatusWords(zh);
  for (const status of statuses) {
    if (!TRANSLATION_STATUS[status]!.some((word) => zh.includes(word))) return { status, found: found[0]?.word ?? null };
  }
  const extra = found.find((item) => !statuses.includes(item.status));
  return extra === undefined ? null : { status: null, found: extra.word };
}
