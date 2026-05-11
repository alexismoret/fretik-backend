---
name: pdf
description: Generate print-ready PDFs with reportlab — either flowing multi-page reports (Platypus) or pixel-deliberate templates (canvas), with tables, page numbers, headers, footers, and embedded images. Use when the deliverable should be laid out for print or distribution rather than editing.
---

# pdf skill

Deliver a PDF that prints cleanly, has automatic pagination, carries real structure (headings, tables, page numbers), and isn't an accident — meaning it's pixel-deliberate when the use case is a template (invoice, certificate) and flow-laid-out when the use case is a multi-page report.

## When to use this skill

Trigger on: "PDF", "export PDF", "print", "imprimer", "facture", "invoice", "bon de livraison", "certificate", "certificat", "courrier", "lettre", "rapport imprimable", and similar asks for a non-editable final artefact.

Don't use for: a document the user will edit (→ `docx`), a numeric deliverable (→ `xlsx`), a slide deck (→ `pptx`), or a chart-only visual (→ `data-viz`).

## The reportlab decision: Platypus OR canvas

reportlab offers two generation models. Pick deliberately:

| Use case                                                                                                                          | Use                                                                             | Why                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-page flowing report (executive summary, narrative, tables, figures)                                                         | **Platypus** (`SimpleDocTemplate`, `Paragraph`, `Table`, `Spacer`, `PageBreak`) | Flows content across pages automatically, handles pagination, re-flows when tables split mid-page.                                                         |
| Invoice, certificate, shipping label, delivery note, anything with a fixed visual template where every element has a specific x/y | **canvas** (`reportlab.pdfgen.canvas.Canvas`)                                   | You control every pixel. Fixed boxes for logo, header, line items, totals, signature.                                                                      |
| Hybrid (a canvas overlay of static elements behind a Platypus flowable)                                                           | **Platypus with a custom `onPage` callback**                                    | `SimpleDocTemplate`'s `onFirstPage`/`onLaterPages` callbacks give you a `canvas` to draw page chrome (header bar, logo, page number) on top of every page. |

If you're unsure, default to Platypus. It's the right tool for 80% of real requests.

## Platypus — flowing reports

```python
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, Image,
)

doc = SimpleDocTemplate(
    "monthly-carrier-review-2026-03.pdf",
    pagesize=A4,
    leftMargin=2 * cm,
    rightMargin=2 * cm,
    topMargin=2 * cm,
    bottomMargin=2 * cm,
    title="Monthly carrier review — March 2026",
    author="Fretik",
)

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="BodyJustified",
    parent=styles["BodyText"],
    alignment=4,          # 0=L, 1=C, 2=R, 4=justify
    leading=14,
))
styles.add(ParagraphStyle(
    name="Source",
    parent=styles["BodyText"],
    fontName="Helvetica-Oblique",
    textColor=colors.HexColor("#808080"),
    fontSize=8,
    leading=10,
    spaceBefore=4,
))

story = []
story.append(Paragraph("Monthly carrier review — March 2026", styles["Title"]))
story.append(Spacer(1, 0.4 * cm))
story.append(Paragraph(
    "This report summarises shipment volumes, on-time performance, and "
    "cost variance across the top ten carriers for March 2026. Data was "
    "pulled from Fretik's internal database as of 2026-04-21.",
    styles["BodyJustified"],
))
story.append(Spacer(1, 0.6 * cm))

story.append(Paragraph("Headline numbers", styles["Heading2"]))
headline = [
    ["KPI", "March 2026", "Δ vs. February"],
    ["Volume (TEU)", "5,487", "+4.1%"],
    ["On-time rate", "91.2%", "+0.8 pts"],
    ["Average transit time", "18.2 days", "-0.5 d"],
    ["Cost variance vs. contract", "+1.9%", "+0.3 pts"],
]
t = Table(headline, hAlign="LEFT", colWidths=[6 * cm, 4 * cm, 4 * cm])
t.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F4E78")),
    ("TEXTCOLOR",  (0, 0), (-1, 0), colors.white),
    ("FONTNAME",   (0, 0), (-1, 0), "Helvetica-Bold"),
    ("ALIGN",      (1, 0), (-1, -1), "RIGHT"),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1),
        [colors.white, colors.HexColor("#F2F6FA")]),
    ("GRID",       (0, 0), (-1, -1), 0.25, colors.HexColor("#BFBFBF")),
    ("VALIGN",     (0, 0), (-1, -1), "MIDDLE"),
    ("LEFTPADDING",  (0, 0), (-1, -1), 6),
    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ("TOPPADDING",   (0, 0), (-1, -1), 4),
    ("BOTTOMPADDING",(0, 0), (-1, -1), 4),
]))
story.append(t)
story.append(Spacer(1, 0.3 * cm))
story.append(Paragraph(
    "Source: querySql — shipments + contracts, as of 2026-04-21 09:00 Europe/Paris.",
    styles["Source"],
))

# Next section on a fresh page
story.append(PageBreak())
story.append(Paragraph("By carrier", styles["Heading2"]))
# …more flowables…

doc.build(story)
print("saved monthly-carrier-review-2026-03.pdf")
```

