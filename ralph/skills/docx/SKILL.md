---
name: docx
description: Create or edit Microsoft Word (.docx) documents — reports, letters, formatted write-ups — as a downloadable file. Use for any "document", "report", "write-up", or "Word doc" deliverable. Works with any coding agent (claude, codex, gemini, qwen): plain Python, no agent-specific tooling.
---

# Build a .docx deliverable

Produce a real Word file with `python-docx`. This is model-agnostic — every step is a
shell command, so any agent can run it.

## Setup
```bash
pip3 install --user python-docx        # add python-docx to requirements.txt
```

## Minimal generator (`make_doc.py`)
```python
from docx import Document
from docx.shared import Pt

doc = Document()
doc.add_heading("Title Here", level=0)
doc.add_paragraph("Intro paragraph.")
doc.add_heading("Section", level=1)
doc.add_paragraph("Body text. Use add_paragraph(..., style='List Bullet') for bullets.")

# Table
t = doc.add_table(rows=1, cols=2); t.style = "Light Grid Accent 1"
t.rows[0].cells[0].text = "Key"; t.rows[0].cells[1].text = "Value"

doc.save("out/report.docx")
```
Run it: `mkdir -p out && python3 make_doc.py`.

## Rules
- Commit `make_doc.py` and `requirements.txt`; write the file under `out/` (or the
  project's output dir) and commit the generated `.docx` so it is downloadable.
- Note the path in `progress.txt`. If the project wants an editable/shareable doc
  instead of a download, use the **google-workspace** skill.
