/**
 * Spec 020 B27: a "Runs on" cell may only narrow what the evidence allows. The single source for the
 * rows of `feature-map-site.test.ts` and for the table in docs/specs/020-feature-map-site/spec.md
 * (`bun run docs:test-plan`). Evidence is this repository's on 2026-10-19 unless `why` says otherwise.
 *
 * - `claim`: the spec's "Runs on" cell in the feature map's Acceptance table.
 * - `status`: its Status line; `inTag`: its directory is in `production` (the newest buildable `v*` tag, `—`: none).
 * - `offOnProd`: Deployed configuration rows naming it that are unset or none on Prod.
 * - `pages`: the specs `.github/workflows/feature-map-site.yml` cites, i.e. publishes.
 * - `error`: what the rejection says (`—`: the claim is accepted).
 */
export const testPlanRows = [
  { id: "B27", spec: "019", claim: "Prod", status: "Partially implemented", inTag: false, offOnProd: "PEOPLE_ACTIVITY, PEOPLE_PROFILES", production: "v0.2.0", pages: "020", error: "its directory is not in v0.2.0", why: "a Dev-only spec cannot be put in the Prod tag" },
  { id: "B27", spec: "020", claim: "Prod", status: "Implemented (#66)", inTag: false, offOnProd: "", production: "v0.2.0", pages: "020", error: "its directory is not in v0.2.0", why: "the site is not part of Prod" },
  { id: "B27", spec: "024", claim: "GitHub Pages", status: "Implemented (#90, #91)", inTag: false, offOnProd: "", production: "v0.2.0", pages: "020", error: ".github/workflows/feature-map-site.yml publishes Spec 020", why: "only what the workflow publishes is on GitHub Pages" },
  { id: "B27", spec: "001", claim: "Dev", status: "Implemented (baseline)", inTag: true, offOnProd: "", production: "v0.2.0", pages: "020", error: null, why: "narrowing: a spec in the Prod tag may be marked Dev" },
  { id: "B27", spec: "003", claim: "Prod", status: "Implemented (baseline)", inTag: true, offOnProd: "", production: "v0.2.0", pages: "020", error: null, why: "in the tag and nothing off on Prod" },
  { id: "B27", spec: "017", claim: "Prod", status: "Implemented (#52)", inTag: true, offOnProd: "SEARCH_LEXICAL_REVISION", production: "v0.2.0", pages: "020", error: "Deployed configuration SEARCH_LEXICAL_REVISION unset or none on Prod", why: "hypothetical: in the tag but its flag is off on Prod" },
  { id: "B27", spec: "001", claim: "Prod", status: "Implemented (baseline)", inTag: false, offOnProd: "", production: null, pages: "020", error: "cannot be confirmed: this build has no readable v* tag", why: "no tag, no Prod" },
  { id: "B27", spec: "020", claim: "GitHub Pages", status: "Implemented (#66)", inTag: false, offOnProd: "", production: "v0.2.0", pages: "020", error: null, why: "the workflow publishes it" },
  { id: "B27", spec: "015", claim: "Dev", status: "Partially implemented", inTag: false, offOnProd: "", production: "v0.2.0", pages: "020", error: null, why: "partly built counts as implemented on main" },
  { id: "B27", spec: "005", claim: "Dev", status: "Accepted for implementation", inTag: true, offOnProd: "", production: "v0.2.0", pages: "020", error: "contradicts its Status, which is not implemented", why: "hypothetical: not built cannot run anywhere" },
  { id: "B27", spec: "007", claim: "none (homelab spike)", status: "Spike completed", inTag: false, offOnProd: "", production: "v0.2.0", pages: "020", error: null, why: "none is always allowed" },
  { id: "B27", spec: "012", claim: "Staging", status: "Implemented (#27)", inTag: false, offOnProd: "", production: "v0.2.0", pages: "020", error: "is not one of Prod, Dev, GitHub Pages, none", why: "outside the vocabulary" },
] as const;
