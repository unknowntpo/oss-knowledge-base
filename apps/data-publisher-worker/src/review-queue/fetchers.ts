/**
 * Spec 015 slice 2: the review queue's upstream reads. GitHub GraphQL for open PRs (Behavior 1,
 * Q17–Q20, Q33, Q42, Q46) and polite sequential JSON reads from Apache hosts (Pony Mail, the ASF
 * roster; Q48). Responses are counted so `last-run.json` and `measure:review-queue` can report them.
 */
import {
  MAX_RESPONSE_CHARS,
  mergePrPages,
  OPEN_PRS_QUERY,
  parsePrPage,
  SOURCE_USER_AGENT,
  type PrNode,
} from "@oss-knowledge-base/reference-pipeline";

export type SourceFailureKind = "rate-limit" | "auth" | "transport" | "schema" | "too-large";

export class SourceError extends Error {
  constructor(readonly failureKind: SourceFailureKind, message: string) {
    super(message);
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type Delay = (milliseconds: number) => Promise<void>;

export interface Counter {
  requests: number;
  bytes: number;
}

export const newCounter = (): Counter => ({ requests: 0, bytes: 0 });

/** Retry-After in seconds, or undefined when absent or not a number of seconds. */
export function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null || !/^\d+$/u.test(value.trim())) return undefined;
  return Number(value.trim());
}

async function readBody(response: Response, counter: Counter, source: string): Promise<string> {
  const text = await response.text();
  counter.bytes += text.length;
  if (text.length > MAX_RESPONSE_CHARS) throw new SourceError("too-large", `${source} response is ${text.length} chars`);
  return text;
}

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
/** Behavior 1: a snapshot never needs more pages than this; more means the loop is broken. */
const MAX_PAGES = 50;

/** One GraphQL page request with the Q17/Q18/Q42 retry rules. */
async function graphqlPage(
  options: { readonly token: string; readonly fetchImpl: FetchLike; readonly delay: Delay; readonly counter: Counter },
  variables: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      options.counter.requests += 1;
      response = await options.fetchImpl(GITHUB_GRAPHQL_URL, {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
          "User-Agent": SOURCE_USER_AGENT,
        },
        body: JSON.stringify({ query: OPEN_PRS_QUERY, variables }),
      });
    } catch (error) {
      if (attempt === 0) {
        await options.delay(5_000);
        continue;
      }
      throw new SourceError("transport", `GitHub GraphQL: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw new SourceError("auth", "GitHub GraphQL 401");
    }
    if (response.status === 403 || response.status === 429) {
      const wait = retryAfterSeconds(response);
      await response.body?.cancel();
      if (attempt === 0 && wait !== undefined && wait <= 60) {
        await options.delay(wait * 1000);
        continue;
      }
      throw new SourceError("rate-limit", `GitHub GraphQL ${response.status}; Retry-After ${wait ?? "none"}`);
    }
    if (response.status >= 500) {
      await response.body?.cancel();
      if (attempt === 0) {
        await options.delay(5_000);
        continue;
      }
      throw new SourceError("transport", `GitHub GraphQL ${response.status}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceError("transport", `GitHub GraphQL ${response.status}`);
    }
    const text = await readBody(response, options.counter, "GitHub GraphQL");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new SourceError("schema", "GitHub GraphQL returned invalid JSON");
    }
    const errors = (body as { errors?: { type?: unknown }[] } | null)?.errors;
    if (Array.isArray(errors) && errors.some((error) => error?.type === "RATE_LIMITED")) {
      throw new SourceError("rate-limit", "GitHub GraphQL RATE_LIMITED");
    }
    return body;
  }
}

/** Behavior 1: every page or nothing. */
export async function fetchOpenPrs(options: {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly fetchImpl: FetchLike;
  readonly delay: Delay;
  readonly counter: Counter;
  readonly pageSize?: number;
}): Promise<{ readonly nodes: readonly PrNode[]; readonly droppedNodes: number; readonly pages: number }> {
  if (options.token.trim() === "") throw new SourceError("auth", "GITHUB_SOURCE_TOKEN is not configured");
  const pages = [];
  let cursor: string | null = null;
  for (;;) {
    if (pages.length >= MAX_PAGES) throw new SourceError("schema", `GitHub GraphQL returned more than ${MAX_PAGES} pages`);
    const body = await graphqlPage(options, { owner: options.owner, repo: options.repo, n: options.pageSize ?? 100, cursor });
    const page = parsePrPage(body);
    if (!page.ok) throw new SourceError("schema", page.error);
    pages.push(page);
    if (!page.hasNextPage) break;
    if (page.endCursor === null) throw new SourceError("schema", "GitHub GraphQL page has a next page but no cursor");
    cursor = page.endCursor;
  }
  return { ...mergePrPages(pages), pages: pages.length };
}

/**
 * Behavior Q48: sequential reads at least `spacingMs` apart, with one retry after a 5xx, 429, or
 * network error when Retry-After is at most 60 s (5 s when absent).
 */
export class PoliteJsonClient {
  private last = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: {
    readonly fetchImpl: FetchLike;
    readonly delay: Delay;
    readonly now: () => number;
    readonly counter: Counter;
    readonly spacingMs?: number;
  }) {}

  private async pace(): Promise<void> {
    const wait = this.last + (this.options.spacingMs ?? 1_000) - this.options.now();
    if (wait > 0) await this.options.delay(wait);
    this.last = this.options.now();
  }

  async getJson(url: string, source: string): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      await this.pace();
      let response: Response;
      try {
        this.options.counter.requests += 1;
        response = await this.options.fetchImpl(url, {
          signal: AbortSignal.timeout(30_000),
          headers: { "User-Agent": SOURCE_USER_AGENT, Accept: "application/json" },
        });
      } catch (error) {
        if (attempt === 0) {
          await this.options.delay(5_000);
          continue;
        }
        throw new SourceError("transport", `${source}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.status === 429 || response.status >= 500) {
        const wait = retryAfterSeconds(response) ?? 5;
        await response.body?.cancel();
        if (attempt === 0 && wait <= 60) {
          await this.options.delay(wait * 1000);
          continue;
        }
        throw new SourceError(response.status === 429 ? "rate-limit" : "transport", `${source} ${response.status}`);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new SourceError("transport", `${source} ${response.status}`);
      }
      const text = await readBody(response, this.options.counter, source);
      try {
        return JSON.parse(text);
      } catch {
        throw new SourceError("schema", `${source} returned invalid JSON`);
      }
    }
  }
}

export const PONY_MAIL_API = "https://lists.apache.org/api/";

export function threadUrlFor(mid: string): string {
  return `${PONY_MAIL_API}thread.lua?id=${encodeURIComponent(mid)}&find_parent=true`;
}

export function emailUrlFor(mid: string): string {
  return `${PONY_MAIL_API}email.lua?id=${encodeURIComponent(mid)}`;
}
