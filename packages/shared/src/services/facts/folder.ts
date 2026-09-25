import db from "../../db";
import type { DomainEvent } from "../../db/schema";
import { emptyFactSheet, type FactSheet, type FactValue } from "./types";

/**
 * Facts about the folder an event happened to.
 *
 * `folder.deleted` is the case that shapes this: the row is gone by the time
 * anything reads the event, and it is also the event most worth triggering on.
 * So the payload — which carries `folderId` and `name` at emit time — is the
 * floor, and the live row only ever adds to it.
 */
export const resolveFolderFacts = async (
  event: DomainEvent,
): Promise<FactSheet> => {
  const folderId = event.payload["folderId"];
  if (typeof folderId !== "string") return emptyFactSheet(event.type);

  const payloadName = event.payload["name"];
  const facts: Record<string, FactValue> = {
    folderId,
    name: typeof payloadName === "string" ? payloadName : null,
    fullPath: null,
    parentFolderId: null,
    documentCount: 0,
  };

  const folder = await db.query.folders.findFirst({
    where: { id: folderId, teamId: event.teamId },
    columns: {
      name: true,
      fullPath: true,
      parentFolderId: true,
      documentCount: true,
    },
  });
  if (folder) {
    facts["name"] = folder.name;
    facts["fullPath"] = folder.fullPath;
    facts["parentFolderId"] = folder.parentFolderId;
    facts["documentCount"] = folder.documentCount;
  }

  return { eventType: event.type, facts };
};
