---
name: xlsx
description: Create Microsoft Excel (.xlsx) spreadsheets — datasets, tables, multi-sheet workbooks, formulas, basic formatting. Use for any tabular-data, dataset, or "spreadsheet/Excel" deliverable. Works with any coding agent: plain Python, no agent-specific tooling.
---

# Build an .xlsx deliverable

Use `openpyxl` — pure pip, runs the same for claude, codex, gemini, qwen.

## Setup
```bash
pip3 install --user openpyxl          # add to requirements.txt
```

## Minimal generator (`make_sheet.py`)
```python
from openpyxl import Workbook
from openpyxl.styles import Font

wb = Workbook()
ws = wb.active; ws.title = "Data"
ws.append(["Name", "Qty", "Total"])
for c in ws[1]: c.font = Font(bold=True)
ws.append(["Widget", 3, "=B2*10"])          # formulas work
ws.append(["Gadget", 5, "=B3*10"])

# Second sheet
summary = wb.create_sheet("Summary")
summary["A1"] = "Grand total"; summary["B1"] = "=SUM(Data!C2:C3)"

for col in "ABC": ws.column_dimensions[col].width = 16
wb.save("out/data.xlsx")
```
Run: `mkdir -p out && python3 make_sheet.py`.

## Rules
- Commit the generator + `requirements.txt` + the generated `.xlsx`.
- For a live/shareable spreadsheet instead of a download, use **google-workspace**.
- Note the output path in `progress.txt`.
