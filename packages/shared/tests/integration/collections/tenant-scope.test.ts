import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import {
  type DriveVisibility,
  driveVisibility,
} from "../../../src/authz/drive-sql";
import db from "../../../src/db";
import { collectionGrants, recordShares } from "../../../src/db/schema";
import { countRecordsForType } from "../../../src/services/collection-records/count";
import { getCollectionRecord } from "../../../src/services/collection-records/retrieve";
import { ensureCollectionTable } from "../../../src/services/collection-schema/table";
import { listTypeGrants } from "../../../src/services/collection-sharing/list";
import {
  assertCanReadRecord,
  canTeamReadCollection,
} from "../../../src/services/collection-sharing/read-access";
import {
  assertCanManageType,
  assertCanWriteField,
  assertCanWriteLink,
} from "../../../src/services/collection-sharing/write-access";
import { getCollection } from "../../../src/services/collections/retrieve";
import { bulkCreateLinks } from "../../../src/services/links/bulk-create";
import { listLinksForRecord } from "../../../src/services/links/retrieve";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * The objects system's tenant boundary on the paths that take an id from the
 * request.
 *
 * Two boundaries, two shapes of fixture:
 *   - TEAM: a second team in the SAME organization, holding rows that differ
 *     from the first team's in the team column alone (OPERATIONS.md §7) —
 *     the only shape that fails when `teamId` leaves a predicate;
 *   - ORGANIZATION: a second WORKSPACE, because the defect it pins down was an
 *     organization read from the wrong row. An org-wide grant
 *     (`grantee_team_id IS NULL`) of organization B used to match every team
 *     on the platform, since the list scope took the organization from the
 *     TYPE instead of from the viewer.
 */

let fx: WorkspaceFixture;
let foreign: WorkspaceFixture;
let otherTeamId: string;
/** What a member of each team opens in its Drive: every record read takes it. */
let viewerDrive: DriveVisibility;
let foreignDrive: DriveVisibility;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  foreign = await createWorkspaceFixture();
  otherTeamId = (await fx.createTeam()).id;
  viewerDrive = await driveVisibility(
    await fx.principalOf(fx.userIds[0]),
    fx.teamId,
  );
  foreignDrive = await driveVisibility(
    await foreign.principalOf(foreign.userIds[0]),
    foreign.teamId,
  );
});

afterAll(async () => {
  await fx.cleanup();
  await foreign.cleanup();
});

const viewer = () => ({
  teamId: fx.teamId,
  organizationId: fx.organizationId,
  drive: viewerDrive,
});

const statusOf = async (promise: Promise<unknown>): Promise<number> => {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(HTTPException);
  return (error as HTTPException).status;
};

const grantType = async (params: {
  organizationId: string;
  collectionId: string;
  ownerTeamId: string;
  granteeTeamId: string | null;
  permission?: "read" | "write";
}): Promise<void> => {
  await db.insert(collectionGrants).values({
    organizationId: params.organizationId,
    collectionId: params.collectionId,
    ownerTeamId: params.ownerTeamId,
    granteeTeamId: params.granteeTeamId,
    permission: params.permission ?? "read",
  });
};

