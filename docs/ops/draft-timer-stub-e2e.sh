#!/bin/bash
# Isolated no-spend e2e for the draft start timer: schedule a draft -> the server clock
# fires it -> the run starts (stub agents) -> the draft is deleted. Also the failure path:
# a scheduled draft that cannot start keeps a startError. Never touches the live service.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT=8126
BASE="$(mktemp -d /tmp/draft-timer-e2e.XXXXXX)"
trap 'kill -9 $SV 2>/dev/null; for s in $(tmux ls 2>/dev/null | grep -oE "^[a-z]+-timerstub[^:]*"); do tmux kill-session -t "$s" 2>/dev/null; done; rm -rf "$BASE"' EXIT
mkdir -p "$BASE/data" "$BASE/projects"; git init --bare -q "$BASE/remote.git"
ss -ltn | grep -q "127.0.0.1:$PORT " && { echo "port busy"; exit 1; }

export WEBTMUX_PORT=$PORT WEBTMUX_DATA="$BASE/data" WEBTMUX_PROJECTS_ROOT="$BASE/projects"
export RALPH_FORCE_TOOL=stub RALPH_FAKE_REMOTE="$BASE/remote.git"
export GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@local GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@local
( cd "$REPO" && node server.js > "$BASE/server.log" 2>&1 ) & SV=$!
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done

J() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify(eval("r"+process.argv[1]||"r")))})' "$1"; }

echo "=== save a draft (timerstub) ==="
ID=$(curl -s -X POST "http://127.0.0.1:$PORT/api/ralph/drafts" -H 'Content-Type: application/json' -d '{
  "draft": {"name":"timerstub","project":"timerstub","idea":"a tiny scheduled web app","master":"claude","workers":[],
  "outputFormat":"web-app",
  "prd":{"project":"timerstub","description":"tiny","outputFormat":"web-app",
    "stories":[{"id":"s1","title":"page","description":"an index page","acceptanceCriteria":["loads"],"assignee":"claude","outputType":"web-app","deps":[]}]}}}' | J .id)
echo "  draft id: $ID"

echo "=== schedule it (delayMs=1 -> clamped to 15s floor) ==="
curl -s -X POST "http://127.0.0.1:$PORT/api/ralph/drafts/${ID//\"/}/schedule" -H 'Content-Type: application/json' -d '{"delayMs":1}'
echo
echo "  listed:"; curl -s "http://127.0.0.1:$PORT/api/ralph/drafts" | J '.drafts[0]'

echo "=== cancel + re-schedule (cancel path) ==="
curl -s -X DELETE "http://127.0.0.1:$PORT/api/ralph/drafts/${ID//\"/}/schedule" >/dev/null
canceled=$(curl -s "http://127.0.0.1:$PORT/api/ralph/drafts" | J '.drafts[0].startAt')
echo "  startAt after cancel: $canceled"
curl -s -X POST "http://127.0.0.1:$PORT/api/ralph/drafts/${ID//\"/}/schedule" -H 'Content-Type: application/json' -d '{"delayMs":1}' >/dev/null

echo "=== wait for the timer to fire (15s floor + <=15s scan + <=5s tick) ==="
for i in $(seq 1 30); do
  P=$(curl -s "http://127.0.0.1:$PORT/api/ralph/status?project=timerstub" | J .phase 2>/dev/null)
  N=$(curl -s "http://127.0.0.1:$PORT/api/ralph/drafts" | J '.drafts.length')
  echo "  t=$((i*3))s run-phase=${P:-none} drafts-left=$N"
  [ "${P:-}" != "" ] && [ "$P" != "null" ] && [ "$N" = "0" ] && case "$P" in '"done"'|'"failed"'|'"push_failed"') break;; esac
  sleep 3
done

echo "=== failure path: draft whose start must fail (idea missing) ==="
ID2=$(curl -s -X POST "http://127.0.0.1:$PORT/api/ralph/drafts" -H 'Content-Type: application/json' -d '{"draft":{"name":"badtimer","project":"badtimer","idea":"","master":"claude"}}' | J .id)
curl -s -X POST "http://127.0.0.1:$PORT/api/ralph/drafts/${ID2//\"/}/schedule" -H 'Content-Type: application/json' -d '{"delayMs":1}' >/dev/null
sleep 36
echo "  bad draft after fire:"; curl -s "http://127.0.0.1:$PORT/api/ralph/drafts" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify(r.drafts.find(d=>d.name==="badtimer")))})'

echo "=== checks ==="
FAIL=0
ck() { if eval "$2"; then echo "  ok: $1"; else echo "  FAIL: $1"; FAIL=1; fi; }
FINAL=$(curl -s "http://127.0.0.1:$PORT/api/ralph/status?project=timerstub" | J .phase)
DRAFTS=$(curl -s "http://127.0.0.1:$PORT/api/ralph/drafts")
ck "scheduled run reached done"    "[ '$FINAL' = '\"done\"' ]"
ck "fired draft was deleted"       "! echo '$DRAFTS' | grep -q timerstub"
ck "failed draft kept + startError" "echo '$DRAFTS' | grep -q 'badtimer' && echo '$DRAFTS' | grep -qi 'startError'"
[ "$FAIL" = 0 ] && echo "ALL CHECKS PASSED" || { echo "FAILED — log tail:"; tail -25 "$BASE/server.log"; exit 1; }
