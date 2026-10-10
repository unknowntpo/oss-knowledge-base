/**
 * Community identifier patterns (Spec 016 Behavior 3). The patterns are data supplied by a
 * community profile; this module holds no community literal such as `KIP-` or `KAFKA-`.
 */

/** One identifier family of one project, for example Kafka's KIP numbers. */
export interface IdentifierPatternV1 {
  /** Stable key within the project, for example `kip`. */
  readonly kind: string;
  /** The canonical form is this prefix followed by the number: `KIP-` gives `KIP-770`. */
  readonly canonicalPrefix: string;
  /**
   * RegExp source matched case-insensitively against titles and queries; group 1 is the number.
   * It decides which spellings count as the identifier, for example `\bKIP-?(\d+)\b`.
   */
  readonly textPattern?: string;
  /** RegExp source matched against a chunk's `recordId`; group 1 is the number. */
  readonly recordIdPattern?: string;
}

/** Identifier patterns keyed by `projectId`. */
export type IdentifierProfilesV1 = Readonly<Record<string, readonly IdentifierPatternV1[]>>;

interface CompiledPattern {
  readonly canonicalPrefix: string;
  readonly text?: RegExp;
  readonly recordId?: RegExp;
}

export interface CompiledIdentifierProfiles {
  /** Rewrites every recognized spelling in a query to its canonical form. */
  readonly canonicalizeQuery: (query: string) => string;
  /** Lower-cased canonical identifiers named by a title or by the record id, in pattern order. */
  readonly identifiersOf: (projectId: string, title: string, recordId: string) => readonly string[];
  /** Lower-cased canonical identifiers a bare number may mean in one project. */
  readonly numberCandidates: (projectId: string, number: string) => readonly string[];
  /** Whether a lower-cased string is the canonical form of some project's identifier. */
  readonly isCanonical: (value: string) => boolean;
}

const compiled = new WeakMap<IdentifierProfilesV1, CompiledIdentifierProfiles>();

export function compileIdentifierProfiles(profiles: IdentifierProfilesV1): CompiledIdentifierProfiles {
  const cached = compiled.get(profiles);
  if (cached !== undefined) return cached;

  const byProject = new Map<string, readonly CompiledPattern[]>();
  for (const [projectId, patterns] of Object.entries(profiles)) {
    byProject.set(projectId, patterns.map((pattern, index) => compilePattern(pattern, `${projectId}[${index}]`)));
  }
  // The same pattern declared by two projects rewrites a query once.
  const queryPatterns = new Map<string, CompiledPattern>();
  for (const patterns of byProject.values()) {
    for (const pattern of patterns) {
      if (pattern.text !== undefined) queryPatterns.set(`${pattern.canonicalPrefix}\n${pattern.text.source}`, pattern);
    }
  }
  const canonicalShapes = [...new Set([...byProject.values()].flat().map((pattern) => pattern.canonicalPrefix.toLowerCase()))];

  const result: CompiledIdentifierProfiles = {
    canonicalizeQuery: (query) => {
      let rewritten = query;
      for (const pattern of queryPatterns.values()) {
        rewritten = rewritten.replace(pattern.text!, (match, number: string | undefined) =>
          isNumber(number) ? `${pattern.canonicalPrefix}${number}` : match);
      }
      return rewritten;
    },
    identifiersOf: (projectId, title, recordId) => {
      const identifiers = new Set<string>();
      for (const pattern of byProject.get(projectId) ?? []) {
        if (pattern.text !== undefined) {
          for (const match of title.matchAll(pattern.text)) {
            if (isNumber(match[1])) identifiers.add(canonical(pattern, match[1]));
          }
        }
        const fromRecord = pattern.recordId?.exec(recordId)?.[1];
        if (isNumber(fromRecord)) identifiers.add(canonical(pattern, fromRecord));
      }
      return [...identifiers];
    },
    numberCandidates: (projectId, number) =>
      (byProject.get(projectId) ?? []).map((pattern) => canonical(pattern, number)),
    isCanonical: (value) =>
      canonicalShapes.some((prefix) => value.startsWith(prefix) && /^\d+$/u.test(value.slice(prefix.length))),
  };
  compiled.set(profiles, result);
  return result;
}

/** A match whose group is absent, empty, or not digits (an optional group) names no identifier. */
function isNumber(value: string | undefined): value is string {
  return value !== undefined && /^\d+$/u.test(value);
}

function canonical(pattern: CompiledPattern, number: string): string {
  return `${pattern.canonicalPrefix}${number}`.toLowerCase();
}

function compilePattern(pattern: IdentifierPatternV1, path: string): CompiledPattern {
  if (pattern.kind.trim().length === 0) throw new Error(`Identifier pattern ${path} needs a kind`);
  if (pattern.canonicalPrefix.trim().length === 0) {
    throw new Error(`Identifier pattern ${path} needs a canonicalPrefix`);
  }
  if (pattern.textPattern === undefined && pattern.recordIdPattern === undefined) {
    throw new Error(`Identifier pattern ${path} needs a textPattern or a recordIdPattern`);
  }
  return {
    canonicalPrefix: pattern.canonicalPrefix,
    ...(pattern.textPattern === undefined ? {} : { text: compile(pattern.textPattern, "giu", `${path}.textPattern`) }),
    ...(pattern.recordIdPattern === undefined
      ? {}
      : { recordId: compile(pattern.recordIdPattern, "u", `${path}.recordIdPattern`) }),
  };
}

/**
 * A quantified group that itself holds a quantifier, such as `(\d+)+`, can backtrack
 * exponentially. Patterns are trusted repository data, so this catches the obvious mistake only.
 */
const NESTED_QUANTIFIER = /\([^()]*[+*}][^()]*\)[+*{]/u;

function compile(source: string, flags: string, path: string): RegExp {
  if (NESTED_QUANTIFIER.test(source)) {
    throw new Error(`Identifier pattern ${path} has a nested quantifier, which can backtrack exponentially`);
  }
  let expression: RegExp;
  try {
    expression = new RegExp(source, flags);
  } catch (error) {
    throw new Error(`Identifier pattern ${path} is not a valid RegExp: ${error instanceof Error ? error.message : error}`);
  }
  // `source|` always matches the empty string, which exposes the number of capture groups.
  const groups = new RegExp(`${source}|`, "u").exec("")!.length - 1;
  if (groups !== 1) throw new Error(`Identifier pattern ${path} must have exactly one capture group for the number`);
  return expression;
}
