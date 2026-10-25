/** B32: the diagnosis output schema and the deterministic evidence check (step 6 of B26). */
import { z } from "zod";
import type { EvidenceItem } from "./bundle";

export const diagnosisOutputSchema = z.object({
  verdict: z.enum(["explained", "unexplained", "inconclusive"]),
  cause: z.string().describe("A cause id from a firing rule's playbook, or \"unknown\""),
  confidence: z.enum(["low", "medium", "high"]),
  evidence: z.array(z.object({
    id: z.string().describe("The id of a bundle item, E1…En"),
    quote: z.string().describe("Text copied verbatim from that item"),
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

/**
 * The quote occurs in the item's text once both are normalized; it must hold a letter or digit, and must not start or
 * end inside a token of the item (verifier F-precision, 2026-10-25).
 */
function quotedIn(quote: string, text: string): boolean {
  const wanted = normalize(quote);
  return WORD.test(wanted) && occursWhole(normalize(text), wanted);
}

/**
 * Each quote occurs in the item it cites, letters, digits and punctuation verbatim and in order, whitespace
 * insignificant (`normalize`; owner decisions 2026-10-25); the cause is a playbook
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
