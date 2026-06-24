import { eq, inArray } from "drizzle-orm";
import db from "../db";
import {
  documents,
  domainEventLinks,
  domainEvents,
  links,
  objectRecords,
} from "../db/schema";
import { syncDocumentGraph } from "../services/documents/sync-document-graph";
import { getRecordHistory } from "../services/domain-events/history";
import { resolveOrgLinkTypeId } from "../services/link-types/resolve";
import { createObjectRecord } from "../services/object-records/create";
import { setRecordData } from "../services/object-records/update";
import { resolveObjectTypeId } from "../services/object-types/resolve";
import { MENTIONS_LINK_TYPE_KEY } from "../services/object-types/seed-system-types";

/**
 * Phase-2 smoke: drives the document→graph fold + the domain-events outbox +
 * attribute-history fold directly against the dev DB, asserts the invariants,
 * then cleans up everything it created. Run from packages/shared:
 *   bun --env-file=.env run src/scripts/smoke-phase2-fold.ts
 */

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
};

const run = async (): Promise<void> => {
  const team = await db.query.team.findFirst({
    columns: { id: true, organizationId: true },
  });
  if (!team) throw new Error("No team in dev DB — seed one first.");
  const { id: teamId, organizationId } = team;
  console.log(`[smoke] team=${teamId} org=${organizationId}`);

  const documentTypeId = await resolveObjectTypeId({
    organizationId,
    teamId,
    key: "document",
  });
  const companyTypeId = await resolveObjectTypeId({
    organizationId,
    teamId,
    key: "company",
  });
  const mentionsLinkTypeId = await resolveOrgLinkTypeId({
    organizationId,
    key: MENTIONS_LINK_TYPE_KEY,
  });
  assert(!!documentTypeId, "document object type seeded");
  assert(!!companyTypeId, "company object type seeded");
  assert(
    !!mentionsLinkTypeId,
    "mentions link type seeded (migration backfill)",
  );

  const [doc] = await db
    .insert(documents)
    .values({
      teamId,
      originalFilename: "smoke-invoice.pdf",
      fileSize: 1234,
      mimeType: "application/pdf",
      fileHash: `smoke-${process.pid}-${process.hrtime.bigint()}`,
      status: "processing",
    })
    .returning();
  if (!doc) throw new Error("failed to insert smoke document");
  const documentId = doc.id;
  const createdRecordIds: string[] = [];

  try {
    // --- Part A: the document → graph fold ------------------------------------
    const fold = await syncDocumentGraph({
      organizationId,
      teamId,
      documentId,
      filename: "smoke-invoice.pdf",
      customFields: { smoke_only_unknown_key: "ignored-if-not-a-field-def" },
      mentions: [
        { name: "ACME Corp", confidence: 0.9 },
        { name: "Globex SA", confidence: 0.8 },
        { name: "ACME Corp", confidence: 0.7 },
      ],
    });
    createdRecordIds.push(
      fold.mirrorRecordId,
      ...fold.mentionedRecords.map((c) => c.id),
    );

    const mirror = await db.query.objectRecords.findFirst({
      where: { documentId },
    });
    assert(!!mirror, "1 object_record mirror created for the document");
    assert(mirror!.label === "smoke-invoice.pdf", "mirror label = filename");
    assert(
      mirror!.objectTypeId === documentTypeId,
      "mirror is the document type",
    );
    assert(
      fold.mentionedRecords.length === 2,
      "3 mentions (with a duplicate) collapse to 2 mention-target records",
    );

    const mentionLinks = await db
      .select()
      .from(links)
      .where(eq(links.fromRecordId, mirror!.id));
    assert(mentionLinks.length === 2, "2 mentions links from the mirror");
    assert(
      mentionLinks.every((l) => l.linkTypeId === mentionsLinkTypeId),
      "links use the generic mentions link type",
    );

    const uploaded = await db.query.domainEvents.findFirst({
      where: { type: "document.uploaded", subjectRecordId: mirror!.id },
    });
    assert(!!uploaded, "document.uploaded event emitted (durable journal)");
    assert(
      uploaded!.dedupKey === `document.uploaded:${documentId}`,
      "document.uploaded dedupKey is deterministic",
    );
    const uploadedLinks = await db
      .select()
      .from(domainEventLinks)
      .where(eq(domainEventLinks.eventId, uploaded!.id));
    assert(
      uploadedLinks.length === 3,
      "document.uploaded links the mirror (subject) + 2 companies (mentioned)",
    );
    assert(
      uploadedLinks.some(
        (l) => l.recordId === mirror!.id && l.role === "subject",
      ),
      "mirror is linked to document.uploaded as subject",
    );

    const mirrorEventTypes = (
      await db
        .select({ type: domainEvents.type })
        .from(domainEventLinks)
        .innerJoin(domainEvents, eq(domainEventLinks.eventId, domainEvents.id))
        .where(eq(domainEventLinks.recordId, mirror!.id))
    ).map((r) => r.type);
    assert(
      mirrorEventTypes.includes("record.created"),
      "mirror has an in-tx record.created event (outbox)",
    );
    const linkCreatedForMirror = mirrorEventTypes.filter(
      (t) => t === "link.created",
    ).length;
    assert(
      linkCreatedForMirror === 2,
      "each mentions link emitted a link.created event",
    );

    // --- Part B: attribute history fold ---------------------------------------
    // A directly-created record carries record.created/updated field diffs, so
    // `getRecordHistory` can reconstruct a field over time.
    const rec = await createObjectRecord({
      organizationId,
      teamId,
      objectTypeId: companyTypeId!,
      data: { name: "HistTest Inc" },
    });
    createdRecordIds.push(rec.id);
    await setRecordData({
      id: rec.id,
      data: { name: "HistTest Renamed" },
      strict: false,
    });

    const history = await getRecordHistory({ recordId: rec.id });
    const nameTimeline = history.fields["name"] ?? [];
    console.log(
      `[smoke] 'name' timeline: ${JSON.stringify(nameTimeline.map((c) => c.value))}`,
    );
    assert(
      nameTimeline.length === 2,
      "history reconstructs 'name' across create + update",
    );
    assert(
      nameTimeline[0]?.value === "HistTest Inc" &&
        nameTimeline[1]?.value === "HistTest Renamed",
      "history field timeline has the right values in order",
    );

    console.log("\n[smoke] ✅ ALL ASSERTIONS PASSED\n");
  } finally {
    // Cleanup — delete journal entries first (while their links still point at
    // our records), then the records (cascades links + event-links), then the
    // document. Leaves the dev DB as we found it.
    if (createdRecordIds.length > 0) {
      const eventIds = [
        ...new Set(
          (
            await db
              .select({ eventId: domainEventLinks.eventId })
              .from(domainEventLinks)
              .where(inArray(domainEventLinks.recordId, createdRecordIds))
          ).map((r) => r.eventId),
        ),
      ];
      if (eventIds.length > 0) {
        await db.delete(domainEvents).where(inArray(domainEvents.id, eventIds));
      }
      await db
        .delete(objectRecords)
        .where(inArray(objectRecords.id, createdRecordIds));
    }
    await db.delete(documents).where(eq(documents.id, documentId));
    console.log("[smoke] cleaned up");
  }

  process.exit(0);
};

run().catch((error) => {
  console.error("[smoke] failed:", error);
  process.exit(1);
});
