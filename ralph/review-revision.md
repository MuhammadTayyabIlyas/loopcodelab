<!-- ralph/review-revision.md — appended to review.md when ralph-review.sh gets --revision 1 -->
## Revision review — this story revises a FINISHED, already-accepted app

Judge the DIFF against the story's instruction — not the whole app against a
fresh production bar. The app already passed review once; your job is to check
the *change*.

- Verify the requested change is present and correct (`git diff main...<branch>`).
- Still run the build/smoke gates from step 3 — a broken build or blank page is
  an automatic REJECT, exactly as before.
- REJECT only with concrete evidence: a failing command plus its key error
  line, or a named acceptance criterion plus what you observed instead. If you
  cannot verify a criterion by inspecting the diff or running a gate, do NOT
  reject on it.
- Pre-existing imperfections OUTSIDE the diff are NOT grounds to reject —
  mention them in prose if notable, then ACCEPT.
