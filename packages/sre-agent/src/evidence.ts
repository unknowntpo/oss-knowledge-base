/** B32: the diagnosis output schema and the deterministic evidence check (step 6 of B26). */
import { z } from "zod";
import type { EvidenceItem } from "./bundle";

/*
 * SRE100 (owner decision 2026-10-27): the rules of each output field in ASD-STE100 style (one term per concept, one
 * instruction per sentence, imperative, at most 20 words a sentence). Each text is both a `SYSTEM_PROMPT` section and
 * the schema description of its field, so the model reads one wording. Terms: an item is one of E1…En in the bundle;
 * a JSON item holds JSON and a text item holds other text; an entry is one element of `evidence`; a cause id is an id
 * in the cause table of the firing rule's playbook.
 */

/** SRE95, SRE100: the cause rule; the order matches the playbooks' "Causes, in order" (first match wins). */
export const CAUSE_DEFINITION = [
  "Use the cause table of the firing rule's playbook.",
  "Check the causes in the table order.",
  "Choose the first cause whose distinguishing evidence (the table column) is in the bundle.",
  "Write its cause id (the table's Cause id column).",
  "If no cause qualifies, write \"unknown\".",
].join(" ");

/** SRE94: what each verdict means, from the cause (owner decision 2026-10-26; STE wording 2026-10-27). */
export const VERDICT_DEFINITION = [
  "Write \"explained\" when cause is a cause id.",
  "Write \"inconclusive\" when cause is \"unknown\" and the bundle lacks the evidence that decides it.",
  "Write \"unexplained\" when cause is \"unknown\" and the cited evidence rules out every cause.",
].join(" ");

/** SRE95: confidence grades the cause and never sets the verdict. */
export const CONFIDENCE_DEFINITION = [
  "Grade the cause as low, medium or high by the playbook's confidence guidance.",
  "Confidence never changes the verdict.",
  "A cause id at low confidence is still \"explained\".",
].join(" ");

/** SRE87, SRE100: one field per entry, cited by exactly one of path and quote. */
export const ENTRY_DEFINITION = "Write one entry per cited field. In each entry, give the item id and exactly one of path or quote.";

/** SRE89: the path syntax, as the prompt and the schema describe it to the model. */
export const PATH_SYNTAX = [
  "For a JSON item, give path.",
  "Write a path as keys joined by dots.",
  "Write an array index as [n].",
  "A SQL item is an array of rows.",
  "Examples: kipPages.lastRun.error, [0].status.",
  "Write a key that holds a dot, bracket, quote or space as [\"the.key\"].",
  "Do not copy JSON text.",
  "The code reads the value at the path.",
].join(" ");

/** SRE89: a quote is an exact substring of a text item. */
export const QUOTE_DEFINITION = "For a text item, give quote. Write a quote as an exact substring of the text item. Do not use \"...\" or \"…\".";

export const RUNBOOK_DEFINITION = "Write one anchor from the playbook, as <file>.md#<anchor>. If none applies, write null.";

/** SRE94: the missing fields of an `inconclusive` diagnosis go here. */
export const OWNER_ACTION_DEFINITION = "Write the next step for the owner. No tool can do it. For \"inconclusive\", name the missing fields.";

/** SRE100: one prompt section per output field, in the schema's order. */
export const OUTPUT_FIELD_RULES = {
  cause: CAUSE_DEFINITION,
  verdict: VERDICT_DEFINITION,
  confidence: CONFIDENCE_DEFINITION,
  evidence: [ENTRY_DEFINITION, PATH_SYNTAX, QUOTE_DEFINITION].join(" "),
  runbook: RUNBOOK_DEFINITION,
  ownerAction: OWNER_ACTION_DEFINITION,
} as const;

