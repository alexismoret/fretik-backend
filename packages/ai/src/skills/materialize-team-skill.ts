/**
 * Render a team-uploaded skill (stored in the DB as bare body + metadata)
 * into the on-disk `SKILL.md` form: YAML frontmatter (`name` +
 * single-line `description`) followed by the body.
 *
 * Single source of truth for this format so the bootstrap pusher
 * (`conversation-storage.pushTeamSkills`) and the Bun-side reader
 * (`read-skill-file`) materialise team skills byte-identically. Bundled
 * and provider skills already ship their frontmatter on disk, so this
 * only applies to the `team_uploaded` origin.
 */
export const materializeTeamSkillMd = (entry: {
  name: string;
  description: string;
  body: string;
}): string =>
  `---\nname: ${entry.name}\ndescription: ${entry.description
    .replace(/\n/g, " ")
    .trim()}\n---\n\n${entry.body}`;
