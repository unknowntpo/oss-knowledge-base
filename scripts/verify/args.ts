// Pure parts of the verification CLI (docs/feature-map.md, docs/process/workflow.md).
// Kept free of I/O so the parsing, clock and summary rules are unit-tested.

export type Target = "local" | "dev";

export const targets: Readonly<Record<Target, { readonly pages: string; readonly publisher?: string }>> = {
  // `bun run e2e:prepare && bun run e2e:server` (fixture data, wrangler pages dev).
  local: { pages: "http://127.0.0.1:8788" },
  dev: {
    pages: "https://oss-knowledge-base-dev.pages.dev",
    publisher: "https://oss-knowledge-base-data-dev.unknowntpo.workers.dev",
  },
};

export const views = ["feed", "feed-detail", "search", "search-detail"] as const;
export type View = (typeof views)[number];

/** Elements whose state every capture records; extend with --selector. */
export const defaultSelectors = [
  ".topbar",
  ".brand",
  ".demo-pill",
  ".locale-control",
  "#q",
  ".card",
  ".search-card",
  ".topic-wrap",
  ".load-error",
] as const;

export interface UiOptions {
  readonly target: Target;
  /** Hash route opened first, e.g. "/" or "/feed/<id>". */
  readonly route: string;
  readonly views: readonly View[];
  readonly query: string;
  readonly width: number;
  readonly height: number;
  readonly locale: "en" | "zh-Hant";
  /** "now" (real clock), an ISO time, or an offset from the feed's generatedAt such as "+3h1s". */
  readonly at: string;
  /** Freeze the clock instead of letting it run from `at`. */
  readonly frozen: boolean;
  readonly selectors: readonly string[];
  readonly out: string;
}

export interface HealthOptions {
  readonly target: Target;
}

export class UsageError extends Error {}

type Flags = Map<string, string[]>;

function readFlags(argv: readonly string[], booleans: ReadonlySet<string>): Flags {
  const flags: Flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    if (raw === "--") continue;
    if (!raw.startsWith("--")) throw new UsageError(`unexpected argument: ${raw}`);
    const equals = raw.indexOf("=");
    const name = equals === -1 ? raw.slice(2) : raw.slice(2, equals);
    let value: string;
    if (equals !== -1) value = raw.slice(equals + 1);
    else if (booleans.has(name)) value = "true";
    else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      value = next;
      index += 1;
    }
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return flags;
}

function only(flags: Flags, allowed: readonly string[]): void {
  for (const name of flags.keys()) {
    if (!allowed.includes(name)) throw new UsageError(`unknown option: --${name}`);
  }
}

function last(flags: Flags, name: string): string | undefined {
  return flags.get(name)?.at(-1);
}

function parseTarget(value: string | undefined): Target {
  const target = value ?? "local";
  if (target !== "local" && target !== "dev") throw new UsageError(`--target must be local or dev, got ${target}`);
  return target;
}

function parsePositiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new UsageError(`--${name} must be a positive integer, got ${value}`);
  return number;
}

export function parseUiArgs(argv: readonly string[], now = new Date()): UiOptions {
  const flags = readFlags(argv, new Set(["frozen"]));
  only(flags, ["target", "route", "view", "query", "width", "height", "locale", "at", "frozen", "selector", "out"]);
  const locale = last(flags, "locale") ?? "en";
  if (locale !== "en" && locale !== "zh-Hant") throw new UsageError(`--locale must be en or zh-Hant, got ${locale}`);
  const route = last(flags, "route") ?? "/";
  if (!route.startsWith("/")) throw new UsageError(`--route must start with /, got ${route}`);
  const requested = (flags.get("view") ?? ["feed"]).flatMap((value) => value.split(","));
  for (const view of requested) {
    if (!(views as readonly string[]).includes(view)) throw new UsageError(`--view must be one of ${views.join(", ")}, got ${view}`);
  }
  const at = last(flags, "at") ?? "now";
  parseAt(at); // validate early
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  return {
    target: parseTarget(last(flags, "target")),
    route,
    views: requested as View[],
    query: last(flags, "query") ?? "KIP-405",
    width: parsePositiveInt("width", last(flags, "width"), 375),
    height: parsePositiveInt("height", last(flags, "height"), 800),
    locale,
    at,
    frozen: last(flags, "frozen") === "true",
    selectors: [...defaultSelectors, ...(flags.get("selector") ?? [])],
    out: last(flags, "out") ?? `test-results/verify/${stamp}`,
  };
}

export function parseHealthArgs(argv: readonly string[]): HealthOptions {
  const flags = readFlags(argv, new Set());
  only(flags, ["target"]);
  return { target: parseTarget(last(flags, "target")) };
}

export type ClockSpec =
  | { readonly kind: "now" }
  | { readonly kind: "absolute"; readonly time: number }
  | { readonly kind: "relative"; readonly offsetMs: number };

const unitMs: Readonly<Record<string, number>> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };

/** Parses "now", an ISO time, or a signed offset such as "+3h23m", "-30s", "+1h". */
export function parseAt(value: string): ClockSpec {
  if (value === "now") return { kind: "now" };
  const relative = /^([+-])((?:\d+(?:ms|d|h|m|s))+)$/u.exec(value);
  if (relative) {
    let offsetMs = 0;
    for (const [, amount, unit] of relative[2]!.matchAll(/(\d+)(ms|d|h|m|s)/gu)) {
      offsetMs += Number(amount) * unitMs[unit!]!;
    }
    return { kind: "relative", offsetMs: relative[1] === "-" ? -offsetMs : offsetMs };
  }
  // Only full ISO times with a zone, so a local-time misreading is impossible.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    const time = Date.parse(value);
    if (!Number.isNaN(time)) return { kind: "absolute", time };
  }
  throw new UsageError(`--at must be now, an ISO time with zone, or an offset like +3h1s, got ${value}`);
}

