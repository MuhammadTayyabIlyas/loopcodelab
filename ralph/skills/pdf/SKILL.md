---
name: pdf
description: Generate PDF documents — reports, invoices, certificates, printable deliverables. Use when the output must be a downloadable PDF. Works with any coding agent: plain Python, no agent-specific tooling.
---

# Build a PDF deliverable

Two reliable paths — both pure shell/Python, so any agent (claude, codex, gemini, qwen) can run them.

## Path A — HTML → PDF (best for rich layout)
Write clean HTML/CSS, then convert. Prefer `weasyprint` (pure pip, no system browser):
```bash
pip3 install --user weasyprint        # add to requirements.txt
python3 -c "from weasyprint import HTML; HTML('report.html').write_pdf('out/report.pdf')"
```

## Path B — programmatic (best for tables/data, no HTML)
```bash
pip3 install --user reportlab
```
```python
from reportlab.lib.pagesizes import LETTER
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table
from reportlab.lib.styles import getSampleStyleSheet
s = getSampleStyleSheet()
doc = SimpleDocTemplate("out/report.pdf", pagesize=LETTER)
doc.build([Paragraph("Title", s["Title"]), Spacer(1, 12),
           Paragraph("Body text.", s["BodyText"]),
           Table([["Key", "Value"], ["a", "1"]])])
```

## Rules
- `mkdir -p out` first; commit the generator + `requirements.txt` + the generated `.pdf`.
- If `weasyprint` system deps are unavailable (no sudo), fall back to reportlab (Path B).
- Record the output path in `progress.txt`.
