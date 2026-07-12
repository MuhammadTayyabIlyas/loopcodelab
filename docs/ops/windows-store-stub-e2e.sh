#!/bin/bash
# No-spend end-to-end check for the Windows packaging paths (Phase 2b installer + Phase 3
# Store). Drives the orchestrator with stubbed agents (RALPH_FORCE_TOOL=stub) on an
# ISOLATED instance — own port, data dir, projects dir, and a local fake git remote — so it
# never touches the live service. Verifies: web-app build -> done; /windows/installer ->
# windows-delivering -> done with run.windows.installer.shareLink; /windows/store (electron)
# -> windows-delivering -> done with run.windows.store.shareLink + store-electron/ scaffold +
# windows-store.yml; /windows/submit -> SUBMISSION-WINDOWS.md; DELIVERABLE.md has both links.
# Run from the repo root: bash docs/ops/windows-store-stub-e2e.sh
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-8125}"
BASE="$(mktemp -d /tmp/windows-stub-e2e.XXXXXX)"
trap 'kill -9 $SV 2>/dev/null; for s in $(tmux ls 2>/dev/null | grep -oE "^[a-z]+-winstub[^:]*"); do tmux kill-session -t "$s" 2>/dev/null; done; rm -rf "$BASE"' EXIT
mkdir -p "$BASE/data" "$BASE/projects"; git init --bare -q "$BASE/remote.git"

ss -ltn 2>/dev/null | grep -q "127.0.0.1:$PORT " && { echo "port $PORT busy"; exit 1; }

export WEBTMUX_PORT=$PORT WEBTMUX_DATA="$BASE/data" WEBTMUX_PROJECTS_ROOT="$BASE/projects"
export RALPH_FORCE_TOOL=stub RALPH_FAKE_REMOTE="$BASE/remote.git"
export GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@local GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@local
( cd "$REPO" && node server.js > "$BASE/server.log" 2>&1 ) & SV=$!

for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done

api() { curl -s -X POST "http://127.0.0.1:$PORT$1" -H 'Content-Type: application/json' -d "$2"; }
phase() { curl -s "http://127.0.0.1:$PORT/api/ralph/status?project=winstub" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).phase)}catch{console.log("?")}})'; }
wait_done() { for i in $(seq 1 60); do p=$(phase); echo "  t=$((i*2))s phase=$p"; case "$p" in done|failed|push_failed) break;; esac; sleep 2; done; }

echo "=== 1) build a stub web-app to done ==="
api /api/ralph/start '{
  "project":"winstub","idea":"a tiny web app","master":"claude","workers":[],
  "outputFormat":"web-app","bypass":true,
  "prd":{"project":"winstub","description":"tiny","outputFormat":"web-app",
    "stories":[{"id":"s1","title":"page","description":"an index page","acceptanceCriteria":["loads"],"assignee":"claude","outputType":"web-app","deps":[]}]}}' >/dev/null
wait_done

echo "=== 2) Windows installer (stub delivery) ==="
api /api/ralph/windows/installer '{"project":"winstub","version":"1.0.0"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("  ->",r.error||r.message)})'
wait_done

echo "=== 3) Store package (electron, stub delivery) ==="
api /api/ralph/windows/store '{"project":"winstub","packaging":"electron","identityName":"12345Tester.WinStub","publisher":"CN=00000000-1111-2222-3333-444444444444","publisherDisplayName":"Tester","version":"1.0.0"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("  ->",r.error||r.message)})'
wait_done

echo "=== 4) Store submission prep ==="
api /api/ralph/windows/submit '{"project":"winstub"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("  ->",r.error||r.message)})'

echo "=== result ==="
curl -s "http://127.0.0.1:$PORT/api/ralph/status?project=winstub" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify({phase:r.phase,windows:r.windows,error:r.error},null,2))})'
D="$BASE/projects/winstub"
FAIL=0
ck() { if eval "$2"; then echo "  ok: $1"; else echo "  FAIL: $1"; FAIL=1; fi; }
ck "installer shareLink"            "grep -q 'Installer (EXE) download' '$D/DELIVERABLE.md'"
ck "store shareLink in DELIVERABLE" "grep -q 'Microsoft Store package' '$D/DELIVERABLE.md'"
ck "electron wrapper scaffolded"    "[ -f '$D/store-electron/package.json' ] && [ -f '$D/store-electron/main.js' ]"
ck "store workflow committed"       "[ -f '$D/.github/workflows/windows-store.yml' ]"
ck "submission checklist"           "grep -q 'Partner Center' '$D/SUBMISSION-WINDOWS.md'"
ck "no secrets committed"           "! git -C '$D' ls-files | grep -qE '\.pfx$|\.snk$'"
[ "$FAIL" = 0 ] && echo "ALL CHECKS PASSED" || { echo "CHECKS FAILED — server log tail:"; tail -30 "$BASE/server.log"; exit 1; }
