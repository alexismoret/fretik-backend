"""Reusable helpers for the docx skill.

Import via:
    import sys; sys.path.insert(0, "skills/docx/scripts")
    import docx_helpers as dh
"""

from docx.document import Document as _Document
from docx.shared import Pt, RGBColor
from docx.text.paragraph import Paragraph


_FOOTNOTE_GRAY = RGBColor(0x80, 0x80, 0x80)


def set_body_defaults(
    doc: _Document,
    font: str = "Calibri",
    size: int = 11,
) -> None:
    """Set the document-wide defaults for the `Normal` style.

    Affects every paragraph that inherits from `Normal` (i.e. most
    body text) — headings have their own styles and are untouched.
    """
    normal = doc.styles["Normal"]
    normal.font.name = font
    normal.font.size = Pt(size)


def add_header_footer(
    doc: _Document,
    header_text: str | None = None,
    footer_text: str | None = None,
) -> None:
    """Populate the first section's header and/or footer with plain text."""
    section = doc.sections[0]
    if header_text is not None:
        section.header.paragraphs[0].text = header_text
    if footer_text is not None:
        section.footer.paragraphs[0].text = footer_text


def add_inline_citation(paragraph: Paragraph, source_line: str) -> None:
    """Append an italic-gray source run to the end of `paragraph`.

    Use at the tail of a sentence that makes a claim grounded in a
    specific data source. Keeps the citation unobtrusive (9pt,
    italic, medium gray) while remaining copy-pasteable.
    """
    run = paragraph.add_run(f" {source_line}")
    run.italic = True
    run.font.size = Pt(9)
    run.font.color.rgb = _FOOTNOTE_GRAY
