#!/bin/bash
# Master finalize/compile pass over the whole project on `main`. Writes "PASS" or
# "FAIL" to the result file, then exits 0. RALPH_FORCE_TOOL=stub => always PASS.
# Usage: ralph-finalize.sh --tool T --dir PROJECT_DIR --result FILE
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
  echo "[stub-finalize] PASS"; echo "PASS" > "$RESULT_FILE"; exit 0
fi

PROMPT="Project worktree (main): $DIR"$'\n\n'"$(cat "$SCRIPT_DIR/finalize.md" 2>/dev/null)"
# Append the deliverable-format brief (chosen output format + backing skill/tool
# instructions) if the orchestrator wrote one.
if [[ -n "${RALPH_SKILLS_FILE:-}" && -f "${RALPH_SKILLS_FILE}" ]]; then
  PROMPT="$PROMPT"$'\n\n'"$(cat "$RALPH_SKILLS_FILE" 2>/dev/null)"
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
OUT="$(run_master 2>&1)" || true
if grep -q '<promise>COMPLETE</promise>' <<<"$OUT"; then echo "PASS" > "$RESULT_FILE"; else echo "FAIL" > "$RESULT_FILE"; fi
exit 0
