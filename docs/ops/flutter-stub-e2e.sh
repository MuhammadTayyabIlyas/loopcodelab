#!/bin/bash
# No-spend end-to-end check for the flutter-app output format. Drives the orchestrator
# with stubbed agents (RALPH_FORCE_TOOL=stub) on an ISOLATED instance — own port, data
# dir, projects dir, and a local fake git remote — so it never touches the live service.
# Verifies: building -> finalizing -> delivering -> done, with a (stubbed) APK link
# recorded in run.apk + DELIVERABLE.md. Run from the repo root: bash docs/ops/flutter-stub-e2e.sh
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-8124}"
BASE="$(mktemp -d /tmp/flutter-stub-e2e.XXXXXX)"
trap 'kill -9 $SV 2>/dev/null; for s in $(tmux ls 2>/dev/null | grep -oE "^[a-z]+-flutterstub[^:]*"); do tmux kill-session -t "$s" 2>/dev/null; done; rm -rf "$BASE"' EXIT
mkdir -p "$BASE/data" "$BASE/projects"; git init --bare -q "$BASE/remote.git"

ss -ltn 2>/dev/null | grep -q "127.0.0.1:$PORT " && { echo "port $PORT busy"; exit 1; }

export WEBTMUX_PORT=$PORT WEBTMUX_DATA="$BASE/data" WEBTMUX_PROJECTS_ROOT="$BASE/projects"
export RALPH_FORCE_TOOL=stub RALPH_FAKE_REMOTE="$BASE/remote.git"
export GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@local GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@local
( cd "$REPO" && node server.js > "$BASE/server.log" 2>&1 ) & SV=$!

for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done

curl -s -X POST "http://127.0.0.1:$PORT/api/ralph/start" -H 'Content-Type: application/json' -d '{
  "project":"flutterstub","idea":"a simple counter flutter app","master":"claude","workers":[],
  "outputFormat":"flutter-app","bypass":true,
  "prd":{"project":"flutterstub","description":"counter","outputFormat":"flutter-app",
    "stories":[{"id":"s1","title":"counter screen","description":"a counter button","acceptanceCriteria":["increments"],"assignee":"claude","outputType":"flutter-app","deps":[]}]}}' >/dev/null

for i in $(seq 1 60); do
  p=$(curl -s "http://127.0.0.1:$PORT/api/ralph/status?project=flutterstub" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).phase)}catch{console.log("?")}})')
  echo "t=$((i*2))s phase=$p"; case "$p" in done|failed|push_failed) break;; esac; sleep 2
done

echo "=== result ==="
curl -s "http://127.0.0.1:$PORT/api/ralph/status?project=flutterstub" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify({phase:r.phase,apk:r.apk,error:r.error},null,2))})'
[ -f "$BASE/projects/flutterstub/DELIVERABLE.md" ] && { echo "--- DELIVERABLE.md ---"; cat "$BASE/projects/flutterstub/DELIVERABLE.md"; }
