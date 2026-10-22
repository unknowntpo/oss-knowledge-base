/** Shared shapes of the Spec 027 Amendment (2) core. */

export type Env = "dev" | "prod";
export type Mode = "off" | "dry" | "live";

/** `/health` as the Worker serves it; the core reads fields, never derives thresholds (SRE34). */
export type Health = Record<string, unknown>;

/** One Spec 028 `/health.signals.rules[]` entry. */
export interface RuleEntry {
  readonly id: string;
  readonly job: string;
  readonly status: "ok" | "warn" | "firing" | "unknown";
  readonly since?: string | null;
  readonly runId?: string | null;
  readonly value?: unknown;
  readonly threshold?: unknown;
}

/** A firing (B27): fingerprinted as `<env>:<job>:<ruleId>:<since>`. */
export interface Firing {
  readonly env: Env;
  readonly job: string;
  readonly ruleId: string;
  readonly since: string;
  readonly runId: string | null;
  /** The source entry as served (rule entry, cost-guard breaker, or CI run), quoted into the bundle. */
  readonly entry: unknown;
}

export interface CiRun {
  readonly id: number;
  readonly conclusion: string | null;
  readonly headBranch: string;
  readonly createdAt: string;
  readonly htmlUrl: string;
}

/** The harness CI rule `ci.release` (B27): `unknown` is recorded and never fires. */
export interface CiRelease {
  readonly status: "ok" | "firing" | "unknown";
  readonly reason?: string;
  readonly run?: CiRun;
  readonly failedJob?: string;
}

/** A raw object store (R2-like). The core only reaches it through `scopedStore`. */
export interface RawStore {
  get(key: string): Promise<string | null>;
  put(key: string, body: string): Promise<void>;
}

export type SqlTemplate = "Q-run" | "Q-history" | "Q-window";

/** Spec 027 A2's fixed templates; the harness binds the arguments, nobody writes SQL. */
export type SqlArgs =
  | { readonly template: "Q-run"; readonly env: Env; readonly runId: string }
  | { readonly template: "Q-history"; readonly env: Env; readonly job: string }
  | { readonly template: "Q-window"; readonly env: Env; readonly at: string };

export type QuerySignals = (args: SqlArgs) => Promise<unknown>;