/** The browser clock to install, or undefined for the real clock. */
export function resolveAt(spec: ClockSpec, generatedAt: string | undefined): number | undefined {
  if (spec.kind === "now") return undefined;
  if (spec.kind === "absolute") return spec.time;
  const base = generatedAt === undefined ? Number.NaN : Date.parse(generatedAt);
  if (Number.isNaN(base)) throw new UsageError(`a relative --at needs a parsable feed generatedAt, got ${String(generatedAt)}`);
  return base + spec.offsetMs;
}

export interface ElementState {
  readonly selector: string;
  readonly count: number;
  readonly visible: boolean;
  readonly className?: string;
  readonly text?: string;
  readonly box?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** scrollWidth > clientWidth: content wider than the element. */
  readonly overflowX?: boolean;
}

export interface Capture {
  readonly view: View;
  readonly url: string;
  readonly screenshot: string;
  readonly htmlLang: string;
  /** document scrollWidth > viewport width: the page scrolls sideways. */
  readonly pageOverflowX: boolean;
  readonly elements: readonly ElementState[];
}

export interface UiSummary {
  readonly target: Target;
  readonly baseUrl: string;
  readonly width: number;
  readonly height: number;
  readonly locale: string;
  readonly generatedAt?: string;
  readonly clock: string;
  readonly frozen: boolean;
  readonly captures: readonly Capture[];
}

function short(text: string | undefined, max = 60): string {
  if (text === undefined) return "";
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A compact, line-per-element summary for the terminal; the JSON file holds everything. */
export function formatUiSummary(summary: UiSummary): string {
  const lines = [
    `${summary.target} ${summary.baseUrl} ${summary.width}x${summary.height} ${summary.locale}` +
      ` clock=${summary.clock}${summary.frozen ? " (frozen)" : ""} generatedAt=${summary.generatedAt ?? "?"}`,
  ];
  for (const capture of summary.captures) {
    lines.push(`[${capture.view}] ${short(capture.url, 100)} lang=${capture.htmlLang} pageOverflowX=${capture.pageOverflowX}`);
    for (const element of capture.elements) {
      if (element.count === 0) continue;
      const box = element.box
        ? ` box=${Math.round(element.box.x)},${Math.round(element.box.y)},${Math.round(element.box.width)}x${Math.round(element.box.height)}`
        : "";
      const flags = [element.visible ? "visible" : "hidden", element.overflowX ? "overflowX" : ""].filter(Boolean).join(",");
      const text = element.text ? ` "${short(element.text)}"` : "";
      lines.push(`  ${element.selector} x${element.count} ${flags} class="${element.className ?? ""}"${box}${text}`);
    }
  }
  return lines.join("\n");
}

export interface HealthReport {
  readonly target: Target;
  readonly now: string;
  readonly publisher?: {
    readonly url: string;
    readonly running?: boolean;
    readonly phase?: unknown;
    readonly lastRunOk?: boolean;
    readonly completedAt?: string;
    readonly feedReleaseId?: string;
  };
  readonly feed: { readonly url: string; readonly generatedAt?: string; readonly releaseId?: string; readonly stale?: boolean };
}

export interface HealthVerdict {
  readonly consistent: boolean | undefined;
  readonly ageMinutes: number | undefined;
  readonly staleInUi: boolean | undefined;
}

/** Same release on both sides, and the page's 3 h stale rule (apps/web/src/freshness.ts). */
export function judgeHealth(report: HealthReport, staleAfterMs: number): HealthVerdict {
  const generated = report.feed.generatedAt ? Date.parse(report.feed.generatedAt) : Number.NaN;
  const age = Number.isNaN(generated) ? undefined : Math.max(0, Date.parse(report.now) - generated);
  const consistent = report.publisher
    ? report.publisher.completedAt === report.feed.generatedAt && report.publisher.feedReleaseId === report.feed.releaseId
    : undefined;
  return {
    consistent,
    ageMinutes: age === undefined ? undefined : Math.floor(age / 60_000),
    staleInUi: age === undefined ? undefined : age > staleAfterMs || report.feed.stale === true,
  };
}

export function formatHealth(report: HealthReport, verdict: HealthVerdict): string {
  const lines = [`${report.target} now=${report.now}`];
  if (report.publisher) {
    const p = report.publisher;
    lines.push(
      `publisher ${p.url}/health running=${String(p.running)} phase=${String(p.phase)} lastRun.ok=${String(p.lastRunOk)}` +
        ` completedAt=${p.completedAt ?? "?"} feedReleaseId=${p.feedReleaseId ?? "?"}`,
    );
  } else lines.push("publisher (none for this target)");
  lines.push(
    `feed ${report.feed.url}/api/feed generatedAt=${report.feed.generatedAt ?? "?"} releaseId=${report.feed.releaseId ?? "?"}` +
      ` metadata.stale=${String(report.feed.stale ?? false)}`,
  );
  lines.push(
    `consistent=${verdict.consistent === undefined ? "n/a" : String(verdict.consistent)}` +
      ` age=${verdict.ageMinutes === undefined ? "?" : `${verdict.ageMinutes}m`}` +
      ` staleInUi=${verdict.staleInUi === undefined ? "?" : String(verdict.staleInUi)}`,
  );
  return lines.join("\n");
}
