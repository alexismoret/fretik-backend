"""Reusable helpers for the pdf skill.

Import via:
    import sys; sys.path.insert(0, "skills/pdf/scripts")
    import pdf_helpers as ph
"""

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, StyleSheet1, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle


def make_platypus_doc(
    filename: str,
    title: str,
    author: str = "Fretik",
    pagesize=A4,
    margin_cm: float = 2.0,
) -> SimpleDocTemplate:
    """Build a SimpleDocTemplate with our standard margins and metadata."""
    return SimpleDocTemplate(
        filename,
        pagesize=pagesize,
        leftMargin=margin_cm * cm,
        rightMargin=margin_cm * cm,
        topMargin=margin_cm * cm,
        bottomMargin=margin_cm * cm,
        title=title,
        author=author,
    )


def standard_styles() -> StyleSheet1:
    """Return a StyleSheet1 extended with our canonical paragraph styles.

    Adds:
      - `BodyJustified` — justified body text with 14pt leading.
      - `Source` — 8pt italic gray for source citations.
      - `TableHeader` — bold white for use inside a dark header cell.
    """
    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="BodyJustified",
            parent=styles["BodyText"],
            alignment=4,  # TA_JUSTIFY
            leading=14,
        )
    )
    styles.add(
        ParagraphStyle(
            name="Source",
            parent=styles["BodyText"],
            fontName="Helvetica-Oblique",
            textColor=colors.HexColor("#808080"),
            fontSize=8,
            leading=10,
            spaceBefore=4,
        )
    )
    styles.add(
        ParagraphStyle(
            name="TableHeader",
            parent=styles["BodyText"],
            fontName="Helvetica-Bold",
            textColor=colors.white,
            fontSize=10,
        )
    )
    return styles


def draw_page_chrome(canvas, doc, title: str) -> None:
    """Reusable onFirstPage / onLaterPages callback.

    Draws a deep-blue header bar with the title on the left and a
    muted-gray page counter in the footer.
    """
    page_w, page_h = doc.pagesize
    canvas.saveState()
    # Header bar
    canvas.setFillColor(colors.HexColor("#1F4E78"))
    canvas.rect(0, page_h - 1.2 * cm, page_w, 1.2 * cm, fill=1, stroke=0)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 10)
    canvas.drawString(2 * cm, page_h - 0.8 * cm, title)
    # Footer page number
    canvas.setFillColor(colors.HexColor("#808080"))
    canvas.setFont("Helvetica", 9)
    canvas.drawRightString(page_w - 2 * cm, 1.2 * cm, f"Page {doc.page}")
    canvas.restoreState()


def styled_table(
    rows: list[list],
    col_widths: list[float],
    has_header: bool = True,
    has_totals_row: bool = False,
) -> Table:
    """Build a Table with the canonical banded style.

    - Header row (if `has_header`): deep blue fill, bold white text.
    - Body: alternating white / very-pale-blue rows.
    - Totals row (if `has_totals_row`): slightly darker fill, bold.
    - 0.25pt gray grid, 6pt horizontal padding, right-aligned numeric cols.
    """
    t = Table(rows, colWidths=col_widths, hAlign="LEFT")
    style: list = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#BFBFBF")),
    ]
    body_start = 0
    if has_header:
        style.extend(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F4E78")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("ALIGN", (1, 0), (-1, 0), "CENTER"),
            ]
        )
        body_start = 1
    body_end = -2 if has_totals_row else -1
    style.append(
        (
            "ROWBACKGROUNDS",
            (0, body_start),
            (-1, body_end),
            [colors.white, colors.HexColor("#F2F6FA")],
        )
    )
    if has_totals_row:
        style.extend(
            [
                (
                    "BACKGROUND",
                    (0, -1),
                    (-1, -1),
                    colors.HexColor("#D9E2EC"),
                ),
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ]
        )
    # Right-align every non-first column (numeric convention).
    if len(col_widths) > 1:
        style.append(("ALIGN", (1, body_start), (-1, -1), "RIGHT"))
    t.setStyle(TableStyle(style))
    return t
