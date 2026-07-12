#!/bin/bash
# Install the headless browser used for store-screenshot capture (ralph/capture-shots.mjs),
# in a SHARED world-readable path so the app user (tmuxweb) and sandboxed tenants (wt_*) can
# all launch it — mirrors the /opt/flutter shared-SDK pattern. Run ONCE as root; idempotent.
#
#   sudo bash docs/ops/playwright-shots-setup.sh
#
# The driver (playwright-core) is a normal repo dependency (package.json) installed by
# `npm install`; this script only provisions the shared browser binaries.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/ms-playwright}"

[ -d "$REPO/node_modules/playwright-core" ] || { echo "run 'npm install' first (need playwright-core)"; exit 1; }

# Download the chromium matching the installed playwright-core into the shared path.
PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" \
  node "$REPO/node_modules/playwright-core/cli.js" install chromium

# World-readable/executable so tmuxweb + wt_* can launch it (no secrets in here).
chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"
echo "shared chromium ready at $PLAYWRIGHT_BROWSERS_PATH:"
ls -1 "$PLAYWRIGHT_BROWSERS_PATH"
