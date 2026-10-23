/** Spec 028: the recorder a Worker environment gets, or none while `OBSERVABILITY_SIGNALS` is not `on`. */
import { resolveSignalsMode } from "./profile";
import { SignalRecorder, type AnalyticsSql, type SignalsSink } from "./recorder";

export interface SignalsEnv {
  readonly PUBLICATION_ENVIRONMENT: "development" | "production";
  readonly OBSERVABILITY_SIGNALS?: string;
  readonly SIGNALS?: SignalsSink;
  readonly ANALYTICS_SQL?: AnalyticsSql;
}

/** Behavior 1: a recorder only for `on`; a missing binding is the recorder's to report (analytics rules `unknown`). */
export function signalsFor(env: SignalsEnv): SignalRecorder | undefined {
  if (resolveSignalsMode(env.OBSERVABILITY_SIGNALS) !== "on") return undefined;
  return new SignalRecorder({
    environment: env.PUBLICATION_ENVIRONMENT,
    sink: env.SIGNALS,
    sql: env.ANALYTICS_SQL,
    now: () => Date.now(),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}
