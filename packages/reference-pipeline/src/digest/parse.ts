/**
 * Spec 014 Behavior 16 (slice 2d): tolerant parsing of model text. Strips a Markdown code fence and
 * parses the first complete JSON object or array; prose around it is ignored. Text with no
 * complete JSON value (e.g. cut at max_tokens) gives `undefined`. Callers still validate the schema.
 */
export function parseModelJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/iu.exec(text);
  const body = fenced === null ? text : fenced[1]!;
  for (let start = 0; start < body.length; start += 1) {
    const open = body[start];
    if (open !== "{" && open !== "[") continue;
    const end = matchingEnd(body, start);
    if (end === -1) return undefined;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      // Not JSON at this bracket (e.g. "[DISCUSS]" in prose); keep scanning.
    }
  }
  return undefined;
}

/** Index of the bracket closing the one at `start`, respecting strings; -1 when unbalanced. */
function matchingEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return index;
    }
  }
  return -1;
}
