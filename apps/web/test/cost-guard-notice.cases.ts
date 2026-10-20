/**
 * Spec 026 test plan (CG12, Behavior 14): what the top bar says for each `/api/cost-guard`
 * answer. The single source for `test/cost-guard-notice.test.ts` and for the second table in
 * docs/specs/026-cost-guard/spec.md (`bun run docs:test-plan` regenerates it).
 *
 * `status` and `enforced` are the answer's fields; `null` is a field that is absent (or a body
 * that is not an object). `en`, `zh` and `className` are the notice; `null` is no notice.
 */
const WARN_EN = "Usage near the free allowance";
const WARN_ZH = "用量接近免費額度";
const PAUSED_EN = "Cost guard: semantic search and digests paused";
const PAUSED_ZH = "費用保護：語意搜尋與摘要已暫停";

export const testPlanRows = [
  { id: "CG12", case: "every metric is under its warning share", status: "ok", enforced: false, en: null, zh: null, className: null },
  { id: "CG12", case: "no check has run yet", status: "pending", enforced: false, en: null, zh: null, className: null },
  { id: "CG12", case: "the Pages project has no binding", status: "off", enforced: null, en: null, zh: null, className: null },
  { id: "CG12", case: "a requirement (token, account) is missing", status: "unconfigured", enforced: false, en: null, zh: null, className: null },
  { id: "CG12", case: "a metric is past its warning share while monitoring", status: "warn", enforced: false, en: WARN_EN, zh: WARN_ZH, className: "is-warn" },
  { id: "CG12", case: "a metric is past its warning share while enforcing", status: "warn", enforced: true, en: WARN_EN, zh: WARN_ZH, className: "is-warn" },
  { id: "CG12", case: "the breaker is open while enforcing", status: "tripped", enforced: true, en: PAUSED_EN, zh: PAUSED_ZH, className: "is-tripped" },
  { id: "CG12", case: "the breaker would be open, but only monitoring", status: "tripped", enforced: false, en: WARN_EN, zh: WARN_ZH, className: "is-warn" },
  { id: "CG12", case: "the breaker is open and enforced is not a boolean", status: "tripped", enforced: null, en: WARN_EN, zh: WARN_ZH, className: "is-warn" },
  { id: "CG12", case: "a malformed body (no known status)", status: null, enforced: true, en: null, zh: null, className: null },
] as const;
