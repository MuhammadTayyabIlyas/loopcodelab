#!/bin/bash
# Phase 2b: build the Windows installer OFF-BOX on GitHub Actions and share it to Google Drive.
# Dispatches the scaffolded "Windows Package" workflow, polls the run, downloads the installer
# artifact, and uploads it via the privileged wrapper. Run by the orchestrator AS THE APP USER
# (tmuxweb) — the upload needs the admin Drive OAuth (owned by www-data), via sudo.
# ALWAYS writes JSON to --out so the tick never hangs: {"shareLink":...,"qr":...} or {"error":...}.
# gh auth comes from GH_TOKEN in the environment. Requires `workflow`+`actions:write` scope.
set -u

DIR=""; REPO=""; NAME="app.exe"; OUT=""; URL=""; STUB=0; KIND="installer"
WORKFLOW="windows-package.yml"; ARTIFACT="windows-installer"
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:-}"; shift 2;;
    --repo) REPO="${2:-}"; shift 2;;
    --name) NAME="${2:-app.exe}"; shift 2;;
    --out) OUT="${2:-}"; shift 2;;
    --url) URL="${2:-}"; shift 2;;
    --kind) KIND="${2:-installer}"; shift 2;;
    --workflow) WORKFLOW="${2:-windows-package.yml}"; shift 2;;
    --artifact) ARTIFACT="${2:-windows-installer}"; shift 2;;
    --stub) STUB=1; shift;;
    *) shift;;
  esac
done
# kind picks the workflow/artifact/file-pattern defaults unless overridden explicitly.
if [ "$KIND" = "store" ]; then
  [ "$WORKFLOW" = "windows-package.yml" ] && WORKFLOW="windows-store.yml"
  [ "$ARTIFACT" = "windows-installer" ] && ARTIFACT="windows-store"
fi

[ -n "$OUT" ] || { echo "ralph-windows-deliver: no --out" >&2; exit 0; }
emit() { printf '%s\n' "$1" > "$OUT"; exit 0; }
fail() { local m="${1//\"/\\\"}"; emit "{\"error\":\"$m\"}"; }

# No-spend path for the stub harness.
if [ "$STUB" = 1 ]; then
  emit "{\"shareLink\":\"https://drive.example/stub/${NAME}\",\"qr\":\"https://drive.example/qr/${NAME}\"}"
fi

command -v gh >/dev/null 2>&1 || fail "gh CLI not installed"
[ -n "$REPO" ] || fail "no repo slug"
[ -n "${GH_TOKEN:-}" ] || fail "no GH_TOKEN"
export GH_PROMPT_DISABLED=1

# 1) Dispatch the workflow on the repo's default branch, then find the run we just created.
gh workflow run "$WORKFLOW" -R "$REPO" >/dev/null 2>&1 || fail "workflow dispatch failed (token needs workflow scope, or Actions disabled)"
RID=""
for i in $(seq 1 12); do
  sleep 5
  RID="$(gh run list -R "$REPO" --workflow "$WORKFLOW" --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null)"
  [ -n "$RID" ] && [ "$RID" != "null" ] && break
done
[ -n "$RID" ] && [ "$RID" != "null" ] || fail "could not find the dispatched run"

# 2) Poll until the run completes (installer builds take ~10-15 min; cap ~22 min).
CONCL=""
for i in $(seq 1 44); do
  ST="$(gh run view "$RID" -R "$REPO" --json status --jq '.status' 2>/dev/null)"
  if [ "$ST" = "completed" ]; then
    CONCL="$(gh run view "$RID" -R "$REPO" --json conclusion --jq '.conclusion' 2>/dev/null)"
    break
  fi
  sleep 30
done
[ "$CONCL" = "success" ] || fail "Actions run ${RID} ${CONCL:-timed out} — see the run logs"

# 3) Download the artifact and find the package (installer: .exe then .msi; store: .appx then .msix).
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" 2>/dev/null' EXIT  # always clean up the temp dir, incl. the fail() paths below
gh run download "$RID" -R "$REPO" -n "$ARTIFACT" -D "$TMP" >/dev/null 2>&1 || fail "artifact download failed"
if [ "$KIND" = "store" ]; then EXTS="appx msix"; else EXTS="exe msi"; fi
FILE=""
for ext in $EXTS; do
  FILE="$(find "$TMP" -type f -name "*.${ext}" | head -1)"
  [ -n "$FILE" ] && break
done
[ -n "$FILE" ] || fail "no package file (${EXTS// /\/}) in the artifact"

# 4) Share to Google Drive via the privileged wrapper (accepts .exe/.msi). Prints {shareLink,qr}.
OUTJSON="$(sudo -n /usr/local/sbin/webtmux-artifact-share "$FILE" "$NAME" 2>/dev/null)"
case "$OUTJSON" in
  *shareLink*) emit "$OUTJSON";;
  *) fail "Drive upload failed (is webtmux-artifact-share installed?)";;
esac
