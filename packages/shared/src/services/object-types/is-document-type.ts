import { DOCUMENT_TYPE_KEY } from "./constants";
import { resolveObjectTypeId } from "./resolve";

/**
 * True when `objectTypeId` is the org's delete-protected `document_record` type.
 * Locks the document title invariant (single `name` title): field
 * create/update/delete consult it to refuse promoting, demoting, or dropping the
 * title. Reuses the cached key→id resolve, so it adds no round-trip on the hot
 * path.
 */
export const isDocumentObjectType = async (input: {
  organizationId: string;
  teamId: string | null;
  objectTypeId: string;
}): Promise<boolean> => {
  const documentTypeId = await resolveObjectTypeId({
    organizationId: input.organizationId,
    teamId: input.teamId,
    key: DOCUMENT_TYPE_KEY,
  });
  return documentTypeId != null && documentTypeId === input.objectTypeId;
};
