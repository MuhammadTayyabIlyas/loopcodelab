# Master Finalize Instructions

You are the MASTER agent. All story branches have been merged into `main`. Do a
final integration pass on the whole project at the worktree named in the header.

## Steps
1. Review that the merged stories together form a coherent, working project.
2. Install dependencies and run the full build + test suite (detect the right
   commands — e.g. `npm install && npm test`, `npm run build`). Use only installed
   tools (no sudo).
3. Make sure the live output is servable at `https://<project>.tayyabcheema.com`:
   - Static site → ensure built output lands in one of `build/web`, `dist`,
     `build`, `out`, `public`, or a root `index.html` (copy it there if needed).
   - Server app → ensure it listens on `process.env.PORT` and that a root
     `webtmux.json` exists, e.g. `{"type":"server","command":"npm start","install":"npm install"}`.
   Commit whatever you changed.
5. Produce the deliverable in the format the user chose (a brief below this text
   names it and includes the backing skill instructions + any MCP tools):
   - A document/data/slides deliverable → generate the file (`.docx`/`.pdf`/`.xlsx`/
     `.pptx`) OR create the live Google Doc/Sheet/Slides via the MCP tools and
     capture its shareable link. Record the path or link in `DELIVERABLE.md`.
   - A web app → ensure it serves (static output dir or `$PORT` server) per above.
   If the format is `auto`, pick the most fitting presentation for the project.
6. Ensure a clear `README.md` exists at the repo root: what the project is, how to
   run/build it, the project structure, and a pointer to the deliverable. Commit it.
4. Fix any integration problems, build breaks, or failing tests with minimal edits.
4. Commit any fixes with `chore: finalize integration`.

## Verdict
When the project builds and its tests pass (or there is genuinely nothing to
build/test), end your reply with the exact line:

<promise>COMPLETE</promise>

If you could not get it green, end normally without that line.
