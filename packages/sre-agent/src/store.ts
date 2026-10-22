/** B33: the only path to storage. Any key outside `internal/sre/v1/<env>/` is refused before the call. */
import type { Env, RawStore } from "./types";

export class WriteScopeError extends Error {
  constructor(readonly key: string) {
    super(`key outside the sre-agent prefix: ${key}`);
    this.name = "WriteScopeError";
  }
}

export const srePrefix = (env: Env) => `internal/sre/v1/${env}/`;
export const sreKey = (env: Env, path: string) => `${srePrefix(env)}${path}`;

function inScope(env: Env, key: string): boolean {
  if (!key.startsWith(srePrefix(env))) return false;
  return key.slice(srePrefix(env).length).split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function scopedStore(env: Env, raw: RawStore): RawStore {
  return {
    async get(key) {
      if (!inScope(env, key)) throw new WriteScopeError(key);
      return raw.get(key);
    },
    async put(key, body) {
      if (!inScope(env, key)) throw new WriteScopeError(key);
      return raw.put(key, body);
    },
  };
}