describe("reading a record by id", () => {
  test("a record of another team in the organization reads as absent", async () => {
    const collection = await fx.createCollection();
    const theirs = await fx.createRecord({
      collectionId: collection.id,
      teamId: otherTeamId,
    });

    expect(
      await statusOf(getCollectionRecord({ id: theirs.id, ...viewer() })),
    ).toBe(404);
  });

  test("a record shared with the team is readable", async () => {
    const collection = await fx.createCollection({ teamId: otherTeamId });
    const shared = await fx.createRecord({
      collectionId: collection.id,
      teamId: otherTeamId,
      inheritTypeSharing: false,
    });
    await db.insert(recordShares).values({
      organizationId: fx.organizationId,
      recordId: shared.id,
      ownerTeamId: otherTeamId,
      granteeTeamId: fx.teamId,
    });

    await assertCanReadRecord({ recordId: shared.id, ...viewer() });
  });

  test("an org-wide share of ANOTHER organization opens nothing", async () => {
    const collection = await foreign.createCollection();
    const record = await foreign.createRecord({
      collectionId: collection.id,
    });
    await db.insert(recordShares).values({
      organizationId: foreign.organizationId,
      recordId: record.id,
      ownerTeamId: foreign.teamId,
      granteeTeamId: null,
    });

    expect(
      await statusOf(assertCanReadRecord({ recordId: record.id, ...viewer() })),
    ).toBe(404);
  });

  test("an edge to a record the team cannot read is left out", async () => {
    const collection = await fx.createCollection();
    // The full read also loads the typed row from the extension table.
    await ensureCollectionTable({ collectionId: collection.id, fields: [] });
    const mine = await fx.createRecord({ collectionId: collection.id });
    const alsoMine = await fx.createRecord({ collectionId: collection.id });
    const hidden = await fx.createRecord({
      collectionId: collection.id,
      teamId: otherTeamId,
    });
    const linkType = await fx.createLinkType({
      key: `related_${collection.key}`,
      fromCollectionId: collection.id,
    });
    await fx.createLink({
      linkTypeId: linkType.id,
      fromRecordId: mine.id,
      toRecordId: alsoMine.id,
    });
    await fx.createLink({
      linkTypeId: linkType.id,
      fromRecordId: mine.id,
      toRecordId: hidden.id,
    });

    const record = await getCollectionRecord({ id: mine.id, ...viewer() });
    expect(record.outgoingLinks.map((link) => link.toRecordId)).toEqual([
      alsoMine.id,
    ]);

    const links = await listLinksForRecord({ recordId: mine.id, ...viewer() });
    expect(links.outgoing.map((link) => link.toRecordId)).toEqual([
      alsoMine.id,
    ]);
  });
});

describe("listing another organization's type", () => {
  test("an org-wide grant in that organization shows the viewer nothing", async () => {
    const collection = await foreign.createCollection();
    await foreign.createRecord({ collectionId: collection.id });
    await grantType({
      organizationId: foreign.organizationId,
      collectionId: collection.id,
      ownerTeamId: foreign.teamId,
      granteeTeamId: null,
    });

    expect(
      await countRecordsForType({
        collectionId: collection.id,
        teamId: fx.teamId,
        drive: viewerDrive,
      }),
    ).toBe(0);
    // The owner still sees its own record: the predicate is not just `false`.
    expect(
      await countRecordsForType({
        collectionId: collection.id,
        teamId: foreign.teamId,
        drive: foreignDrive,
      }),
    ).toBe(1);
  });

  test("the collection itself, and a page dataset on it, read as absent", async () => {
    const collection = await foreign.createCollection();

    expect(
      await statusOf(getCollection({ id: collection.id, ...viewer() })),
    ).toBe(404);
    expect(
      await canTeamReadCollection({
        collectionId: collection.id,
        teamId: fx.teamId,
      }),
    ).toBe(false);
  });

  test("another team's collection is readable once granted", async () => {
    const collection = await fx.createCollection({ teamId: otherTeamId });

    expect(
      await statusOf(getCollection({ id: collection.id, ...viewer() })),
    ).toBe(404);

    await grantType({
      organizationId: fx.organizationId,
      collectionId: collection.id,
      ownerTeamId: otherTeamId,
      granteeTeamId: fx.teamId,
    });

    expect((await getCollection({ id: collection.id, ...viewer() })).id).toBe(
      collection.id,
    );
  });
});

describe("sharing lists are the owner's", () => {
  test("a non-owner asking for a type's grants gets an empty list", async () => {
    const collection = await fx.createCollection({ teamId: otherTeamId });
    await grantType({
      organizationId: fx.organizationId,
      collectionId: collection.id,
      ownerTeamId: otherTeamId,
      granteeTeamId: null,
    });

    expect(
      await listTypeGrants({
        collectionId: collection.id,
        ownerTeamId: fx.teamId,
        organizationId: fx.organizationId,
      }),
    ).toEqual([]);
    expect(
      await listTypeGrants({
        collectionId: collection.id,
        ownerTeamId: otherTeamId,
        organizationId: fx.organizationId,
      }),
    ).toHaveLength(1);
  });
});

