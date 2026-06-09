import { and, eq, isNull, or } from "drizzle-orm";
import db from "../../db";
import { skills } from "../../db/schema";
import { listProviderKeys } from "../../external-apps/registry";
import { SKILL_NAME_MAX_LENGTH } from "../../schemas/skills-limits";

/**
 * `pickAvailableSkillSlug` tries `base`, `base-2`, `base-3`, … until
 * a free slug is found. Caps the worst case to avoid an infinite loop
 * in pathological situations (someone scripts creating 1000
 * "skill-N" rows).
 */
const SLUG_DEDUPE_MAX_ATTEMPTS = 100;

/**
 * Derive a SKILL.md-compatible slug from arbitrary input. Strips
 * diacritics (Unicode normalization), lowercases, collapses any run
 * of non-alphanumeric chars into a single hyphen, and trims hyphens
 * at the edges. Truncates to the max name length.
 *
 * Returns the empty string if input collapses to nothing — callers
 * must surface a clear `SKILL_INVALID_NAME` error in that case.
 */
export const slugifySkillName = (raw: string): string => {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_NAME_MAX_LENGTH);
};

/**
 * Resolve a final slug for a new skill belonging to `teamId`. If the
 * base slug is taken, suffixes `-2`, `-3`, … until an unused slug is
 * found.
 *
 * Collision check is GLOBAL across three reserved sets so the
 * `/workspace/skills/<slug>/` paths stay unambiguous on the sandbox:
 *  - bundled skills (visible to every team) — DB rows, `team_id IS NULL`,
 *  - this team's own `team_uploaded` skills — DB rows scoped to the team,
 *  - external-app provider keys (e.g. `outlook`, `imap-smtp`) — these own
 *    `skills/<providerKey>/` on disk and are resolved BEFORE team skills
 *    in `readSkillWorkspaceFile`, so a team skill sharing a provider key
 *    would be silently shadowed whenever that provider is connected.
 * A colliding name is suffixed (`-2`, `-3`, …) instead of rejected, the
 * same UX the create flow already applies to ordinary name clashes.
 *
 * Throws when:
 *  - the base slug can't accommodate a `-N` suffix within 64 chars
 *  - dedupe runs out of attempts (pathological — someone scripted
 *    creating thousands of skills with the same base)
 */
export const pickAvailableSkillSlug = async (
  baseSlug: string,
  teamId: string,
): Promise<string> => {
  const reservedProviderKeys = new Set(listProviderKeys());
  for (let attempt = 0; attempt < SLUG_DEDUPE_MAX_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
    if (candidate.length > SKILL_NAME_MAX_LENGTH) {
      throw new Error(
        `Cannot derive a unique skill slug from "${baseSlug}" within ${SKILL_NAME_MAX_LENGTH} chars`,
      );
    }
    if (reservedProviderKeys.has(candidate)) continue;
    const existing = await db
      .select({ id: skills.id })
      .from(skills)
      .where(
        and(
          eq(skills.name, candidate),
          isNull(skills.deletedAt),
          or(
            and(eq(skills.source, "bundled"), isNull(skills.teamId)),
            and(eq(skills.source, "team_uploaded"), eq(skills.teamId, teamId)),
          ),
        ),
      )
      .limit(1);
    if (existing.length === 0) return candidate;
  }
  throw new Error(
    `Slug dedup exhausted for base "${baseSlug}" after ${SLUG_DEDUPE_MAX_ATTEMPTS} attempts`,
  );
};
