import { and, eq, isNull } from "drizzle-orm";
import db from "../../db";
import { skills } from "../../db/schema";
import { throwHttpError } from "../../lib/errors";
import { downloadSkill } from "../../lib/skills-registry/client";
import {
  companionFilesCount,
  detectLicense,
  extractDescription,
  findSkillMd,
  isRestrictedLicense,
  parseFrontmatter,
} from "../../lib/skills-registry/normalize";
import { ERROR_CODES } from "../../schemas/errors";
import { type EventActor } from "../domain-events/emit";
import { createSkill } from "./create";
import { getSkillForTeamById, type SkillDetail } from "./get-by-id";

/**
 * Install a skill from the skills.sh catalog as a `team_uploaded` skill: download
 * the bundle, recover the FULL SKILL.md body (frontmatter stripped), and create a
 * team-scoped row stamped with a `skills.sh:<owner>/<repo>/<slug>` provenance +
 * the source content hash. Idempotent — re-installing the same skill returns the
 * existing row. Proprietary/no-redistribution licenses are refused (we may not
 * store and serve that content). Companion files beyond SKILL.md are not
 * installed but their count is recorded to surface a UI warning.
 */
export const installSkillFromCatalog = async (input: {
  teamId: string;
  organizationId: string;
  owner: string;
  repo: string;
  slug: string;
  actor?: EventActor;
}): Promise<SkillDetail> => {
  const sourceUrl = `skills.sh:${input.owner}/${input.repo}/${input.slug}`;

  const existing = await db
    .select({ id: skills.id })
    .from(skills)
    .where(
      and(
        eq(skills.teamId, input.teamId),
        eq(skills.sourceUrl, sourceUrl),
        isNull(skills.deletedAt),
      ),
    )
    .limit(1);
  if (existing[0] !== undefined) {
    const detail = await getSkillForTeamById(existing[0].id, input.teamId);
    if (detail !== null) return detail;
  }

  const download = await downloadSkill(input.owner, input.repo, input.slug);
  const skillMd = findSkillMd(download.files);
  const parsed =
    skillMd !== undefined ? parseFrontmatter(skillMd.contents) : undefined;
  if (parsed === undefined || parsed.body.trim() === "") {
    return throwHttpError(400, {
      code: ERROR_CODES.SKILL_INVALID_BODY,
      message: "This catalog skill has no installable SKILL.md content.",
    });
  }

  const license = detectLicense(parsed.frontmatter, download.files);
  if (isRestrictedLicense(license)) {
    return throwHttpError(400, {
      code: ERROR_CODES.SKILL_LICENSE_RESTRICTED,
      message:
        "This skill's license forbids storing and redistributing its content, so it can't be installed.",
    });
  }

  const description = extractDescription(parsed.frontmatter, parsed.body);
  return createSkill({
    teamId: input.teamId,
    organizationId: input.organizationId,
    name: parsed.frontmatter.name ?? input.slug,
    description: description === "" ? input.slug : description,
    body: parsed.body,
    sourceUrl,
    sourceHash: download.hash,
    skippedFiles: companionFilesCount(download.files),
    actor: input.actor,
  });
};
