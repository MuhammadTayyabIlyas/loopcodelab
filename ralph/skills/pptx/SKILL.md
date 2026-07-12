---
name: pptx
description: Create PowerPoint (.pptx) slide decks — presentations, pitch decks, lesson slides. Use for any "slides", "deck", or "presentation" deliverable. Works with any coding agent: plain Python, no agent-specific tooling.
---

# Build a .pptx deliverable

Use `python-pptx` — pure pip, identical for claude, codex, gemini, qwen.

## Setup
```bash
pip3 install --user python-pptx        # add to requirements.txt
```

## Minimal generator (`make_deck.py`)
```python
from pptx import Presentation
from pptx.util import Inches, Pt

prs = Presentation()
# Title slide
s = prs.slides.add_slide(prs.slide_layouts[0])
s.shapes.title.text = "Deck Title"
s.placeholders[1].text = "Subtitle / author"

# Bulleted content slide
s = prs.slides.add_slide(prs.slide_layouts[1])
s.shapes.title.text = "Agenda"
tf = s.placeholders[1].text_frame
for i, line in enumerate(["Point one", "Point two", "Point three"]):
    p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
    p.text = line; p.font.size = Pt(20)

prs.save("out/deck.pptx")
```
Run: `mkdir -p out && python3 make_deck.py`.

## Rules
- Commit the generator + `requirements.txt` + the generated `.pptx`.
- One idea per slide; keep bullets short. For a shareable/live deck, use **google-workspace** (Slides).
- Note the output path in `progress.txt`.
