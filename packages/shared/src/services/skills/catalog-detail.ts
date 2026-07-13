import { throwHttpError } from "../../lib/errors";
import {
  fetchSkillAudit,
  getSkillMeta,
} from "../../lib/skills-registry/client";
import { ERROR_CODES } from "../../schemas/errors";
import type { SkillCatalogDetail } from "../../schemas/skills";

/**
 * Detail for the skills-hub slideover: the hydrated metadata (description,
 * license, file count, hash) plus advisory security audits. `restrictedLicense`
 * lets the UI disable install for proprietary content; audits never block.
 */
export const getSkillCatalogDetail = async (input: {
  owner: string;
  repo: string;
  slug: string;
}): Promise<SkillCatalogDetail> => {
  const [meta, audits] = await Promise.all([
    getSkillMeta(input.owner, input.repo, input.slug),
    fetchSkillAudit(`${input.owner}/${input.repo}`, input.slug),
  ]);
  if (meta === null) {
    return throwHttpError(404, {
      code: ERROR_CODES.SKILL_NOT_FOUND,
      message: "This catalog skill could not be read.",
    });
  }
  return {
    id: `${input.owner}/${input.repo}/${input.slug}`,
    description: meta.description,
    license: meta.license,
    restrictedLicense: meta.restrictedLicense,
    filesCount: meta.filesCount,
    hash: meta.hash,
    audits,
  };
};