Then:

```
presentFiles({ paths: ["monthly-carrier-review-2026-03.pdf"], message: "Rapport mensuel transporteurs (PDF)." })
```

### Page chrome via callbacks

```python
def _page_chrome(canvas, doc):
    canvas.saveState()
    # Header bar
    canvas.setFillColor(colors.HexColor("#1F4E78"))
    canvas.rect(0, A4[1] - 1.2 * cm, A4[0], 1.2 * cm, fill=1, stroke=0)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 10)
    canvas.drawString(2 * cm, A4[1] - 0.8 * cm, "Fretik — Monthly carrier review")
    # Footer: page number
    canvas.setFillColor(colors.HexColor("#808080"))
    canvas.setFont("Helvetica", 9)
    canvas.drawRightString(
        A4[0] - 2 * cm,
        1.2 * cm,
        f"Page {doc.page}",
    )
    canvas.restoreState()

doc.build(story, onFirstPage=_page_chrome, onLaterPages=_page_chrome)
```

### Tables that split across pages

`Table(..., splitByRow=1, repeatRows=1)` lets a long table flow across pages, repeating the header row at the top of each continuation.

```python
t = Table(rows, colWidths=[...], repeatRows=1, splitByRow=1)
```

## canvas — pixel-deliberate layouts

Use for invoices, certificates, labels, anything template-like. The canvas is a grid; you place every element by coordinates (origin is bottom-left).

