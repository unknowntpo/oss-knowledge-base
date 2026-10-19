#!/usr/bin/env bash
# Provision the two Prod data Worker secrets (runbook "First Prod release", step 2).
#
#   scripts/release/put-prod-secrets.sh          # put both secrets
#   scripts/release/put-prod-secrets.sh --check  # list the Prod Worker's secret NAMES only
#
# MANUAL_TRIGGER_TOKEN: generated once (openssl rand -hex 32) into the macOS Keychain item
#   service osskb-prod-manual-trigger, account oss-knowledge-base-data-prod; reused when present.
# GITHUB_SOURCE_TOKEN: read from a hidden prompt (or stdin when piped): a fine-grained GitHub token,
#   public repositories, read-only.
# Values go to wrangler on stdin only; nothing is echoed, logged, or passed as an argument.
# Before the first deploy, `wrangler secret put` creates an empty draft Worker
# oss-knowledge-base-data-prod (no route logic, no cron); the tag's deploy replaces its code and
# keeps the secrets. Needs `bunx wrangler login` (or CLOUDFLARE_API_TOKEN) for the account.
set -euo pipefail
set +x

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG="wrangler.production.jsonc"
SERVICE="osskb-prod-manual-trigger"
ACCOUNT="oss-knowledge-base-data-prod"
cd "$ROOT/apps/data-publisher-worker"

secret_names() {
  bunx wrangler secret list -c "$CONFIG" --format json 2>/dev/null | grep -o '"name": *"[A-Z_]*"' | sed 's/.*"\([A-Z_]*\)"$/\1/' || true
}

if [[ "${1:-}" == "--check" ]]; then
  names="$(secret_names)"
  missing=0
  for name in GITHUB_SOURCE_TOKEN MANUAL_TRIGGER_TOKEN; do
    if grep -qx "$name" <<<"$names"; then echo "present: $name"; else echo "missing: $name"; missing=1; fi
  done
  exit "$missing"
elif [[ $# -gt 0 ]]; then
  echo "usage: $0 [--check]" >&2
  exit 2
fi

if ! security find-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null 2>&1; then
  security add-generic-password -s "$SERVICE" -a "$ACCOUNT" -w "$(openssl rand -hex 32)"
  echo "MANUAL_TRIGGER_TOKEN generated into Keychain ($SERVICE / $ACCOUNT)"
else
  echo "MANUAL_TRIGGER_TOKEN reused from Keychain ($SERVICE / $ACCOUNT)"
fi
security find-generic-password -s "$SERVICE" -a "$ACCOUNT" -w | bunx wrangler secret put MANUAL_TRIGGER_TOKEN -c "$CONFIG" >/dev/null
echo "put: MANUAL_TRIGGER_TOKEN"

if [[ -t 0 ]]; then
  read -rsp "GITHUB_SOURCE_TOKEN (input hidden): " github_token
  echo
else
  IFS= read -r github_token
fi
if [[ -z "$github_token" ]]; then
  echo "GITHUB_SOURCE_TOKEN is empty; nothing put" >&2
  exit 1
fi
printf '%s' "$github_token" | bunx wrangler secret put GITHUB_SOURCE_TOKEN -c "$CONFIG" >/dev/null
unset github_token
echo "put: GITHUB_SOURCE_TOKEN"
