#!/usr/bin/env bash
# Upload a finished social-video build's platform renders to Google Drive via
# the privileged webtmux-artifact-share wrapper, then write ONE sentinel JSON
# the orchestrator tick reaps. ALWAYS writes the sentinel (emit/fail) so the
# tick can never hang on us. --stub (RALPH_FORCE_TOOL) fakes links, no uploads.
# Usage: ralph-media-deliver.sh --dir <run.dir> --project <slug> --out <sentinel> [--stub]
set -u
DIR="" PROJECT="" OUT="" STUB=0
while [ $# -gt 0 ]; do case "$1" in
  --dir) DIR="$2"; shift 2;; --project) PROJECT="$2"; shift 2;;
  --out) OUT="$2"; shift 2;; --stub) STUB=1; shift;;
  *) shift;;
esac; done
emit() { printf '%s\n' "$1" > "$OUT" 2>/dev/null || true; exit 0; }
fail() { printf '{"error":"%s"}\n' "$1" > "$OUT" 2>/dev/null || true; exit 0; }
[ -n "$DIR" ] && [ -n "$PROJECT" ] && [ -n "$OUT" ] || fail "bad args"
command -v jq >/dev/null 2>&1 || fail "jq required"
# Platform ids from the real registry (single source of truth), longest-first so
# hyphenated ids (youtube-short) win over their prefixes (youtube). Resolve the
# script dir BEFORE cd so a relative $0 still finds social-formats.mjs.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLATFORM_IDS="$(node -e "import('$SCRIPT_DIR/social-formats.mjs').then(m=>console.log(Object.keys(m.PLATFORM_SPECS).sort((a,b)=>b.length-a.length).join(' ')))" 2>/dev/null)" || PLATFORM_IDS=""
[ -n "$PLATFORM_IDS" ] || fail "cannot load platform registry"
cd "$DIR" 2>/dev/null || fail "bad dir"

FILES=$(ls output/*.mp4 2>/dev/null) || true
[ -n "$FILES" ] || fail "no output renders found"

json_items="" n=0
for f in $FILES; do
  base=$(basename "$f")
  # platform = the -<id>.mp4 suffix, matched against the registry (longest-first);
  # skip files that don't match the contract
  plat=""
  for id in $PLATFORM_IDS; do case "$base" in *-"$id".mp4) plat="$id"; break;; esac; done
  [ -n "$plat" ] || continue
  n=$((n+1)); [ $n -gt 12 ] && break
  name="${PROJECT}-${plat}.mp4"
  if [ "$STUB" = 1 ]; then
    item="{\"name\":\"$name\",\"platform\":\"$plat\",\"shareLink\":\"https://drive.example/stub/$name\",\"directDownload\":\"https://drive.example/dl/$name\",\"qr\":\"https://drive.example/qr/$name\",\"size\":1024}"
  else
    OUTJSON="$(sudo -n /usr/local/sbin/webtmux-artifact-share "$(readlink -f "$f")" "$name" 2>/dev/null)" || OUTJSON=""
    case "$OUTJSON" in
      *shareLink*)
        # inject the platform key the orchestrator groups by (compact one-line JSON)
        item=$(printf '%s' "$OUTJSON" | jq -c --arg plat "$plat" '. + {platform:$plat}' 2>/dev/null) || continue
        ;;
      *) continue;;
    esac
  fi
  [ -n "$json_items" ] && json_items="$json_items,"
  json_items="$json_items$item"
done

[ -n "$json_items" ] || fail "all uploads failed (is webtmux-artifact-share installed with media extensions?)"
emit "{\"files\":[$json_items]}"
