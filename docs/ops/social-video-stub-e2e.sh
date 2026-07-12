#!/bin/bash
# No-spend e2e for the social-video output format. Stubbed agents on an isolated
# instance. Verifies: run reaches done, run.mediaReport exists (stub outputs won't
# pass ffprobe — the report being present and honest IS the assertion), and the
# compose CLI itself works with REAL local ffmpeg (free) on a generated still.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-8125}"
BASE="$(mktemp -d /tmp/socialvideo-stub-e2e.XXXXXX)"
trap 'kill -9 $SV 2>/dev/null; for s in $(tmux ls 2>/dev/null | grep -oE "^[a-z]+-svstub[^:]*"); do tmux kill-session -t "$s" 2>/dev/null; done; rm -rf "$BASE"' EXIT
mkdir -p "$BASE/data" "$BASE/projects"; git init --bare -q "$BASE/remote.git"
ss -ltn 2>/dev/null | grep -q "127.0.0.1:$PORT " && { echo "port $PORT busy"; exit 1; }

# 1) Real-ffmpeg compose smoke (no server, no spend) — the one-shot recipe + gallery
cd "$BASE"
convert -size 800x600 gradient:blue-red a.png
echo '{"title":"E2E","scenes":[{"image":"a.png","seconds":1}],"text":{"content":"Hi"}}' > sb.json
mkdir -p output
RALPH_MEDIA_COUNT_DIR="$BASE" node "$REPO/ralph/compose-media.mjs" story sb.json --out output/story --platforms tiktok,youtube || { echo "FAIL compose story"; exit 1; }
ffprobe -v error -show_entries stream=width -of csv=p=0 output/story-youtube.mp4 | grep -q 1920 || { echo "FAIL youtube dims"; exit 1; }
RALPH_MEDIA_COUNT_DIR="$BASE" node "$REPO/ralph/compose-media.mjs" gallery output --out index.html --title E2E || { echo "FAIL gallery"; exit 1; }
grep -q '<video' index.html || { echo "FAIL gallery html"; exit 1; }
echo "compose smoke OK"

# 2) Orchestrator e2e with stubs
export WEBTMUX_PORT=$PORT WEBTMUX_DATA="$BASE/data" WEBTMUX_PROJECTS_ROOT="$BASE/projects"
export RALPH_FORCE_TOOL=stub RALPH_FAKE_REMOTE="$BASE/remote.git"
export GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@local GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@local
( cd "$REPO" && node server.js > "$BASE/server.log" 2>&1 ) & SV=$!
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done

curl -s -X POST "http://127.0.0.1:$PORT/api/ralph/start" -H 'Content-Type: application/json' -d '{
  "project":"svstub","idea":"a 30s promo story video","master":"claude","workers":[],
  "outputFormat":"social-video","bypass":true,
  "platforms":["tiktok","youtube-short"],
  "mediaModels":{"image":{"provider":"grok","model":"grok-imagine-image"}},
  "prd":{"project":"svstub","description":"promo","outputFormat":"social-video",
    "stories":[{"id":"s1","title":"story video","description":"storyboard, assets, compose","acceptanceCriteria":["renders per platform"],"assignee":"claude","outputType":"social-video","deps":[]}]}}' >/dev/null

for i in $(seq 1 60); do
  p=$(curl -s "http://127.0.0.1:$PORT/api/ralph/status?project=svstub" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).phase)}catch{console.log("?")}})')
  [ "$p" = done ] && break; [ "$p" = failed ] && { echo "FAIL run failed"; tail -40 "$BASE/server.log"; exit 1; }
  sleep 2
done
[ "$p" = done ] || { echo "FAIL not done (phase=$p)"; exit 1; }

st=$(curl -s "http://127.0.0.1:$PORT/api/ralph/status?project=svstub")
echo "$st" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
  if(!j.mediaReport){console.error("FAIL no mediaReport");process.exit(1)}
  if(!Array.isArray(j.platforms)||j.platforms[0]!=="tiktok"){console.error("FAIL platforms lost");process.exit(1)}
  if(!j.mediaModels||!j.mediaModels.image){console.error("FAIL mediaModels lost");process.exit(1)}
  console.log("mediaReport present, missing:",j.mediaReport.missing.join(","))})' || exit 1
echo "PASS social-video stub e2e"
