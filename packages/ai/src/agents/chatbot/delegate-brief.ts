import { boundedText } from "../../lib/persisted-output";
import { readSkillWorkspaceFile } from "../../skills/read-skill-file";
import { formatCurrentDate } from "../shared/prompt-renderer";
import type { AgentRuntimeContext } from "../shared/runtime-context";

/**
 * The message a sub-agent opens with: what it needs to know about where it
 * is, the skills its parent handed it, then the task.
 *
 * Its system prompt is static text — one cached prefix for every dispatch of
 * every team — so everything that depends on the team rides HERE, in the
 * first user message, which is the same for every step of one run and is
 * cached from its second step on. Before this, a sub-agent knew nothing but
 * the task string: not the date (a web search could not tell last year's
 * figures from this year's), not the team's standing instructions, not which
 * skills existed, not the collections, not the connected apps. It spent its
 * first steps rediscovering them, or worked without them.
 *
 * Every block is copied from the PARENT's runtime context, already rendered
 * for its own prompt: no query runs here except the skill bodies, which only
 * exist when the parent asked for them.
 */

/** A parent hands over a few skills, not a library — each can be ~5k tokens. */
export const MAX_PRELOADED_SKILLS = 3;

/**
 * Per skill. Generous for a SKILL.md (they are written to be read whole) and a
 * bound on a pathological one; the sub-agent can still `read` the rest.
 */
const SKILL_BODY_BUDGET_CHARS = 24_000;

const section = (tag: string, body: string | undefined): string => {
  const text = body?.trim() ?? "";
  return text.length === 0 ? "" : `<${tag}>\n${text}\n</${tag}>`;
};

/**
 * The skills the parent named, read in full. A name that resolves to nothing
 * is reported rather than dropped, so the sub-agent does not go looking for a
 * procedure that is not there.
 */
const preloadSkills = async (
  names: readonly string[],
  conversationId: string | undefined,
): Promise<string> => {
  if (names.length === 0 || conversationId === undefined) return "";
  const unique = [...new Set(names)].slice(0, MAX_PRELOADED_SKILLS);
  const bodies = await Promise.all(
    unique.map(async (name) => {
      try {
        const body = await readSkillWorkspaceFile(
          conversationId,
          `skills/${name}/SKILL.md`,
        );
        return { name, body };
      } catch (err) {
        console.warn(
          `[sub-agent] could not preload skill "${name}":`,
          err instanceof Error ? err.message : err,
        );
        return { name, body: null };
      }
    }),
  );
  return bodies
    .map(({ name, body }) =>
      body === null
        ? `<skill name="${name}">Not available to this team — work without it.</skill>`
        : `<skill name="${name}" path="skills/${name}/SKILL.md">\n${boundedText(body.trim(), SKILL_BODY_BUDGET_CHARS)}\n</skill>`,
    )
    .join("\n\n");
};

export const buildDelegateBrief = async (
  input: { task: string; skills?: readonly string[] | undefined },
  ctx: AgentRuntimeContext,
): Promise<string> => {
  const context = [
    section("current_date", formatCurrentDate(new Date(), ctx.timeZone)),
    section("team_context", ctx.chatbotContextManifest),
    section("skills_catalog", ctx.enabledSkillsBlock),
    section("team_collections", ctx.teamCollectionsBlock),
    section("external_apps", ctx.externalAppsBlock),
  ].filter((block) => block.length > 0);

  const skills = await preloadSkills(input.skills ?? [], ctx.conversationId);

  return [
    `<delegate_context>\n${context.join("\n\n")}\n</delegate_context>`,
    skills,
    `<task>\n${input.task}\n</task>`,
  ]
    .filter((block) => block.length > 0)
    .join("\n\n");
};
