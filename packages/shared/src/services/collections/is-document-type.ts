import { DOCUMENT_COLLECTION_KEY } from "./constants";
import { resolveCollectionId } from "./resolve";

/**
 * True when `collectionId` is the org's delete-protected `document_record` type.
 * Locks the document title invariant (single `name` title): field
 * create/update/delete consult it to refuse promoting, demoting, or dropping the
 * title. Reuses the cached key→id resolve, so it adds no round-trip on the hot
 * path.
 */
export const isDocumentCollection = async (input: {
  organizationId: string;
  teamId: string | null;
  collectionId: string;
}): Promise<boolean> => {
  const documentTypeId = await resolveCollectionId({
    organizationId: input.organizationId,
    teamId: input.teamId,
    key: DOCUMENT_COLLECTION_KEY,
  });
  return documentTypeId != null && documentTypeId === input.collectionId;
};
