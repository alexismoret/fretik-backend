import { and, eq, isNull } from "drizzle-orm";
import db from "../../db";
import type {
  LinkType,
  LinkTypeCardinality,
  OntologySource,
  OntologyStatus,
} from "../../db/schema";
import { linkTypes } from "../../db/schema";
import { badRequest, internalError, throwHttpError } from "../../lib/errors";

/**
 * Slug grammar for `link_types.normalized_key`: lowercase letter first, then
 * lowercase alphanumerics / underscores, ≤ 60 chars. This is the
 * canonicalization + uniqueness target.
 */
const LINK_TYPE_KEY_REGEX = /^[a-z][a-z0-9_]*$/;
const MAX_KEY_LENGTH = 60;

const slugifyLinkTypeKey = (raw: string): string =>
  raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_KEY_LENGTH);

/**
 * Resolve a unique `normalized_key` within a team's scope: slugify the base
 * (label when no key is supplied), then append `_2`, `_3`, … until it clears
 * the per-team uniqueness index. Keeps relation keys out of the UI.
 */
const resolveUniqueLinkKey = async (data: {
  organizationId: string;
  teamId: string;
  base: string;
}): Promise<string> => {
  const rows = await db
    .select({ normalizedKey: linkTypes.normalizedKey })
    .from(linkTypes)
    .where(
      and(
        eq(linkTypes.organizationId, data.organizationId),
        data.teamId === null
          ? isNull(linkTypes.teamId)
          : eq(linkTypes.teamId, data.teamId),
      ),
    );
  const taken = new Set(rows.map((r) => r.normalizedKey));
  const root = slugifyLinkTypeKey(data.base) || "relation";
  if (!taken.has(root)) return root;
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const candidate = `${root.slice(0, MAX_KEY_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/**
 * Create a typed relation between two object types (`toObjectTypeId` null =
 * polymorphic). `normalizedKey` is the slugified `key`. Defaults match the
 * trust model: user writes are born `confirmed` / `user_manual`.
 */
export const createLinkType = async (input: {
  organizationId: string;
  teamId: string;
  // Optional: omitted from the UI and derived server-side from the label.
  key?: string;
  label: string;
  fromObjectTypeId: string;
  toObjectTypeId?: string | null;
  cardinality?: LinkTypeCardinality;
  inverseKey?: string | null;
  inverseLabel?: string | null;
  status?: OntologyStatus;
  source?: OntologySource;
  confidence?: number | null;
}): Promise<LinkType> => {
  const normalizedKey = input.key
    ? slugifyLinkTypeKey(input.key)
    : await resolveUniqueLinkKey({
        organizationId: input.organizationId,
        teamId: input.teamId,
        base: input.label,
      });
  if (
    !LINK_TYPE_KEY_REGEX.test(normalizedKey) ||
    normalizedKey.length > MAX_KEY_LENGTH
  ) {
    return throwHttpError(
      400,
      badRequest(
        `Link type key '${input.key ?? input.label}' is invalid. It must reduce to a lowercase slug (letter first, letters / digits / underscores, at most ${MAX_KEY_LENGTH} characters).`,
      ),
    );
  }

  const [row] = await db
    .insert(linkTypes)
    .values({
      organizationId: input.organizationId,
      teamId: input.teamId,
      key: input.key ?? normalizedKey,
      normalizedKey,
      label: input.label,
      fromObjectTypeId: input.fromObjectTypeId,
      toObjectTypeId: input.toObjectTypeId ?? null,
      cardinality: input.cardinality ?? "many_to_many",
      inverseKey: input.inverseKey ?? null,
      inverseLabel: input.inverseLabel ?? null,
      status: input.status ?? "confirmed",
      source: input.source ?? "user_manual",
      confidence: input.confidence == null ? null : String(input.confidence),
    })
    .returning();
  if (!row) {
    return throwHttpError(500, internalError());
  }
  return row;
};