/** The model writes the fields in this order: the cause first, since the verdict follows from it (SRE100). */
export const diagnosisOutputSchema = z.object({
  cause: z.string().describe(CAUSE_DEFINITION),
  verdict: z.enum(["explained", "unexplained", "inconclusive"]).describe(VERDICT_DEFINITION),
  confidence: z.enum(["low", "medium", "high"]).describe(CONFIDENCE_DEFINITION),
  // SRE87: exactly one of `path` and `quote`; the evidence check, not the schema, enforces it, so a bad entry
  // makes the verdict `unverified` and the rest of the diagnosis is kept.
  evidence: z.array(z.object({
    id: z.string().describe("The item id, E1…En."),
    path: z.string().nullish().describe(PATH_SYNTAX),
    quote: z.string().nullish().describe(QUOTE_DEFINITION),
  })).describe(ENTRY_DEFINITION),
  runbook: z.string().nullable().describe(RUNBOOK_DEFINITION),
  ownerAction: z.string().nullable().describe(OWNER_ACTION_DEFINITION),
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

type Segment = string | number;

/**
 * SRE85, SRE86: a path as `PATH_SYNTAX` describes it, or null when it is not one. A segment is `.name` (`name`
 * first) for an object key, `[n]` for an array index (`0` or no leading zero), or `["key"]`, a JSON string, for
 * any key. A bare name holds no `.`, `[`, `]`, `"`, `'` or whitespace.
 */
export function parsePath(path: string): Segment[] | null {
  const segments: Segment[] = [];
  let at = 0;
  while (at < path.length) {
    if (path[at] === "[") {
      const index = /^\[(0|[1-9]\d*)\]/u.exec(path.slice(at));
      if (index !== null) {
        segments.push(Number(index[1]));
        at += index[0].length;
        continue;
      }
      const key = /^\["(?:[^"\\]|\\.)*"\]/u.exec(path.slice(at));
      const parsed = key === null ? undefined : parseJson(key[0].slice(1, -1));
      if (typeof parsed !== "string") return null;
      segments.push(parsed);
      at += key![0].length;
      continue;
    }
    if (segments.length > 0) {
      if (path[at] !== ".") return null;
      at += 1;
    }
    const name = /^[^.[\]"'\s]+/u.exec(path.slice(at));
    if (name === null) return null;
    segments.push(name[0]);
    at += name[0].length;
  }
  return segments.length === 0 ? null : segments;
}

/**
 * SRE85, SRE86: the value at `path` in a JSON item and the verbatim field it was read from, `"<key>": <value>`
 * (the value alone when the path ends in an index), the value as compact JSON; null when the item is not JSON,
 * the path is not one, or nothing is there. Own keys only, so `constructor` or `__proto__` find nothing.
 */
export function resolvePath(text: string, path: string): { readonly value: unknown; readonly quote: string } | null {
  const segments = parsePath(path);
  if (segments === null) return null;
  let node = parseJson(text);
  if (node === undefined) return null;
  for (const segment of segments) {
    if (typeof segment === "number" ? !Array.isArray(node) || segment >= node.length : !isObject(node) || !Object.hasOwn(node, segment)) return null;
    node = typeof segment === "number" ? (node as unknown[])[segment] : (node as JsonObject)[segment];
  }
  const last = segments.at(-1)!;
  const value = JSON.stringify(node);
  return { value: node, quote: typeof last === "number" ? value : `${JSON.stringify(last)}: ${value}` };
}

/** One evidence entry as recorded: `quote` is the model's quote, or the field a path resolved to (null when none). */
export interface CitedEvidence {
  readonly id: string;
  readonly path?: string;
  readonly quote: string | null;
}

type EvidenceEntry = DiagnosisOutput["evidence"][number];

const given = (text: string | null | undefined) => (text === null || text === undefined ? null : text);

/**
 * SRE87: the one field an entry cites, `path` or `quote`, or null when it gives both or neither. An empty string
 * beside the other field is read as absent.
 */
function citation(entry: EvidenceEntry): { readonly path: string } | { readonly quote: string } | null {
  let path = given(entry.path);
  let quote = given(entry.quote);
  if (path !== null && quote !== null) {
    if (quote.trim() === "" && path.trim() !== "") quote = null;
    else if (path.trim() === "" && quote.trim() !== "") path = null;
  }
  if ((path === null) === (quote === null)) return null;
  return path !== null ? { path } : { quote: quote! };
}

/** SRE85: the evidence as the run record and trajectory keep it, each path resolved to its verbatim field. */
export function citeEvidence(evidence: readonly EvidenceEntry[], items: readonly EvidenceItem[]): CitedEvidence[] {
  return evidence.map((entry) => {
    const cited = citation(entry);
    if (cited === null) return { id: entry.id, quote: null };
    if ("quote" in cited) return { id: entry.id, quote: cited.quote };
    const text = items.find((item) => item.id === entry.id)?.text;
    return { id: entry.id, path: cited.path, quote: text === undefined ? null : resolvePath(text, cited.path)?.quote ?? null };
  });
}

/**
 * SRE96, SRE97 (owner decision 2026-10-26): the field at `path` in a JSON item and, when its value is an object or
 * an array, each field directly in it (`"<key>": <value>`, the value alone for an array element); none deeper.
 * Empty when the path does not resolve.
 */
export function citedFields(text: string, path: string): { readonly value: unknown; readonly quote: string }[] {
  const found = resolvePath(text, path);
  if (found === null) return [];
  const parent = found.value;
  if (typeof parent !== "object" || parent === null) return [found];
  const children = Object.entries(parent).map(([key, value]) => ({
    value,
    quote: Array.isArray(parent) ? JSON.stringify(value) : `${JSON.stringify(key)}: ${JSON.stringify(value)}`,
  }));
  return [found, ...children];
}

/**
 * SRE88, SRE96: a path citation in a JSON item names the required `field` (its keys from the root) and reads
 * `wanted`: the path is that field, or the field's parent object whose own key `field.at(-1)` holds `wanted`. A value
 * match under another key or at another path does not count.
 */
export function pathHolds(text: string, path: string, field: readonly string[], wanted: unknown): boolean {
  const segments = parsePath(path);
  if (wanted === undefined || segments === null || field.length === 0) return false;
  const found = resolvePath(text, path);
  if (found === null) return false;
  const at = (keys: readonly string[]) => segments.length === keys.length && keys.every((key, index) => segments[index] === key);
  if (at(field)) return same(found.value, wanted);
  if (!at(field.slice(0, -1)) || !isObject(found.value)) return false;
  const key = field.at(-1)!;
  return Object.hasOwn(found.value, key) && same(found.value[key], wanted);
}

/**
 * Each entry cites one field of the item it names (SRE87): a path that resolves in the item's JSON (SRE85, SRE86;
 * owner decision 2026-10-26), or a quote that occurs in the item, letters, digits and punctuation verbatim and in
 * order, whitespace insignificant (`normalize`; owner decisions 2026-10-25), or as JSON pairs of one object of it
 * (`pairsIn`; owner decision 2026-10-26); the cause is a playbook cause id or `unknown`; the runbook is an anchor
 * the playbook lists. Code only, no model.
 */
export function checkEvidence(
  output: DiagnosisOutput,
  bundle: { readonly items: readonly EvidenceItem[]; readonly causes: ReadonlySet<string>; readonly runbooks: ReadonlySet<string> },
): EvidenceCheck {
  const failures: string[] = [];
  for (const entry of output.evidence) {
    const { id } = entry;
    const item = bundle.items.find((value) => value.id === id);
    const cited = citation(entry);
    if (item === undefined) failures.push(`unknown-evidence-id:${id}`);
    else if (cited === null) failures.push(`evidence-needs-path-or-quote:${id}`);
    else if ("path" in cited) {
      if (resolvePath(item.text, cited.path) === null) failures.push(`path-not-in-item:${id}`);
    } else if (!quotedIn(cited.quote, item.text)) failures.push(`quote-not-in-item:${id}`);
  }
  if (!bundle.causes.has(output.cause)) failures.push(`cause-not-in-playbook:${output.cause}`);
  if (output.runbook !== null && !bundle.runbooks.has(output.runbook)) failures.push(`runbook-not-in-playbook:${output.runbook}`);
  return { ok: failures.length === 0, failures };
}
