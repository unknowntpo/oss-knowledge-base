/**
 * Spec 014 D99: the translation status guard. A zh-Hant translation must keep the status word of
 * every English parenthetical ("(KAFKA-1, closed)" → 已關閉) and must not add a status the
 * English parentheses do not carry. zh-Hant status words are matched longest first, left to right,
 * so 投票進行中 is voting, not open's 進行中. A translation that fails is not used: the item keeps
 * its English text, labeled "Not translated" (Behavior 25), and is not cached.
 */
import { STATUS_ALIASES, TRANSLATION_STATUS } from "./prompts";
import { parentheticalWords } from "./validate";

export interface StatusDrift {
  /** The English status whose zh-Hant word is missing, or null when zh-Hant adds a status. */
  readonly status: string | null;
  /** The zh-Hant status word found in the translation's parentheses, if any. */
  readonly found: string | null;
}

const ZH_WORDS = Object.entries(TRANSLATION_STATUS)
  .flatMap(([status, words]) => words.map((word) => ({ status, word })))
  .sort((a, b) => [...b.word].length - [...a.word].length);
const ZH_STATUS = new Map(ZH_WORDS.map((item) => [item.word, item.status]));
const ZH_PATTERN = new RegExp(ZH_WORDS.map((item) => item.word.replace(/[()]/gu, "\\$&")).join("|"), "gu");

/** Every zh-Hant status word in `text`, longest match first, left to right. */
function zhStatusWords(text: string): { status: string; word: string }[] {
  return [...text.matchAll(ZH_PATTERN)].map((match) => ({ status: ZH_STATUS.get(match[0])!, word: match[0] }));
}

/** `null` when the zh-Hant text keeps the English statuses; otherwise the first drift. */
export function translationStatusDrift(english: string, zh: string): StatusDrift | null {
  const statuses = parentheticalWords(english).map((word) => STATUS_ALIASES[word] ?? word)
    .filter((word) => Object.hasOwn(TRANSLATION_STATUS, word));
  const anywhere = new Set(zhStatusWords(zh).map((item) => item.status));
  const found = parentheticalWords(zh).flatMap(zhStatusWords);
  for (const status of statuses) if (!anywhere.has(status)) return { status, found: found[0]?.word ?? null };
  const extra = found.find((item) => !statuses.includes(item.status));
  return extra === undefined ? null : { status: null, found: extra.word };
}
