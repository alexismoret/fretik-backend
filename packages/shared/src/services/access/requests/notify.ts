import { inArray } from "drizzle-orm";
import { resourceContacts } from "../../../authz/contacts";
import { loadPrincipal } from "../../../authz/load-principal";
import type { LoadedNode } from "../../../authz/resources/types";
import { computeLevel } from "../../../authz/rules";
import db from "../../../db";
import { type AccessRequest, user } from "../../../db/schema";
import {
  generateAccessRequestDecidedEmail,
  generateAccessRequestEmail,
} from "../../../emails/generators";
import { sendEmail } from "../../../lib/email";
import { normalizeLocale } from "../../../lib/locales";
import type { AccessLevel } from "../../../schemas/access";
import type { SharingResourceType } from "../../../schemas/access-sharing";

/**
 * The emails of an access request: to the people who can answer it when it
 * is made, to the requester once it is answered. Best effort: a send that
 * fails is logged, never surfaced to the person who asked or answered — the
 * request and its answer are already saved.
 */

const recipientsById = async (userIds: readonly string[]) =>
  userIds.length === 0
    ? []
    : db
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          language: user.language,
        })
        .from(user)
        .where(inArray(user.id, [...userIds]));

/**
 * Who is told of a new request: the people who can answer it — the owner and
 * whoever holds full access — never someone the contacts would name who does
 * not in fact have full access to it (an admin reads nothing by role).
 */
export const notifyAccessRequested = async (input: {
  request: AccessRequest;
  resource: { type: SharingResourceType; node: LoadedNode };
  requesterName: string;
  level: AccessLevel;
}): Promise<void> => {
  const { request, resource } = input;
  try {
    const contacts = await resourceContacts({
      organizationId: request.organizationId,
      resourceType: resource.type,
      resourceId: resource.node.id,
      ownerUserId: resource.node.ownerUserId,
      teamId: resource.node.teamId,
      excludeUserId: request.requesterUserId,
    });
    const deciders = (
      await Promise.all(
        contacts.map(async (contact) => {
          const principal = await loadPrincipal({
            organizationId: request.organizationId,
            userId: contact.userId,
          });
          return principal !== null &&
            computeLevel(principal, resource.node) === "full"
            ? [contact.userId]
            : [];
        }),
      )
    ).flat();

    for (const recipient of await recipientsById(deciders)) {
      const { subject, html } = await generateAccessRequestEmail(
        {
          requestId: request.id,
          recipientName: recipient.name,
          requesterName: input.requesterName,
          resourceName: resource.node.name,
          level: input.level,
          message: request.message,
        },
        normalizeLocale(recipient.language),
      );
      // oxlint-disable-next-line no-await-in-loop -- a handful of people, each their own language
      await sendEmail({
        to: { email: recipient.email, name: recipient.name },
        subject,
        html,
      });
    }
  } catch (err) {
    console.warn(`[access-request] could not notify for ${request.id}:`, err);
  }
};

/** Tell each requester their request was answered, and how. */
export const notifyAccessDecided = async (input: {
  requests: readonly AccessRequest[];
  resource: { type: SharingResourceType; id: string; name: string };
  decision: "approved" | "denied";
  level: AccessLevel | null;
  deciderName: string;
}): Promise<void> => {
  try {
    const recipients = await recipientsById(
      input.requests.map((request) => request.requesterUserId),
    );
    for (const recipient of recipients) {
      const { subject, html } = await generateAccessRequestDecidedEmail(
        {
          recipientName: recipient.name,
          resource: input.resource,
          decision: input.decision,
          level: input.level,
          deciderName: input.deciderName,
        },
        normalizeLocale(recipient.language),
      );
      // oxlint-disable-next-line no-await-in-loop -- one per requester
      await sendEmail({
        to: { email: recipient.email, name: recipient.name },
        subject,
        html,
      });
    }
  } catch (err) {
    console.warn("[access-request] could not notify of a decision:", err);
  }
};
