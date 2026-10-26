/**
 * Spec 027 SRE81, SRE82: bun has no `cloudflare:workers`. This preload (bunfig.toml) stands in for
 * it with a recording `tracing`: `startActiveSpan` (what `agents/observability/ai` uses) and
 * `enterSpan` (the tick span) record each span's name and attributes, so tests read what the
 * Agents tab would receive. Nothing leaves the process.
 */
import { mock } from "bun:test";

export interface RecordedSpan {
  readonly name: string;
  readonly attributes: Record<string, string | number | boolean>;
  ended: boolean;
}

export const recordedSpans: RecordedSpan[] = [];

function open(name: string) {
  const record: RecordedSpan = { name, attributes: {}, ended: false };
  recordedSpans.push(record);
  const span = {
    isTraced: true,
    setAttribute(key: string, value: string | number | boolean | undefined) {
      if (value !== undefined) record.attributes[key] = value;
      return span;
    },
    end() { record.ended = true; },
  };
  return span;
}

const tracing = {
  startActiveSpan<T>(name: string, run: (span: ReturnType<typeof open>) => T): T {
    return run(open(name));
  },
  enterSpan<T>(name: string, run: (span: ReturnType<typeof open>) => T): T {
    const span = open(name);
    const result = run(span);
    if (result instanceof Promise) return result.finally(() => span.end()) as T;
    span.end();
    return result;
  },
};

mock.module("cloudflare:workers", () => ({ tracing }));
