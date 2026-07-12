---
name: google-workspace
description: Create LIVE, shareable Google Docs, Sheets, and Slides (and Drive uploads, Gmail drafts, Calendar events) via the connected MCP tools — Google OAuth is already authorized. Use when the deliverable should be an editable, shareable Google file with a link, rather than a downloaded file. Works with any agent whose MCP config points at the tayyabcheema MCP gateway (claude, codex, qwen, gemini).
---

# Deliver a live Google Workspace file (via MCP)

The orchestrator writes an MCP config into this worktree, so the connected gateway's
tools are available to you with **no extra auth** (OAuth is already granted). Discover
the exact tool names from your MCP server list at startup; they cover:

- **Google Docs / Sheets / Slides** — create and edit documents.
- **Google Drive** — upload a file and get a shareable link (e.g. host a generated .docx/.pdf).
- **Gmail** — draft/send mail. **Calendar** — create events.

## How to use
1. List your available MCP tools; find the Google Docs/Sheets/Slides/Drive ones.
2. Call the create/edit tool with the content for this story.
3. Capture the returned **file ID and shareable URL**.
4. Write the link into `DELIVERABLE.md` at the repo root (create it if missing) AND into
   `progress.txt`, e.g.:
   ```
   ## Deliverable
   - Google Doc: <title> — <shareable URL>
   ```

## Rules
- This is the right skill when the chosen output is **google-doc / google-sheet /
  google-slides**. For a downloadable file instead, use **docx / xlsx / pptx / pdf**.
- If the MCP tools are not reachable (e.g. an agent without MCP wiring, like the glm
  direct worker), FALL BACK to the matching downloadable skill and note why in `progress.txt`.
- Never print or commit OAuth tokens or secrets — only the resulting shareable link.
