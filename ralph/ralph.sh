#!/bin/bash
# webtmux Ralph worker loop — adapted from snarktank/ralph (https://github.com/snarktank/ralph)
# for the multi-agent orchestrator.
#
# Differences from upstream:
#   * Scoped to ONE story, run INSIDE that story's git worktree, with one chosen CLI.
#   * Loops up to MAX *attempts* to make that single story pass (the orchestrator
#     runs many of these in parallel, one per story).
#   * The worker NEVER edits prd.json. prd.json is orchestrator-owned on `main`;
#     if every branch edited it, merges would always conflict. The worker only
#     implements + commits code on its branch and prints <promise>COMPLETE</promise>.
#
# Usage: ralph.sh --tool <claude|codex|gemini|qwen|glm|kimi|grok|stub> --story <id> --dir <worktree> [--max N] [--prompt FILE]
set -uo pipefail

TOOL=""; STORY=""; DIR="."; MAX=3; PROMPT_FILE=""; MODEL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tool)   TOOL="$2";        shift 2;;
    --story)  STORY="$2";       shift 2;;
    --dir)    DIR="$2";         shift 2;;
    --max)    MAX="$2";         shift 2;;
    --prompt) PROMPT_FILE="$2"; shift 2;;
    --model)  MODEL="$2";       shift 2;;
    *) shift;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Dry-run override: force a single tool regardless of --tool (e.g. the stub).
[[ -n "${RALPH_FORCE_TOOL:-}" ]] && TOOL="$RALPH_FORCE_TOOL"
[[ -z "$PROMPT_FILE" ]] && PROMPT_FILE="$SCRIPT_DIR/prompt.md"
[[ -z "$TOOL" || -z "$STORY" ]] && { echo "usage: ralph.sh --tool T --story ID --dir DIR [--max N]"; exit 2; }
cd "$DIR" 2>/dev/null || { echo "ralph: no such dir: $DIR"; exit 2; }

PROGRESS="progress.txt"
[[ -f "$PROGRESS" ]] || printf '# Ralph Progress Log\nStarted: %s\n---\n' "$(date)" > "$PROGRESS"

# Compose the prompt: a dynamic header that pins the worker to its one story,
# followed by the shared worker instructions.
read -r -d '' HEADER <<EOF || true
You are the '$TOOL' coding agent in an autonomous multi-agent build.
Work ONLY on the user story with id "$STORY" in ./prd.json (it is assigned to you).
Do NOT modify prd.json — it is owned by the orchestrator.
Implement the story, run the project's quality checks, and commit your code with
  git commit -m "feat: $STORY - <title>"
When the story's acceptance criteria are met and committed, end your reply with the
exact line: <promise>COMPLETE</promise>
EOF
# On a retry the orchestrator passes the master's reject reason so the worker can
# address it directly.
if [[ -n "${RALPH_REVIEW_NOTE:-}" ]]; then
  HEADER="$HEADER"$'\n'"The master REJECTED your last attempt: ${RALPH_REVIEW_NOTE}. Fix this."
fi
# The orchestrator may write a per-story brief (assigned skills' SKILL.md text,
# available MCP tools, and the intended output format). Inject it so the agent
# knows which skill/tool to use and how to present the result.
if [[ -n "${RALPH_SKILLS_FILE:-}" && -f "${RALPH_SKILLS_FILE}" ]]; then
  HEADER="$HEADER"$'\n\n'"## Skills, tools and intended output for this story"$'\n'"$(cat "$RALPH_SKILLS_FILE" 2>/dev/null)"
fi
PROMPT_TEXT="$HEADER"$'\n\n'"$(cat "$PROMPT_FILE" 2>/dev/null)"

# Bypass (dangerous-skip / yolo) is ON by default — autonomous agents can't answer
# permission prompts. RALPH_BYPASS=0 turns it off (the agent will likely stall on a
# prompt; surfaced as a stall the master then reviews).
BYPASS="${RALPH_BYPASS:-1}"
bypass_flag=""
if [[ "$BYPASS" == "1" ]]; then
  case "$TOOL" in
    claude|glm)       bypass_flag="--dangerously-skip-permissions" ;;
    codex)            bypass_flag="--sandbox danger-full-access" ;;
    gemini|qwen|vibe) bypass_flag="--yolo" ;;
    grok)        bypass_flag="--always-approve" ;;
    # kimi: -p (prompt) mode is autonomous by default and REJECTS --yolo/--auto
    # ("Cannot combine --prompt with --yolo"), so it takes no bypass flag here.
  esac
fi

# Optional per-role model (set by the orchestrator in solo runs). Empty => CLI default.
model_flag=(); [[ -n "$MODEL" ]] && model_flag=(--model "$MODEL")

# Run the chosen CLI non-interactively, prompt on stdin or via -p as each expects.
run_tool() {
  case "$TOOL" in
    claude) printf '%s' "$PROMPT_TEXT" | claude $bypass_flag "${model_flag[@]}" --print ;;
    glm)    node "$SCRIPT_DIR/direct.mjs" --story "$STORY" --dir "$DIR" ;; # direct API, not agentic CLI
    codex)  printf '%s' "$PROMPT_TEXT" | codex exec $bypass_flag "${model_flag[@]}" - ;;
    gemini) gemini $bypass_flag "${model_flag[@]}" -p "$PROMPT_TEXT" ;;
    qwen)   qwen $bypass_flag "${model_flag[@]}" -p "$PROMPT_TEXT" ;;
    kimi)   kimi "${model_flag[@]}" -p "$PROMPT_TEXT" ;; # -p is autonomous by default; NO --yolo (key via ~/.kimi-code/config.toml)
    grok)   grok $bypass_flag --no-auto-update "${model_flag[@]}" -p "$PROMPT_TEXT" ;; # key via XAI_API_KEY env
    vibe)   vibe $bypass_flag --trust -p "$PROMPT_TEXT" ;; # --trust required for non-interactive (key via MISTRAL_API_KEY)
    stub)   STORY="$STORY" bash "$SCRIPT_DIR/stub-tool.sh" ;;
    *) echo "ralph: unknown tool '$TOOL'" >&2; return 2 ;;
  esac
}

echo "Ralph [$TOOL] story=$STORY dir=$DIR branch=$(git branch --show-current 2>/dev/null) max=$MAX"
for ((i=1; i<=MAX; i++)); do
  echo ""
  echo "=============================================================="
  echo "  Ralph [$TOOL] story $STORY — attempt $i of $MAX"
  echo "=============================================================="
  OUTPUT="$(run_tool 2>&1 | tee /dev/stderr)" || true
  if grep -q '<promise>COMPLETE</promise>' <<<"$OUTPUT"; then
    echo ""
    echo "Story $STORY complete on attempt $i."
    exit 0
  fi
  echo "Attempt $i did not complete story $STORY. Retrying..."
  sleep 2
done

echo ""
echo "Story $STORY did not complete in $MAX attempts (stalled) — escalating to master review."
exit 1
