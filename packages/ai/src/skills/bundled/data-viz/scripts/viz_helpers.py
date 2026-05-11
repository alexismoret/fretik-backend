"""Reusable helpers for the data-viz skill.

Import via:
    import sys; sys.path.insert(0, "skills/data-viz/scripts")
    import viz_helpers as vz
"""

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402


def apply_house_style(ax) -> None:
    """Hide top/right spines and draw a dashed horizontal grid."""
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.grid(True, axis="y", linestyle="--", linewidth=0.5, alpha=0.6)


def add_source(fig, text: str) -> None:
    """Write the canonical italic-gray source line at (0.01, 0.01)."""
    fig.text(
        0.01,
        0.01,
        text,
        fontsize=8,
        style="italic",
        color="#808080",
    )


def annotate_bars(ax, bars, values, fmt: str = "{:,}") -> None:
    """Add a value label on top of each bar at fixed pixel offset."""
    for bar, v in zip(bars, values):
        ax.annotate(
            fmt.format(v),
            (bar.get_x() + bar.get_width() / 2, v),
            textcoords="offset points",
            xytext=(0, 6),
            ha="center",
            fontsize=9,
            color="#222222",
        )


def save_and_close(fig, filename: str, dpi: int = 160) -> None:
    """Tight layout, savefig with bbox_inches='tight', close."""
    fig.tight_layout()
    fig.savefig(filename, dpi=dpi, bbox_inches="tight")
    plt.close(fig)
