#!/bin/bash
# One-shot codebase research pass over an adopted project. Writes RESEARCH.md and then
# "PASS"/"FAIL" to the result file, exits 0. RALPH_FORCE_TOOL=stub => placeholder + PASS.
# Usage: ralph-research.sh --tool T --dir PROJECT_DIR --result FILE [--model M]
set -uo pipefail
TOOL=""; DIR="."; RESULT_FILE=""; MODEL=""
while [[ $# -gt 0 ]]; do case "$1" in
  --tool) TOOL="$2"; shift 2;; --dir) DIR="$2"; shift 2;;
  --result) RESULT_FILE="$2"; shift 2;; --model) MODEL="$2"; shift 2;; *) shift;;
esac; done
[[ -n "${RALPH_FORCE_TOOL:-}" ]] && TOOL="$RALPH_FORCE_TOOL"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR" 2>/dev/null || { echo "FAIL" > "$RESULT_FILE"; exit 0; }
mkdir -p "$(dirname "$RESULT_FILE")"

if [[ "$TOOL" == "stub" ]]; then
  printf '# RESEARCH.md (stub)\n\nSummary: stub research for %s.\n' "$DIR" > RESEARCH.md
  echo "[stub-research] PASS"; echo "PASS" > "$RESULT_FILE"; exit 0
fi

PROMPT="Project directory (existing code): $DIR"$'\n\n'"$(cat "$SCRIPT_DIR/research.md" 2>/dev/null)"
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
OUT="$(run_master 2>&1)" || true
# Success = RESEARCH.md exists (the promise line is best-effort).
if [[ -f RESEARCH.md ]]; then echo "PASS" > "$RESULT_FILE"; else echo "FAIL" > "$RESULT_FILE"; fi
exit 0
