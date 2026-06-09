import { listActiveProviderKeysForConversation } from "@fretik/shared/services/external-apps/connections/list-active-providers-for-conversation";
import { listEnabledTeamUploadedSkillsWithBodyForConversation } from "@fretik/shared/services/skills/list-enabled-team-uploaded-with-body";
import { resolve, sep } from "node:path";
import { materializeTeamSkillMd } from "./materialize-team-skill";
import { BUNDLED_SKILLS_DIR, EXTERNAL_APP_SKILLS_DIR } from "./paths";

/**
 * Bun-side reader for files under `/workspace/skills/` — no E2B round
 * trip. Skill bodies and their reference/script files originate
 * entirely server-side:
 *
 *  - **bundled**  → on disk at `bundled/<name>/...` (this package).
 *  - **provider** → on disk at `sandbox-assets/skills/<providerKey>/...`,
 *                   served only for providers active on this conversation.
 *  - **team**     → the SKILL.md body lives in the `skills` DB row;
 *                   reference/script files are not supported (none ship).
 *
 * Mirrors the visibility the sandbox bootstrap would produce: the full
 * bundled tree is pushed for every conversation (no per-team gate), so
 * we serve any bundled file unconditionally; provider skills are pushed
 * only for active providers; team skills only when enabled.
 *
 * Returns the file's UTF-8 text, or `null` when the path resolves to no
 * readable skill file (caller maps that to a not-found error). Path
 * traversal is already blocked upstream by `resolveWorkspacePath`; the
 * containment check here is defense-in-depth.
 */

/**
 * Join a skill-relative path under a base dir, returning `null` if the
 * result escapes the base (belt-and-suspenders against traversal).
 */
const safeJoinUnder = (baseDir: string, segments: string[]): string | null => {
  const candidate = resolve(baseDir, ...segments);
  if (candidate !== baseDir && !candidate.startsWith(baseDir + sep)) {
    return null;
  }
  return candidate;
};

export const readSkillWorkspaceFile = async (
  conversationId: string,
  relativePath: string,
): Promise<string | null> => {
  // Expect `skills/<name>/<file...>` with at least one file segment.
  const parts = relativePath.split("/");
  if (parts[0] !== "skills" || parts.length < 3) return null;
  const skillName = parts[1];
  const fileSegments = parts.slice(2);
  if (skillName === undefined || skillName.length === 0) return null;

  // 1. Bundled (disk, no gating — the whole bundled tree is always present).
  const bundledPath = safeJoinUnder(BUNDLED_SKILLS_DIR, [
    skillName,
    ...fileSegments,
  ]);
  if (bundledPath) {
    const file = Bun.file(bundledPath);
    if (await file.exists()) return file.text();
  }

  // 2. Provider (disk + active-provider gate).
  const providerPath = safeJoinUnder(EXTERNAL_APP_SKILLS_DIR, [
    skillName,
    ...fileSegments,
  ]);
  if (providerPath) {
    const file = Bun.file(providerPath);
    if (await file.exists()) {
      const activeProviders =
        await listActiveProviderKeysForConversation(conversationId);
      if (activeProviders.includes(skillName)) return file.text();
    }
  }

  // 3. Team-uploaded (DB body → materialised SKILL.md). Only SKILL.md
  // is materialised for team skills; they ship no reference/script files.
  if (fileSegments.length === 1 && fileSegments[0] === "SKILL.md") {
    const teamSkills =
      await listEnabledTeamUploadedSkillsWithBodyForConversation(
        conversationId,
      );
    const entry = teamSkills.find((skill) => skill.name === skillName);
    if (entry) return materializeTeamSkillMd(entry);
  }

  return null;
};
