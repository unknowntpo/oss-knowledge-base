import { createHash } from "node:crypto";

/**
 * Emits canonical JSON in pieces: object keys sorted with localeCompare, undefined members
 * dropped, non-finite numbers rejected. Large values are digested without materializing the
 * whole string or a sorted copy (Spec 009).
 */
function writeCanonical(value: unknown, emit: (piece: string) => void): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    emit(JSON.stringify(value));
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot encode non-finite numbers");
    emit(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    emit("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) emit(",");
      if (index in value) writeCanonical(value[index], emit);
      else emit("null");
    }
    emit("]");
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    // Canonical output has always been a rebuilt object, which lists array-index keys first.
    const ordered = [
      ...entries.filter(([key]) => isArrayIndex(key)).sort(([left], [right]) => Number(left) - Number(right)),
      ...entries.filter(([key]) => !isArrayIndex(key)),
    ];
    emit("{");
    ordered.forEach(([key, child], index) => {
      emit(`${index > 0 ? "," : ""}${JSON.stringify(key)}:`);
      writeCanonical(child, emit);
    });
    emit("}");
    return;
  }
  throw new Error(`Canonical JSON cannot encode ${typeof value}`);
}

function isArrayIndex(key: string): boolean {
  return /^(?:0|[1-9]\d*)$/u.test(key) && Number(key) < 4_294_967_295;
}

export function canonicalJson(value: unknown): string {
  const pieces: string[] = [];
  writeCanonical(value, (piece) => pieces.push(piece));
  return pieces.join("");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalDigest(value: unknown): string {
  const hash = createHash("sha256");
  let pending = "";
  writeCanonical(value, (piece) => {
    pending += piece;
    if (pending.length >= 65_536) {
      hash.update(pending);
      pending = "";
    }
  });
  return `sha256:${hash.update(pending).digest("hex")}`;
}
