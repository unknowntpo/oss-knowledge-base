/** B32: the diagnosis output schema and the deterministic evidence check (step 6 of B26). */
import { z } from "zod";
import type { EvidenceItem } from "./bundle";

export const diagnosisOutputSchema = z.object({
  verdict: z.enum(["explained", "unexplained", "inconclusive"]),
  cause: z.string().describe("A cause id from a firing rule's playbook, or \"unknown\""),
  confidence: z.enum(["low", "medium", "high"]),
  evidence: z.array(z.object({
    id: z.string().describe("The id of a bundle item, E1…En"),
    quote: z.string().describe("One field of that item, as \"key\": value copied verbatim (or a plain substring of a non-JSON item); never a whole object or row, no braces, no ellipsis"),
  })),
  runbook: z.string().nullable().describe("A runbook anchor the playbook lists, as <file>.md#<anchor>"),
  ownerAction: z.string().nullable().describe("Text for the owner; no tool can perform it"),
});

export type DiagnosisOutput = z.infer<typeof diagnosisOutputSchema>;

export interface EvidenceCheck {
  readonly ok: boolean;
  readonly failures: string[];
}

/**
 * Whitespace is insignificant (owner decision 2026-10-25): every run collapses to one space, and a space beside JSON
 * punctuation `:` `,` `{` `}` `[` `]` is dropped, so a one-line quote matches a pretty-printed item and its compact JSON.
 */
const normalize = (text: string) => text.replace(/\s+/gu, " ").replace(/ ?([:,{}[\]]) ?/gu, "$1").trim();

const WORD = /[\p{L}\p{N}]/u;

/** `needle` occurs in `hay` at a position that neither starts nor ends inside a token (letters and digits). */
function occursWhole(hay: string, needle: string): boolean {
  const startsWord = WORD.test(needle[0]!);
  const endsWord = WORD.test(needle[needle.length - 1]!);
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const before = at > 0 ? hay[at - 1]! : "";
    const after = hay[at + needle.length] ?? "";
    if (startsWord && before !== "" && WORD.test(before)) continue;
    if (endsWord && after !== "" && WORD.test(after)) continue;
    return true;
  }
  return false;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Deep equality of JSON values; object keys in any order. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same((a as JsonObject)[key], (b as JsonObject)[key]));
}

/** Every object in a JSON value, at any depth, array elements included. */
function* objectsIn(value: unknown): Generator<JsonObject> {
  if (typeof value !== "object" || value === null) return;
  if (!Array.isArray(value)) yield value as JsonObject;
  for (const child of Object.values(value)) yield* objectsIn(child);
}

/**
 * The pairs of a quote written as JSON: `"key": value` pairs, or one `{...}` object. Null unless it parses and is
 * written as its own serialization (whitespace aside), so a duplicate key cannot hide an invented value.
 */
function quotedPairs(quote: string): JsonObject | null {
  const trimmed = quote.trim();
  const source = trimmed.startsWith("{") ? trimmed : `{${trimmed}}`;
  const value = parseJson(source);
  return isObject(value) && normalize(JSON.stringify(value)) === normalize(source) ? value : null;
}

/**
 * Owner decision 2026-10-26: a JSON-pair quote passes when one object of the cited JSON item, at any depth, holds every
 * quoted key with an equal value (any order, a subset of its keys).
 */
function pairsIn(quote: string, text: string): boolean {
  const pairs = quotedPairs(quote);
  if (pairs === null) return false;
  const wanted = Object.entries(pairs);
  for (const node of objectsIn(parseJson(text))) {
    if (wanted.every(([key, value]) => Object.hasOwn(node, key) && same(node[key], value))) return true;
  }
  return false;
}

/**
 * The quote holds a letter or digit, and either its JSON pairs are in one object of the item (`pairsIn`) or it occurs
 * in the item's text once both are normalized, neither starting nor ending inside a token of the item (verifier
 * F-precision, 2026-10-25).
 */
function quotedIn(quote: string, text: string): boolean {
  const wanted = normalize(quote);
  return WORD.test(wanted) && (pairsIn(quote, text) || occursWhole(normalize(text), wanted));
}

/**
 * Each quote occurs in the item it cites, letters, digits and punctuation verbatim and in order, whitespace
 * insignificant (`normalize`; owner decisions 2026-10-25), or as JSON pairs of one object of it (`pairsIn`; owner
 * decision 2026-10-26); the cause is a playbook
 * cause id or `unknown`; the runbook is an anchor the playbook lists. Code only, no model.
 */
export function checkEvidence(
  output: DiagnosisOutput,
  bundle: { readonly items: readonly EvidenceItem[]; readonly causes: ReadonlySet<string>; readonly runbooks: ReadonlySet<string> },
): EvidenceCheck {
  const failures: string[] = [];
  for (const { id, quote } of output.evidence) {
    const item = bundle.items.find((value) => value.id === id);
    if (item === undefined) failures.push(`unknown-evidence-id:${id}`);
    else if (!quotedIn(quote, item.text)) failures.push(`quote-not-in-item:${id}`);
  }
  if (!bundle.causes.has(output.cause)) failures.push(`cause-not-in-playbook:${output.cause}`);
  if (output.runbook !== null && !bundle.runbooks.has(output.runbook)) failures.push(`runbook-not-in-playbook:${output.runbook}`);
  return { ok: failures.length === 0, failures };
}
