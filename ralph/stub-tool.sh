#!/bin/bash
# Test double for a real coding CLI. Deterministically "implements" the story
# named in $STORY by writing a file and committing it on the current branch,
# then printing the completion promise. Used to validate the loop/orchestrator
# mechanics without spending API credits. NOT used in real runs.
set -uo pipefail
: "${STORY:?stub-tool: STORY env required}"
echo "[stub] implementing $STORY in $(pwd) on branch $(git branch --show-current 2>/dev/null)"
printf '// %s implemented by stub agent at %s\n' "$STORY" "$(date -Is)" >> "stub_${STORY}.js"
git add -A
git commit -q -m "feat: $STORY - stub implementation" && echo "[stub] committed"
echo "<promise>COMPLETE</promise>"
