import { and, inArray, isNotNull } from "drizzle-orm";
import { adapterFor } from "../../authz/access";
import { loadPrincipal } from "../../authz/load-principal";
import type { UserPrincipal } from "../../authz/principal";
import type { LoadedNode } from "../../authz/resources/types";
import { computeLevel } from "../../authz/rules";
import db from "../../db";
import {
  collectionRecords,
  type DomainEvent,
  type Workflow,
} from "../../db/schema";
import { getTeamBotUserId } from "../auth/bot-user";

/**
 * An event about a Drive file or folder — or about the record that mirrors a
 * file — starts only the workflows whose acting identity can open it. A run
 * carries its event into a transcript the team reads, and the file's name
 * with it. The identity is the one `create-run.ts` acts as: the owner of a
 * private workflow, the team's agent otherwise.
 *
 * An item that is gone can no longer be asked. Its entry says whether the
 * whole team could open it when it went (`teamOpen`, see
 * `authz/drive-sql.ts#teamOpenDriveItems`), and only then does it start a
 * run, for an identity that is still in the team.
 *
 * Everything else — a record that mirrors nothing, a link, a connector event —
 * passes untouched: its own reads are gated where the run makes them.
 */

interface DriveSubject {
  type: "document" | "folder";
  id: string;
  /** What the entry recorded for an item that may be gone by now. */
  teamOpen: boolean;
}

const stringAt = (
  payload: Record<string, unknown>,
  key: string,
): string | null => {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** The Drive item an event is about, before mirror records are resolved. */
const directSubjectOf = (event: DomainEvent): DriveSubject | null => {
  const teamOpen = event.payload.teamOpen === true;
  const documentId = stringAt(event.payload, "documentId");
  if (documentId !== null)
    return { type: "document", id: documentId, teamOpen };
  const folderId = stringAt(event.payload, "folderId");
  if (event.subjectType === "folder" && folderId !== null) {
    return { type: "folder", id: folderId, teamOpen };
  }
  return null;
};

/** The file each of these records mirrors, for those that mirror one. */
const mirroredDocuments = async (
  recordIds: readonly string[],
): Promise<Map<string, string>> => {
  if (recordIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: collectionRecords.id,
      documentId: collectionRecords.documentId,
    })
    .from(collectionRecords)
    .where(
      and(
        inArray(collectionRecords.id, [...new Set(recordIds)]),
        isNotNull(collectionRecords.documentId),
      ),
    );
  return new Map(
    rows.flatMap((row) =>
      row.documentId === null ? [] : [[row.id, row.documentId] as const],
    ),
  );
};

/** The value of `key`, loaded on first ask and shared after. */
const once = <T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> => {
  const known = cache.get(key);
  if (known) return known;
  const pending = load();
  cache.set(key, pending);
  return pending;
};

type TriggerPair = { workflow: Workflow; event: DomainEvent };

/**
 * The pairs whose Drive subject the principal `principalOf` names for each
 * workflow can open. The sweep asks it of the identity a run acts as; "test
 * the condition" asks it of that identity and then of the person testing,
 * who reads each replayed event's name.
 */
export const keepPairsOpenTo = async <P extends TriggerPair>(
  pairs: readonly P[],
  principalOf: (workflow: Workflow) => Promise<UserPrincipal | null>,
): Promise<P[]> => {
  const mirrors = await mirroredDocuments(
    pairs.flatMap(({ event }) =>
      directSubjectOf(event) === null && event.subjectRecordId !== null
        ? [event.subjectRecordId]
        : [],
    ),
  );
  const subjectOf = (event: DomainEvent): DriveSubject | null => {
    const direct = directSubjectOf(event);
    if (direct !== null) return direct;
    const mirrored =
      event.subjectRecordId === null
        ? undefined
        : mirrors.get(event.subjectRecordId);
    // A live record's file is live too: nothing to fall back on.
    return mirrored === undefined
      ? null
      : { type: "document", id: mirrored, teamOpen: false };
  };

  const subjects = pairs.map(({ event }) => subjectOf(event));
  if (subjects.every((subject) => subject === null)) return [...pairs];

  const idsOf = (type: DriveSubject["type"]): string[] => [
    ...new Set(
      subjects.flatMap((subject) =>
        subject?.type === type ? [subject.id] : [],
      ),
    ),
  ];
  const [documents, folders] = await Promise.all([
    adapterFor("document").loadNodes(idsOf("document")),
    adapterFor("folder").loadNodes(idsOf("folder")),
  ]);

  const verdicts = await Promise.all(
    pairs.map(async ({ workflow }, index) => {
      const subject = subjects[index] ?? null;
      if (subject === null) return true;
      const principal = await principalOf(workflow);
      if (principal === null) return false;
      const node: LoadedNode | undefined = (
        subject.type === "document" ? documents : folders
      ).get(subject.id);
      // Gone: open to the team when it went, and they are in the team.
      if (node === undefined) {
        return subject.teamOpen && principal.teamRoles.has(workflow.teamId);
      }
      return computeLevel(principal, node) !== null;
    }),
  );
  return pairs.filter((_, index) => verdicts[index] === true);
};

/**
 * The identity each workflow's runs act as (`create-run.ts`): the owner of a
 * private workflow, the team's agent otherwise. Each is loaded once per
 * resolver, so one resolver serves one batch.
 */
export const actingPrincipalResolver = (): ((
  workflow: Workflow,
) => Promise<UserPrincipal | null>) => {
  const bots = new Map<string, Promise<string>>();
  const principals = new Map<string, Promise<UserPrincipal | null>>();
  return async (workflow) => {
    const userId =
      workflow.userId ??
      (await once(bots, workflow.teamId, () =>
        getTeamBotUserId(workflow.teamId),
      ));
    return once(principals, `${workflow.organizationId}:${userId}`, () =>
      loadPrincipal({ organizationId: workflow.organizationId, userId }),
    );
  };
};

/** The pairs whose Drive subject the workflow's acting identity can open. */
export const keepVisibleTriggerPairs = <P extends TriggerPair>(
  pairs: readonly P[],
): Promise<P[]> => keepPairsOpenTo(pairs, actingPrincipalResolver());
