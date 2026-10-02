/**
 * Returns the UTF-8 bytes of `JSON.stringify(value)` without building that string.
 *
 * A large projection object (a Search shard or the Feed index) is mostly two-byte text, so its
 * JSON string costs about twice its encoded size. Arrays and the top two object levels are
 * written member by member; each smaller member goes through JSON.stringify itself, so the
 * bytes are exactly those of the whole-string encoding (Spec 009).
 */
export function encodeJson(value: unknown): Uint8Array {
  let byteLength = 0;
  writeJson(value, 0, (piece) => {
    byteLength += utf8Length(piece);
  });
  const bytes = new Uint8Array(byteLength);
  const encoder = new TextEncoder();
  let offset = 0;
  writeJson(value, 0, (piece) => {
    offset += encoder.encodeInto(piece, bytes.subarray(offset)).written;
  });
  if (offset !== byteLength) throw new Error("JSON encoding changed between passes");
  return bytes;
}

const NESTED_OBJECT_DEPTH = 1;

function writeJson(value: unknown, depth: number, emit: (piece: string) => void): void {
  if (Array.isArray(value)) {
    emit("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) emit(",");
      const item = value[index];
      // JSON.stringify writes null for array members it cannot represent.
      if (isOmitted(item)) emit("null");
      else writeJson(item, depth + 1, emit);
    }
    emit("]");
    return;
  }
  if (depth <= NESTED_OBJECT_DEPTH && isPlainRecord(value)) {
    emit("{");
    let first = true;
    for (const key of Object.keys(value)) {
      const member = value[key];
      if (isOmitted(member)) continue;
      emit(`${first ? "" : ","}${JSON.stringify(key)}:`);
      writeJson(member, depth + 1, emit);
      first = false;
    }
    emit("}");
    return;
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error(`JSON cannot encode ${typeof value}`);
  emit(json);
}

function isOmitted(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

/** An object JSON.stringify serializes by its own enumerable keys, without toJSON or unboxing. */
function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object") return false;
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return false;
  return !(value instanceof Number || value instanceof String || value instanceof Boolean);
}

function utf8Length(value: string): number {
  let length = value.length;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) continue;
    if (code < 0x800) {
      length += 1;
    } else if (code >= 0xd800 && code < 0xdc00 && index + 1 < value.length &&
        (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      length += 2;
      index += 1;
    } else {
      length += 2;
    }
  }
  return length;
}
