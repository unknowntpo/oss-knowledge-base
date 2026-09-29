import type { GitHubJsonTransport } from "@oss-knowledge-base/github-publisher/github-connector";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class GitHubFetchTransport implements GitHubJsonTransport {
  private readonly fetchImpl: FetchLike;
  private readonly delay: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly token: string,
    options: {
      readonly fetchImpl?: FetchLike;
      readonly delay?: (milliseconds: number) => Promise<void>;
    } = {},
  ) {
    if (token.trim().length === 0) throw new Error("GITHUB_SOURCE_TOKEN is not configured");
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async getJson<T>(url: string): Promise<T> {
    const target = new URL(url);
    if (target.origin !== "https://api.github.com") {
      throw new Error(`Unsupported GitHub API origin: ${target.origin}`);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.fetchImpl(target, {
        signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: "application/vnd.github.full+json",
          Authorization: `Bearer ${this.token}`,
          "User-Agent": "oss-knowledge-base-data-publisher",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (response.ok) return await response.json() as T;
      if ([500, 502, 503, 504, 524].includes(response.status) && attempt < 2) {
        await response.body?.cancel();
        await this.delay(250 * (2 ** attempt));
        continue;
      }
      const remaining = response.headers.get("x-ratelimit-remaining") ?? "unknown";
      const reset = response.headers.get("x-ratelimit-reset") ?? "unknown";
      if (response.status === 403 || response.status === 429) {
        throw new Error(`GitHub rate limit ${response.status}; remaining=${remaining}; reset=${reset}`);
      }
      throw new Error(`GitHub API ${response.status}; remaining=${remaining}; reset=${reset}`);
    }
    throw new Error("GitHub API retry boundary exhausted");
  }
}
