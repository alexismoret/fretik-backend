import db from "../../db";
import type { DomainEvent } from "../../db/schema";
import { emptyFactSheet, type FactSheet, type FactValue } from "./types";

/**
 * Facts about the edge an event happened to.
 *
 * What makes a link worth judging is never the edge itself — it is what it
 * connects. "A document was linked to a client" is one relation type and two
 * record labels; the row's own columns are three foreign keys and say nothing
 * a criterion can read. So the resolver's whole job is the join, and it does
 * it in one relational query off `linkId`.
 */
export const resolveLinkFacts = async (
  event: DomainEvent,
): Promise<FactSheet> => {
  const linkId = event.payload["linkId"];
  if (typeof linkId !== "string") return emptyFactSheet(event.type);

  const link = await db.query.links.findFirst({
    where: { id: linkId, teamId: event.teamId },
    columns: { id: true },
    with: {
      linkType: { columns: { key: true } },
      fromRecord: {
        columns: { label: true },
        with: { collection: { columns: { key: true } } },
      },
      toRecord: {
        columns: { label: true },
        with: { collection: { columns: { key: true } } },
      },
    },
  });
  if (!link) return emptyFactSheet(event.type);

  // Every edge here is a NOT NULL foreign key, so a missing side means the
  // row was deleted between the emit and this read. `null` says that plainly;
  // asserting the join would turn a race into a crash inside the gate.
  const facts: Record<string, FactValue> = {
    linkTypeKey: link.linkType?.key ?? null,
    fromLabel: link.fromRecord?.label ?? null,
    fromCollectionKey: link.fromRecord?.collection?.key ?? null,
    toLabel: link.toRecord?.label ?? null,
    toCollectionKey: link.toRecord?.collection?.key ?? null,
  };
  return { eventType: event.type, facts };
};
