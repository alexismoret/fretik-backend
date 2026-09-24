import type { UserPrincipal } from "./principal";

/**
 * The team's agent as it works in one of the team's projects: it takes part
 * in the project and reaches nothing else of its team.
 *
 * What a project chat read by several people gathers by itself, and what a
 * workflow of the project reads, is then what everyone in the project reads,
 * whatever team they come from; what either adds lands in the project.
 *
 * `use`, not the level the team's role would give on an open project: a
 * member gets `edit` there, and an agent that anyone taking part can drive
 * must not change what they could only read. A restricted project, which the
 * team's agent does not reach through its team at all, is reached the same
 * way: the project is where it was asked to work.
 */
export const confineToProject = (
  agent: UserPrincipal,
  projectId: string,
): UserPrincipal => ({
  ...agent,
  teamRoles: new Map(),
  teamContentLevels: new Map(),
  projectLevels: new Map([[projectId, "use"]]),
});

/** Whether the principal is a team's agent rather than a person. */
export const isTeamAgent = (principal: UserPrincipal): boolean =>
  principal.orgRole === "bot";
