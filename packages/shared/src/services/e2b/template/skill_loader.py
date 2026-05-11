# Fretik skill loader — pre-installed in the E2B template at /opt/fretik/.
# Auto-imported via /opt/fretik on sys.path (set up by fretik-skills.pth).
# Stable across all conversations; bundled skills themselves are pushed
# per-conversation by `lib/conversation-storage.ts` to /workspace/skills/.

import os
import sys

SKILLS_ROOT = "/workspace/skills"


def load_skill(name: str) -> str:
    """Add /workspace/skills/<name>/scripts to sys.path and return its path.

    Raises FileNotFoundError when the skill has no scripts/ directory.
    """
    scripts_dir = os.path.join(SKILLS_ROOT, name, "scripts")
    if not os.path.isdir(scripts_dir):
        raise FileNotFoundError(
            f"Skill '{name}' has no scripts/ directory at {scripts_dir}"
        )
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    return scripts_dir


def list_skills() -> list[str]:
    """Return the names of every bundled skill present in /workspace/skills."""
    if not os.path.isdir(SKILLS_ROOT):
        return []
    return sorted(
        entry
        for entry in os.listdir(SKILLS_ROOT)
        if os.path.isdir(os.path.join(SKILLS_ROOT, entry))
        and not entry.startswith(".")
    )


def skill_path(name: str, *parts: str) -> str:
    """Build an absolute path inside a skill's directory.

    Convenience for reading bundled assets from a skill, e.g.
    `skill_path("xlsx", "references", "format-cheatsheet.md")`.
    """
    return os.path.join(SKILLS_ROOT, name, *parts)