```python
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm, mm
from reportlab.lib import colors
from reportlab.pdfgen import canvas as rl_canvas

w, h = A4
c = rl_canvas.Canvas("invoice-2026-04-0173.pdf", pagesize=A4)
c.setTitle("Invoice 2026-04-0173")

# Company block (top-left)
c.setFont("Helvetica-Bold", 14)
c.drawString(2 * cm, h - 2 * cm, "Fretik SAS")
c.setFont("Helvetica", 10)
c.drawString(2 * cm, h - 2.6 * cm, "12 rue des Ports, 75012 Paris")
c.drawString(2 * cm, h - 3.0 * cm, "SIREN 900 123 456 — VAT FR 12 900123456")

# Invoice block (top-right)
c.setFont("Helvetica-Bold", 16)
c.drawRightString(w - 2 * cm, h - 2 * cm, "INVOICE")
c.setFont("Helvetica", 10)
c.drawRightString(w - 2 * cm, h - 2.6 * cm, "No. 2026-04-0173")
c.drawRightString(w - 2 * cm, h - 3.0 * cm, "Date: 2026-04-21")
c.drawRightString(w - 2 * cm, h - 3.4 * cm, "Due: 2026-05-21")

# Client block (left, mid-page)
c.setFont("Helvetica-Bold", 11)
c.drawString(2 * cm, h - 5.5 * cm, "Bill to")
c.setFont("Helvetica", 10)
c.drawString(2 * cm, h - 6.0 * cm, "ACME Logistics SA")
c.drawString(2 * cm, h - 6.4 * cm, "44 Haven Road, Antwerp 2030")
c.drawString(2 * cm, h - 6.8 * cm, "VAT BE 0234 567 890")

# Line items — draw a table by hand for a fixed template
c.setFillColor(colors.HexColor("#1F4E78"))
c.rect(2 * cm, h - 10 * cm, w - 4 * cm, 0.8 * cm, fill=1, stroke=0)
c.setFillColor(colors.white)
c.setFont("Helvetica-Bold", 10)
c.drawString(2.2 * cm, h - 9.5 * cm, "Description")
c.drawRightString(13 * cm, h - 9.5 * cm, "Qty")
c.drawRightString(16 * cm, h - 9.5 * cm, "Unit price")
c.drawRightString(w - 2.2 * cm, h - 9.5 * cm, "Line total")

c.setFillColor(colors.black)
c.setFont("Helvetica", 10)
y = h - 11 * cm
for line in [
    ("Ocean freight Antwerp → Shanghai (40'HC)", 4, 1250.0, 5000.0),
    ("Inland haulage Shanghai → Suzhou",         4,  180.0,  720.0),
    ("Customs clearance fee",                    4,   60.0,  240.0),
]:
    desc, qty, unit, total = line
    c.drawString(2.2 * cm, y, desc)
    c.drawRightString(13 * cm, y, f"{qty}")
    c.drawRightString(16 * cm, y, f"{unit:,.2f} €")
    c.drawRightString(w - 2.2 * cm, y, f"{total:,.2f} €")
    y -= 0.7 * cm

# Totals
c.line(2 * cm, y - 0.2 * cm, w - 2 * cm, y - 0.2 * cm)
y -= 0.8 * cm
c.setFont("Helvetica-Bold", 11)
c.drawRightString(16 * cm, y, "Subtotal")
c.drawRightString(w - 2.2 * cm, y, f"{5960.0:,.2f} €")
y -= 0.6 * cm
c.drawRightString(16 * cm, y, "VAT (20%)")
c.drawRightString(w - 2.2 * cm, y, f"{1192.0:,.2f} €")
y -= 0.8 * cm
c.setFont("Helvetica-Bold", 12)
c.drawRightString(16 * cm, y, "Total")
c.drawRightString(w - 2.2 * cm, y, f"{7152.0:,.2f} €")

# Footer
c.setFont("Helvetica", 8)
c.setFillColor(colors.HexColor("#808080"))
c.drawString(
    2 * cm, 1.5 * cm,
    "Payment by IBAN FR76 3000 4000 0100 0000 0000 012 — BIC BNPAFRPP — "
    "Reference: 2026-04-0173"
)

c.showPage()
c.save()
```

## Styling: colors, fonts, grid

### Colors — default palette

| Role                            | Hex      | Notes                                    |
| ------------------------------- | -------- | ---------------------------------------- |
| Primary (header bars, headings) | `1F4E78` | Deep blue                                |
| Secondary (accent)              | `2E75B6` | Lighter blue                             |
| Body text                       | `000000` | Black — PDF renders near-black naturally |
| Muted / source                  | `808080` | Gray for footnotes and source lines      |
| Alternating row                 | `F2F6FA` | Very pale blue                           |
| Total row                       | `D9E2EC` | Slightly darker                          |
| Warning                         | `C0504D` | Muted red                                |
| Success                         | `548235` | Muted green                              |

```python
colors.HexColor("#1F4E78")
```

### Fonts

Default to Helvetica (shipped with every PDF reader) at sizes:

- Title: 18pt bold
- H1 / section: 14pt bold
- H2: 12pt bold
- Body: 10pt
- Table body: 9pt
- Caption / source: 8pt italic

