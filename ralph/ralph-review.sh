#!/bin/bash
# Master review of ONE story branch. Writes "ACCEPT" or "REJECT: <reason>" to the
# verdict file, then exits 0. RALPH_FORCE_TOOL=stub => always ACCEPT (dry-run).
# Usage: ralph-review.sh --tool T --story ID --dir PROJECT_DIR --branch B --verdict FILE
set -uo pipefail
TOOL=""; STORY=""; DIR="."; BRANCH=""; VERDICT_FILE=""; MODEL=""; REVISION=""
while [[ $# -gt 0 ]]; do case "$1" in
  --tool) TOOL="$2"; shift 2;; --story) STORY="$2"; shift 2;;
  --dir) DIR="$2"; shift 2;; --branch) BRANCH="$2"; shift 2;;
  --verdict) VERDICT_FILE="$2"; shift 2;; --model) MODEL="$2"; shift 2;;
  --revision) REVISION="$2"; shift 2;; *) shift;;
esac; done
[[ -n "${RALPH_FORCE_TOOL:-}" ]] && TOOL="$RALPH_FORCE_TOOL"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR" 2>/dev/null || { echo "REJECT: no project dir" > "$VERDICT_FILE"; exit 0; }
mkdir -p "$(dirname "$VERDICT_FILE")"

if [[ "$TOOL" == "stub" ]]; then
  echo "[stub-review] ACCEPT $STORY"; echo "ACCEPT" > "$VERDICT_FILE"; exit 0
fi

HEADER="Story id: $STORY
Branch under review: $BRANCH
You are INSIDE this branch's worktree ($DIR) — it is already checked out to
$BRANCH, so build/run/test the branch right here. Do NOT switch branches or
touch the main checkout.
See the worker's changes with: git diff main...$BRANCH"
PROMPT="$HEADER"$'\n\n'"$(cat "$SCRIPT_DIR/review.md" 2>/dev/null)"
# Revision stories get a diff-focused addendum: judge the change, reject only
# with concrete evidence (see review-revision.md).
if [[ -n "$REVISION" ]]; then
  PROMPT="$PROMPT"$'\n\n'"$(cat "$SCRIPT_DIR/review-revision.md" 2>/dev/null)"
fi

BYPASS="${RALPH_BYPASS:-1}"; bypass_flag=""
if [[ "$BYPASS" == "1" ]]; then case "$TOOL" in
  claude|glm) bypass_flag="--dangerously-skip-permissions";;
  codex) bypass_flag="--sandbox danger-full-access";;
  gemini|qwen|vibe) bypass_flag="--yolo";;
  grok) bypass_flag="--always-approve";;
esac; fi
model_flag=(); [[ -n "$MODEL" ]] && model_flag=(--model "$MODEL")
run_master() {
  case "$TOOL" in
    claude) printf '%s' "$PROMPT" | claude $bypass_flag "${model_flag[@]}" --print ;;
    glm)    printf '%s' "$PROMPT" | ANTHROPIC_BASE_URL="https://ark.ap-southeast.bytepluses.com/api/coding" \
              ANTHROPIC_API_KEY="${GLM_API_KEY:-}" claude --model GLM-5.1 $bypass_flag --print ;;
    codex)  printf '%s' "$PROMPT" | codex exec $bypass_flag "${model_flag[@]}" - ;;
    gemini) gemini $bypass_flag "${model_flag[@]}" -p "$PROMPT" ;;
    qwen)   qwen $bypass_flag "${model_flag[@]}" -p "$PROMPT" ;;
    kimi)   kimi "${model_flag[@]}" -p "$PROMPT" ;;
    grok)   grok $bypass_flag --no-auto-update "${model_flag[@]}" -p "$PROMPT" ;;
    vibe)   vibe $bypass_flag --trust -p "$PROMPT" ;;
    *) echo "unknown tool $TOOL" ;;
  esac
}
# Never let a tool failure abort before a verdict is written (else the story would
# hang in review forever). `|| true` keeps going; a missing verdict => REJECT.
OUT="$(run_master 2>&1)" || true
if grep -q '<verdict>ACCEPT</verdict>' <<<"$OUT"; then
  echo "ACCEPT" > "$VERDICT_FILE"
else
  # Extract the one-line reason from <verdict>REJECT: reason</verdict> (review.md format).
  REASON="$(grep -o '<verdict>REJECT[^<]*' <<<"$OUT" | head -1 | sed 's/^<verdict>REJECT[: ]*//')"
  echo "REJECT:${REASON:- did not meet acceptance criteria}" > "$VERDICT_FILE"
fi
exit 0
