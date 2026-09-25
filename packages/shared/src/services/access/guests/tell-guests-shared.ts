import { inArray } from "drizzle-orm";
import { guestAccessExpiry } from "../../../authz/guests";
import type { UserPrincipal } from "../../../authz/principal";
import type { LoadedNode } from "../../../authz/resources/types";
import db from "../../../db";
import { user } from "../../../db/schema";
import { generateSharedWithGuestEmail } from "../../../emails/generators";
import { sendEmail } from "../../../lib/email";
import { normalizeLocale } from "../../../lib/locales";
import type { AccessLevel } from "../../../schemas/access";
import type { SharingResourceType } from "../../../schemas/access-sharing";
import { getOrganizationAccessPolicy } from "../../organization/access-policy";
import type { Grantee } from "../sharing/principals";

/**
 * Tell the guests a share just reached, by email. A member finds what is
 * shared with them under "Shared with me"; a guest does not wander the
 * organization's workspace, so without this they would never learn it is
 * there. Only the guests given access for the FIRST time: a level change
 * says nothing new about where to look.
 *
 * Best effort, once the share has committed, as every email of the sharing
 * services: a send that fails is logged, never surfaced to whoever shared.
 */
export const tellGuestsShared = async (input: {
  principal: UserPrincipal;
  node: LoadedNode;
  type: SharingResourceType;
  level: AccessLevel;
  newcomers: readonly Grantee[];
}): Promise<void> => {
  const guestIds = input.newcomers.flatMap((grantee) =>
    grantee.guest && grantee.type === "user" ? [grantee.id] : [],
  );
  if (guestIds.length === 0) return;
  try {
    const { principal, node } = input;
    const [sharer, organization, policy, recipients] = await Promise.all([
      db.query.user.findFirst({
        columns: { name: true },
        where: { id: principal.userId },
      }),
      db.query.organization.findFirst({
        columns: { name: true },
        where: { id: principal.organizationId },
      }),
      getOrganizationAccessPolicy(principal.organizationId),
      db
        .select({
          name: user.name,
          email: user.email,
          language: user.language,
        })
        .from(user)
        .where(inArray(user.id, guestIds)),
    ]);
    const expiresAt = guestAccessExpiry(policy);
    await Promise.all(
      recipients.map(async (recipient) => {
        const { subject, html } = await generateSharedWithGuestEmail(
          {
            recipientName: recipient.name,
            sharerName: sharer?.name ?? "",
            organizationName: organization?.name ?? "",
            resource: { type: input.type, id: node.id, name: node.name },
            level: input.level,
            expiresAt,
          },
          normalizeLocale(recipient.language),
        );
        await sendEmail({ to: { email: recipient.email }, subject, html });
      }),
    );
  } catch (err) {
    console.warn("[guests] shared-with-you email failed:", err);
  }
};
