/**
 * Spec 014 D99: the translation status guard. A zh-Hant translation must keep the status word of
 * every English parenthetical ("(KAFKA-1, closed)" → 已關閉) and must not add a status the
 * English parentheses do not carry. zh-Hant status words are matched longest first, left to right,
 * so 投票進行中 is voting, not open's 進行中. A translation that fails is not used: the item keeps
 * its English text, labeled "Not translated" (Behavior 25), and is not cached.
 */
import { STATUS_ALIASES, TRANSLATION_STATUS } from "./prompts";
import type { DigestGlossary } from "./types";
import { parentheticalWords } from "./validate";

export interface StatusDrift {
  /** The English status whose zh-Hant word is missing, or null when zh-Hant adds a status. */
  readonly status: string | null;
  /** The zh-Hant status word found in the translation's parentheses, if any. */
  readonly found: string | null;
  /** D108: the word the translation must carry, when it is not the status's first zh-Hant word. */
  readonly expected?: string;
}

/** D108: "is proposed" (already proposed), which 將提出 turns into "will propose". */
const PROPOSED_NOW = /\b(?:is|are|was|were|been|being)\s+proposed\b/iu;
const ZH_PROPOSED_LATER = /將(?:被)?(?:提出|提議|提案)/u;
const BACKPORT = /\bback-?port/iu;
const ZH_BACKPORT = /back-?port|回移|向後移植|移植回/iu;

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
  if (extra !== undefined) return { status: null, found: extra.word };
  // D108: Dev 2026-10-23 #20 "are proposed" → 將提出 (will propose), and #2 dropped "backported".
  const later = ZH_PROPOSED_LATER.exec(zh);
  if (later !== null && PROPOSED_NOW.test(english)) return { status: "proposed", found: later[0] };
  if (BACKPORT.test(english) && !ZH_BACKPORT.test(zh)) return { status: "backport", found: null, expected: "backport" };
  return null;
}

export interface GlossaryViolation {
  /** The glossary's English term, or the avoided (mainland) zh word. */
  readonly term: string;
  /** The zh-Hant word the translation should carry. */
  readonly expected: string;
}

function englishTerm(term: string): RegExp {
  const words = term.split(/\s+/u).map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[\\s-]+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${words}(?:s|es|ed|ing)?(?![\\p{L}\\p{N}])`, "iu");
}

/**
 * D107: the glossary terms a zh-Hant translation breaks. A term in the English text must appear as its
 * zh-Hant term (case-insensitive, so Broker counts for broker), and no avoided mainland word may appear
 * (a context-limited one only when the English has one of its words).
 * An eval measure only: the run does not reject a translation for it.
 */
export function glossaryViolations(english: string, zh: string, glossary: DigestGlossary): GlossaryViolation[] {
  const lower = zh.toLowerCase();
  const missing = glossary.terms
    .filter(([term, target]) => englishTerm(term).test(english) && !lower.includes(target.toLowerCase()))
    .map(([term, target]) => ({ term, expected: target }));
  const avoided = (glossary.avoid ?? [])
    .filter(([mainland, , when]) => zh.includes(mainland) && (when === undefined || when.some((word) => englishTerm(word).test(english))))
    .map(([mainland, taiwan]) => ({ term: mainland, expected: taiwan }));
  return [...missing, ...avoided];
}