For multilingual content with diacritics (é, ñ, ß) Helvetica is fine. For CJK, register a DejaVu or Noto font explicitly:

```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
pdfmetrics.registerFont(TTFont("Noto", "/usr/share/fonts/noto/NotoSans-Regular.ttf"))
```

### Margins and grid

Default A4 with 2 cm margins all around. For dense reports, drop to 1.5 cm. Never go below 1 cm — printers clip edges.

## Sources

- Platypus: append a `Paragraph` with the `Source` style (8pt Helvetica-Oblique gray) one line below the data it annotates.
- canvas: `c.setFont("Helvetica-Oblique", 8)` + `c.setFillColor(colors.HexColor("#808080"))` + `c.drawString(...)` below the block.

Canonical line:

```
Source: [System/Document], [Date], [Specific Reference], [URL if applicable]
```

## Code style

- Build the `story` list top-to-bottom, then call `doc.build(story)` once. Don't interleave build calls.
- Use `cm`/`mm` units, not raw points. `2 * cm` is unambiguous; `56` is not.
- For canvas, group related draws between `c.saveState()` / `c.restoreState()` so color/font settings don't leak into later blocks.
- Filename: kebab-case, dated, descriptive (`invoice-2026-04-0173.pdf`, `monthly-carrier-review-2026-03.pdf`).
- Page size A4 for Europe, Letter for US; pick based on the user's context.

## Reusable helpers

`scripts/pdf_helpers.py` ships:

- `make_platypus_doc(filename, title, author="Fretik", pagesize=A4)` — returns a `SimpleDocTemplate` with our standard margins and metadata.
- `standard_styles()` — returns a `StyleSheet1` extended with `BodyJustified`, `Source`, and `TableHeader` styles.
- `draw_page_chrome(canvas, doc, title)` — reusable `onFirstPage`/`onLaterPages` callback.
- `styled_table(rows, col_widths, has_header=True, has_totals_row=False)` — returns a `Table` with the canonical banded style.

Import:

```python
import sys; sys.path.insert(0, "skills/pdf/scripts")
import pdf_helpers as ph

doc = ph.make_platypus_doc("report.pdf", "Monthly carrier review — March 2026")
styles = ph.standard_styles()
story = [...]
doc.build(story, onFirstPage=lambda c, d: ph.draw_page_chrome(c, d, "Fretik"),
                 onLaterPages=lambda c, d: ph.draw_page_chrome(c, d, "Fretik"))
```

## Common pitfalls

- **Text runs off the page.** In Platypus, use `Paragraph` (flows) instead of `Canvas.drawString`. In canvas, compute your y manually and check against `2 * cm` (bottom margin).
- **Characters render as black rectangles.** Your font doesn't cover those glyphs (typically for non-Latin scripts). Register a broader font.
- **Table rows get cut mid-page in Platypus.** Set `Table(..., splitByRow=1, repeatRows=1)` or `KeepTogether` small sub-tables.
- **Nothing appears in the PDF.** You forgot `c.showPage()` + `c.save()` for canvas, or `doc.build(story)` for Platypus.
- **Page numbers wrong.** Use `doc.page` inside the `onLaterPages` callback — it's the correct counter.
- **Hard-coded coordinates in canvas break on Letter when you meant A4.** Always reference `w, h = pagesize` and use relative offsets.
- **`drawString` clips text.** `drawString` doesn't wrap. Use `Paragraph` inside a `Frame`, or pre-wrap the string.
- **File is huge because of an uncompressed image.** Pass `preserveAspectRatio=True` and appropriate `width`/`height` to `Image(...)`; the PDF writer will embed a sensible raster.

## Further reading

- `references/platypus-flowables.md` — exhaustive flowable catalogue (KeepInFrame, KeepTogether, BalancedColumns, …).
- `references/canvas-recipes.md` — ready-to-paste recipes for delivery note, packing list, shipping label, certificate.

Load via `read("skills/pdf/references/<name>.md")` when the user's scenario needs it.
