import { actingPrincipal } from "../../agents/shared/acting-principal";
import { buildPageProject } from "./build";
import { readPageProject, writePageProject } from "./store";

/**
 * Finish the build of a run that died before it could.
 *
 * A builder writes its files, then builds. Between those two the run can be
 * cut — an upstream timeout, the step budget, the hard deadline — and before
 * the working copy existed that meant the whole generation was gone: the page
 * had been written, paid for, and never saved (measured 2026-08-26, ten kills
 * in one night on the same provider).
 *
 * Now the files are in Redis, so the recovery is the ordinary build, run once
 * from outside the agent. It is safe to attempt on any dead run: an unchanged
 * project reports `unchanged` and writes nothing, and a project that does not
 * compile stays where it is for the next turn to fix.
 */

export type PageSalvageOutcome =
  | { saved: true; pageId: string; url: string }
  | { saved: false; reason: string };

export const salvagePageProject = async (params: {
  /** The dead run's scope — the builder's trace id. */
  scope: string;
  teamId: string;
  /** The project the dead run worked in: a new page is made in it. */
  projectId?: string;
  organizationId: string;
  userId: string | null;
  conversationId?: string;
}): Promise<PageSalvageOutcome | null> => {
  const state = await readPageProject(params.scope);
  if (state === null || Object.keys(state.files).length === 0) return null;

  // The rescue saves for whoever the dead run was building for, with exactly
  // their access — the same person the builder acted for.
  const principal = await actingPrincipal({
    organizationId: params.organizationId,
    teamId: params.teamId,
    ...(params.userId !== null ? { userId: params.userId } : {}),
    ...(params.projectId === undefined ? {} : { projectId: params.projectId }),
  });

  const built = await buildPageProject({
    state,
    teamId: params.teamId,
    projectId: params.projectId,
    organizationId: params.organizationId,
    userId: params.userId,
    conversationId: params.conversationId,
    principal,
    rescue: true,
  });
  // Nothing to rescue: the builder saved this itself. Reporting "recovered"
  // here would send the parent into a repair path for a page that is fine.
  if (built.ok && built.unchanged) return null;
  if (!built.ok) return { saved: false, reason: built.errors.join("; ") };

  await writePageProject(params.scope, built.state);
  return { saved: true, pageId: built.pageId, url: built.url };
};
