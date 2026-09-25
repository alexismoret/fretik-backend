import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import { listDreamingTeams } from "@fretik/shared/services/episodes/dreaming-candidates";
import {
  describeFolder,
  listFoldersToDescribe,
} from "@fretik/shared/services/folders/describe";
import { type Job, Worker } from "bullmq";
import {
  FOLDER_DESCRIBE_QUEUE,
  FOLDER_DESCRIBE_TEAM_JOB,
  type FolderDescribeTeamJobData,
} from "../queues/names";
import { getFolderDescribeQueue } from "../queues/queues";

/**
 * The nightly folder-description pass.
 *
 * The Drive filer chooses between "Clients" and "Contracts" for a document
 * nobody gave a destination, and a folder NAME rarely settles that. A
 * description would — except almost nobody writes one, which is exactly why
 * the filer had nothing to work with. So the descriptions are derived, here,
 * once a night, from the extraction summaries already in
 * `document_properties`: no file is re-read and no OCR is redone.
 *
 * Same fan-out shape as dreaming, and on its own queue for the same reason:
 * one cheap LLM call per folder, teams in parallel, retried per team, and
 * never on the concurrency-1 maintenance queue where it would block the 15s
 * sweeps for as long as a big workspace takes.
 *
 * Idempotent by construction rather than by job id: `listFoldersToDescribe`
 * only returns folders that need one, so a replayed night re-describes
 * nothing. A folder whose description a PERSON wrote is excluded in the SQL,
 * never filtered afterwards — their statement of where things should go is
 * the one signal worth more than anything inferred, and it must not be one
 * bug away from being overwritten.
 */

/** Teams in parallel per replica — mirrors the dreaming sweep. */
const TEAM_CONCURRENCY = 4;
/**
 * A runaway backstop, not a business cap: a folder only reappears while its
 * contents keep changing, so a real night is a handful per team. Hitting this
 * logs, and the remainder waits for tomorrow.
 */
const MAX_FOLDERS_PER_TEAM = 200;

/**
 * Fan out one job per team active in the last 24h. Reuses dreaming's team
 * list because it asks exactly the right question — who has been doing
 * anything — and a second query for the same answer would be a second thing
 * to keep in step.
 */
export const runFolderDescribeSweep = async (): Promise<{ teams: number }> => {
  const teams = await listDreamingTeams();
  if (teams.length === 0) return { teams: 0 };
  const date = new Date().toISOString().slice(0, 10);
  await getFolderDescribeQueue().addBulk(
    teams.map((team) => ({
      name: FOLDER_DESCRIBE_TEAM_JOB,
      data: { teamId: team.teamId, organizationId: team.organizationId },
      opts: {
        jobId: `folder-describe-${team.teamId}-${date}`,
        attempts: 2,
        backoff: { type: "exponential" as const, delay: 30_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      },
    })),
  );
  return { teams: teams.length };
};

export const startFolderDescribeWorker =
  (): Worker<FolderDescribeTeamJobData> => {
    const worker = new Worker<FolderDescribeTeamJobData>(
      FOLDER_DESCRIBE_QUEUE,
      async (job: Job<FolderDescribeTeamJobData>) => {
        const { teamId, organizationId } = job.data;
        const candidates = await listFoldersToDescribe({
          teamId,
          limit: MAX_FOLDERS_PER_TEAM,
        });
        if (candidates.length === 0) return;
        if (candidates.length === MAX_FOLDERS_PER_TEAM) {
          console.warn(
            `[folder-describe] team ${teamId} hit the ${MAX_FOLDERS_PER_TEAM.toString()}-folder cap; the rest waits for tomorrow`,
          );
        }

        let written = 0;
        for (const folder of candidates) {
          try {
            const ok = await describeFolder({
              folderId: folder.id,
              teamId,
              organizationId,
              name: folder.name,
              fullPath: folder.fullPath,
            });
            if (ok) written += 1;
          } catch (error) {
            // One folder's failure is one folder's: the candidate query
            // re-derives it tomorrow, and a throw here would cost the team
            // its whole night.
            console.warn(
              `[folder-describe] ${folder.id} failed:`,
              error instanceof Error ? error.message : error,
            );
          }
        }
        if (written > 0) {
          console.info(
            `[folder-describe] team ${teamId}: described ${written.toString()} folders`,
          );
        }
      },
      {
        connection: createWorkerConnection(),
        concurrency: TEAM_CONCURRENCY,
      },
    );
    worker.on("failed", (job, err) => {
      console.error(
        `[folder-describe] job ${job?.id ?? "<unknown>"} failed:`,
        err instanceof Error ? err.message : err,
      );
    });
    return worker;
  };
