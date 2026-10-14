# Gardening list

Known workarounds.

Last full pass: 2026-10-06 (`main` 6cfbfc6).

## Web UI

### G1. `<html lang>` is not set on first load
- **Where:** `apps/web/index.html`; a page that starts in English keeps
  `lang="zh-Hant"`.
- **Why:** screen readers use the wrong language.
- **Fix:** set `lang` once at startup.
- **Layer:** test (E2E asserting `<html lang>` per locale).
- **Source:** [PR #26](https://github.com/example/repo/pull/26).

## Process and docs

### G11. Spec status lines drift from reality
- **Where:** `docs/specs/*/spec.md`.
- **Fix:** one `Status:` line form.
- **Layer:** static check (extend `check:traceability`).