describe("creating an edge", () => {
  test("a target record the team cannot read is refused like a missing one", async () => {
    const collection = await fx.createCollection();
    const mine = await fx.createRecord({ collectionId: collection.id });
    const hidden = await fx.createRecord({
      collectionId: collection.id,
      teamId: otherTeamId,
    });
    const linkType = await fx.createLinkType({
      key: `ref_${collection.key}`,
      fromCollectionId: collection.id,
    });

    const result = await bulkCreateLinks({
      ...viewer(),
      links: [
        {
          linkTypeId: linkType.id,
          fromRecordId: mine.id,
          toRecordId: hidden.id,
        },
      ],
    });

    expect(result.ids).toEqual([null]);
    expect(result.errors).toEqual([{ index: 0, error: "Record not found." }]);
  });

  test("a link type of another organization is refused", async () => {
    const collection = await fx.createCollection();
    const from = await fx.createRecord({ collectionId: collection.id });
    const to = await fx.createRecord({ collectionId: collection.id });
    const theirCollection = await foreign.createCollection();
    const theirLinkType = await foreign.createLinkType({
      key: `ext_${theirCollection.key}`,
      fromCollectionId: collection.id,
    });

    const result = await bulkCreateLinks({
      ...viewer(),
      links: [
        {
          linkTypeId: theirLinkType.id,
          fromRecordId: from.id,
          toRecordId: to.id,
        },
      ],
    });

    expect(result.errors).toEqual([
      { index: 0, error: "Link type not found." },
    ]);
  });
});

describe("invalidating an edge", () => {
  test("an edge of another team is refused, one of another organization is absent", async () => {
    const collection = await fx.createCollection({ teamId: otherTeamId });
    const a = await fx.createRecord({
      collectionId: collection.id,
      teamId: otherTeamId,
    });
    const b = await fx.createRecord({
      collectionId: collection.id,
      teamId: otherTeamId,
    });
    const linkType = await fx.createLinkType({
      key: `pair_${collection.key}`,
      fromCollectionId: collection.id,
      teamId: otherTeamId,
    });
    const theirs = await fx.createLink({
      linkTypeId: linkType.id,
      fromRecordId: a.id,
      toRecordId: b.id,
      teamId: otherTeamId,
    });

    expect(
      await statusOf(
        assertCanWriteLink({
          linkId: theirs.id,
          ...viewer(),
          userId: fx.userIds[0],
        }),
      ),
    ).toBe(403);
    expect(
      await statusOf(
        assertCanWriteLink({
          linkId: theirs.id,
          teamId: foreign.teamId,
          organizationId: foreign.organizationId,
          userId: foreign.userIds[0],
        }),
      ),
    ).toBe(404);
  });
});

describe("structure belongs to the owner", () => {
  test("another team's field on an org-level type is refused", async () => {
    const orgLevel = await fx.createCollection({ teamId: null });
    const theirField = await fx.createField({
      collectionId: orgLevel.id,
      key: "their_notes",
      type: "text",
      teamId: otherTeamId,
    });
    const myField = await fx.createField({
      collectionId: orgLevel.id,
      key: "my_notes",
      type: "text",
    });

    expect(
      await statusOf(
        assertCanWriteField({
          fieldDefinitionId: theirField.id,
          ...viewer(),
          userId: fx.userIds[1],
        }),
      ),
    ).toBe(403);
    await assertCanWriteField({
      fieldDefinitionId: myField.id,
      ...viewer(),
      userId: fx.userIds[1],
    });
  });

  test("an organization field template takes an org admin", async () => {
    const orgLevel = await fx.createCollection({ teamId: null });
    const template = await fx.createField({
      collectionId: orgLevel.id,
      key: "template_field",
      type: "text",
      teamId: null,
    });

    // userIds[1] is a plain member, userIds[0] the owner.
    expect(
      await statusOf(
        assertCanWriteField({
          fieldDefinitionId: template.id,
          ...viewer(),
          userId: fx.userIds[1],
        }),
      ),
    ).toBe(403);
    await assertCanWriteField({
      fieldDefinitionId: template.id,
      ...viewer(),
      userId: fx.userIds[0],
    });
  });

  test("an org-level type is an admin's to change, a granted one never the grantee's", async () => {
    const orgLevel = await fx.createCollection({ teamId: null });
    const granted = await fx.createCollection({ teamId: otherTeamId });
    await grantType({
      organizationId: fx.organizationId,
      collectionId: granted.id,
      ownerTeamId: otherTeamId,
      granteeTeamId: fx.teamId,
      permission: "write",
    });

    expect(
      await statusOf(
        assertCanManageType({
          collectionId: orgLevel.id,
          ...viewer(),
          userId: fx.userIds[1],
        }),
      ),
    ).toBe(403);
    await assertCanManageType({
      collectionId: orgLevel.id,
      ...viewer(),
      userId: fx.userIds[0],
    });
    expect(
      await statusOf(
        assertCanManageType({
          collectionId: granted.id,
          ...viewer(),
          userId: fx.userIds[0],
        }),
      ),
    ).toBe(403);
  });
});
