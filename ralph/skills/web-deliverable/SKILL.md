---
name: web-deliverable
description: Produce output that serves correctly at https://<project>.tayyabcheema.com — a static site (preferred) or a server app on $PORT. Use for any "web app", "site", "dashboard", or "live view" deliverable. The single source of truth for this project's deploy contract; works with any agent.
---

# Serve a live web deliverable

The finished project is served at `https://<project>.tayyabcheema.com`. The host serves,
in order: static build output → a server app → a file browser. Target one of the first two.

## Static (preferred — use whenever possible)
Emit the final HTML/CSS/JS into ONE of these (first found wins):
`build/web` → `dist` → `build` → `out` → `public` → a root `index.html`.
- Plain static site: put `index.html` at the repo root.
- Framework with a build step: configure it to output to `dist`/`build`, and add a story/
  step that actually runs the build so the output is committed or reproducible.
- SPA: the host falls back to `index.html` for unknown routes — relative asset paths only.

## Server app (only if a running process is required)
- The app MUST listen on the port in env var `PORT`, e.g.
  `app.listen(process.env.PORT)` (Node) / `--port $PORT` (Flask/uvicorn).
- Add a root `webtmux.json`:
  ```json
  {"type":"server","command":"npm start","install":"npm install"}
  ```
  (or the Python equivalent, e.g. `"command":"python app.py","install":"pip3 install --user -r requirements.txt"`).

## Rules
- Use ONLY runtimes already installed on the box (no sudo). Project-level packages via
  npm/pip are fine; system runtimes/SDKs are not — don't pick a stack that needs one.
- Keep assets relative; don't hardcode `localhost:<port>` — go through `$PORT`.
- Record which output mode you used (static dir or server) in `progress.txt`.
