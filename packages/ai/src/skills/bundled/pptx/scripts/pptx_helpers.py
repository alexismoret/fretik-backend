"""Reusable helpers for the pptx skill.

Import via:
    import sys; sys.path.insert(0, "skills/pptx/scripts")
    import pptx_helpers as ph
"""

from pptx.dml.color import RGBColor
from pptx.presentation import Presentation as _Presentation
from pptx.slide import Slide
from pptx.util import Inches, Pt


_SOURCE_GRAY = RGBColor(0x80, 0x80, 0x80)


def add_title_slide(
    prs: _Presentation,
    title: str,
    subtitle: str | None = None,
) -> Slide:
    """Add a deck cover (Title Slide layout) and return it."""
    slide = prs.slides.add_slide(prs.slide_layouts[0])
    slide.shapes.title.text = title
    if subtitle is not None:
        slide.placeholders[1].text = subtitle
    return slide


def add_bullets_slide(
    prs: _Presentation,
    title: str,
    bullets: list[str],
    bullet_font_size: int = 18,
) -> Slide:
    """Add a Title-and-Content slide with a list of bullets.

    The first bullet populates the placeholder's default paragraph;
    subsequent bullets are appended as new top-level paragraphs.
    """
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = title
    body = slide.placeholders[1]
    tf = body.text_frame
    if not bullets:
        return slide
    tf.text = bullets[0]
    for line in bullets[1:]:
        p = tf.add_paragraph()
        p.text = line
        p.level = 0
        p.font.size = Pt(bullet_font_size)
    return slide


def add_source_box(
    slide: Slide,
    text: str,
    *,
    left_in: float = 0.3,
    top_in: float = 6.8,
    width_in: float = 9.4,
    height_in: float = 0.4,
) -> None:
    """Append a right-aligned italic-gray source line at the bottom of `slide`.

    Defaults assume the standard 10-inch-wide 7.5-inch-tall slide and
    leave a small margin from the edges.
    """
    box = slide.shapes.add_textbox(
        Inches(left_in),
        Inches(top_in),
        Inches(width_in),
        Inches(height_in),
    )
    tf = box.text_frame
    tf.text = text
    p = tf.paragraphs[0]
    p.alignment = 3  # right
    run = p.runs[0]
    run.italic = True
    run.font.size = Pt(10)
    run.font.color.rgb = _SOURCE_GRAY
