import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { parseOrganizationRole } from "../../../authz/load-principal";
import type { UserPrincipal } from "../../../authz/principal";
import type { LoadedNode } from "../../../authz/resources/types";
import db from "../../../db";
import { invitation, member, user } from "../../../db/schema";
import { PENDING_INVITATION_LIMIT } from "../../../lib/auth-constants";
import { notFound, throwHttpError } from "../../../lib/errors";
import { organizationAdapter } from "../../../lib/org-adapter";
import type { AccessLevel, OrganizationRole } from "../../../schemas/access";
import type {
  GuestInviteOutcome,
  GuestInviteResult,
  SharingResourceType,
} from "../../../schemas/access-sharing";
import { ERROR_CODES } from "../../../schemas/errors";
import { sendOrganizationInvitationEmail } from "../../invitations/send-invitation-email";
import { recordAccessEvents } from "../record-event";
import { describeResourceAccess } from "../sharing/describe";
import { requireSharingRights } from "../sharing/manage-rights";
import { resolvePrincipals } from "../sharing/principals";
import {
  assertShareable,
  requireSharingPolicy,
  writeShares,
} from "../sharing/share";
import {
  lockInvitationGrant,
  upsertInvitationGrant,
} from "./invitation-grants";
import {
  assertInvitationLevel,
  type InvitationFacts,
  invitationNewcomer,
  toFacts,
} from "./invitation-terms";
import { tellGuestsShared } from "./tell-guests-shared";

/**
 * Share a resource with people by EMAIL — the share dialog's "Invite" box,
 * for whoever the address belongs to:
 *
 *   - someone of the organization, a member or a guest already: they are
 *     given access now, through the share dialog's own door (`writeShares`:
 *     the same policy, ceilings, guest period and journal);
 *   - an address with an invitation on its way: this item joins what that
 *     invitation gives, on the terms of the role it invites them to;
 *   - anyone else: invited as a GUEST — someone from outside who will see
 *     only what is shared with them — and given access once they accept
 *     (`accept-invitation.ts`).
 *
 * Takes full access, never from a guest (`requireSharingRights`), and the
 * organization's policy: inviting a guest is `guests.invite` in the item's
 * team. Every address is checked before anything is written or sent, so a
 * refusal leaves nothing half-done; then one address at a time, and an email
 * that cannot be sent withdraws what it would have announced (`failed`).
 */
export const inviteGuests = async (input: {
  principal: UserPrincipal;
  type: SharingResourceType;
  id: string;
  emails: readonly string[];
  level: AccessLevel;
}): Promise<GuestInviteResult> => {
  const { principal, type, id, level } = input;
  const { organizationId } = principal;
  const { node } = await requireSharingRights({ principal, type, id });
  // What this type offers a person — a collection offers people nothing.
  assertShareable(type, level, [{ type: "user", id: principal.userId }]);

  const emails = [
    ...new Set(input.emails.map((email) => email.trim().toLowerCase())),
  ];
  const people = await peopleByEmail(organizationId, emails);
  const agent = emails.find((email) => people.get(email)?.role === "bot");
  if (agent !== undefined) {
    return throwHttpError(400, {
      code: ERROR_CODES.INVITEE_NOT_INVITABLE,
      message: `${agent} is a team's assistant account, not a person.`,
    });
  }

  const known = emails.filter((email) => people.has(email));
  const strangers = emails.filter((email) => !people.has(email));
  const invitations = await prepareInvitations({
    principal,
    node,
    level,
    emails: strangers,
  });

  const outcomes = new Map<string, GuestInviteOutcome>();
  if (known.length > 0) {
    const grantees = await resolvePrincipals(
      organizationId,
      known.flatMap((email) => {
        const person = people.get(email);
        return person ? [{ type: "user" as const, id: person.userId }] : [];
      }),
    );
    const { newcomers } = await writeShares({
      principal,
      node,
      type,
      grantees: [...grantees.values()],
      level,
    });
    await tellGuestsShared({ principal, node, type, level, newcomers });
    for (const email of known) outcomes.set(email, { email, status: "shared" });
  }
  for (const outcome of await sendInvitations({
    principal,
    node,
    type,
    level,
    invitations,
  })) {
    outcomes.set(outcome.email, outcome);
  }

  return {
    outcomes: emails.flatMap((email) => {
      const outcome = outcomes.get(email);
      return outcome ? [outcome] : [];
    }),
    access: await describeResourceAccess({ principal, type, id }),
  };
};

/** A person of the organization, by the address they sign in with. */
interface KnownPerson {
  readonly userId: string;
  readonly role: OrganizationRole;
}

const peopleByEmail = async (
  organizationId: string,
  emails: readonly string[],
): Promise<Map<string, KnownPerson>> => {
  if (emails.length === 0) return new Map();
  const rows = await db
    .select({
      email: sql<string>`lower(${user.email})`,
      userId: member.userId,
      role: member.role,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(
        eq(member.organizationId, organizationId),
        inArray(sql`lower(${user.email})`, [...emails]),
      ),
    );
  return new Map(
    rows.map((row) => [
      row.email,
      { userId: row.userId, role: parseOrganizationRole(row.role) },
    ]),
  );
};

/** One address to invite, resolved before anything is sent. */
interface PreparedInvitation {
  readonly email: string;
  /** The invitation already on its way to them; null when one is sent now. */
  readonly pending: InvitationFacts | null;
}

/** A guest's invitation, as the terms read the one about to be sent. */
const NEW_GUEST = { role: "guest", teamIds: [] } as const;

/**
 * Resolve and check every address that belongs to nobody in the
 * organization. An invitation already on its way keeps its role: a future
 * member is shared with as a member of the teams it joins, anyone else as a
 * guest (`invitation-terms.ts`).
 */
const prepareInvitations = async (input: {
  principal: UserPrincipal;
  node: LoadedNode;
  level: AccessLevel;
  emails: readonly string[];
}): Promise<PreparedInvitation[]> => {
  const { principal, node, level, emails } = input;
  if (emails.length === 0) return [];

  const pendingRows = await db
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      teamId: invitation.teamId,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, principal.organizationId),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(invitation.createdAt));
  // The newest invitation to each address is the one its link is in.
  const latest = new Map<string, InvitationFacts>();
  for (const row of pendingRows) {
    const facts = toFacts(row);
    if (!latest.has(facts.email)) latest.set(facts.email, facts);
  }

  const prepared = emails.map((email): PreparedInvitation => ({
    email,
    pending: latest.get(email) ?? null,
  }));
  for (const entry of prepared) {
    assertInvitationLevel(node, level, {
      email: entry.email,
      ...(entry.pending ?? NEW_GUEST),
    });
  }
  await requireSharingPolicy({
    principal,
    node,
    newcomers: prepared.map((entry) =>
      invitationNewcomer(entry.pending ?? NEW_GUEST),
    ),
  });

  const fresh = prepared.filter((entry) => entry.pending === null).length;
  if (fresh > 0 && pendingRows.length + fresh > PENDING_INVITATION_LIMIT) {
    throwHttpError(409, {
      code: ERROR_CODES.INVITATION_LIMIT_REACHED,
      message: `The organization can't have more than ${PENDING_INVITATION_LIMIT.toString()} pending invitations.`,
    });
  }
  return prepared;
};

/**
 * Send each invitation — a new guest invitation, or the one already on its
 * way, now naming this item too — one address at a time.
 */
const sendInvitations = async (input: {
  principal: UserPrincipal;
  node: LoadedNode;
  type: SharingResourceType;
  level: AccessLevel;
  invitations: readonly PreparedInvitation[];
}): Promise<GuestInviteOutcome[]> => {
  if (input.invitations.length === 0) return [];
  const { principal } = input;
  const [inviter, organization] = await Promise.all([
    db.query.user.findFirst({ where: { id: principal.userId } }),
    db.query.organization.findFirst({
      columns: { name: true },
      where: { id: principal.organizationId },
    }),
  ]);
  if (!inviter || !organization) {
    return throwHttpError(404, notFound("Organization not found"));
  }

  const outcomes: GuestInviteOutcome[] = [];
  for (const entry of input.invitations) {
    outcomes.push(
      // eslint-disable-next-line no-await-in-loop -- one address at a time
      await sendInvitation({
        ...input,
        entry,
        inviter,
        organizationName: organization.name,
      }),
    );
  }
  return outcomes;
};

/**
 * One address: its invitation (created as a guest's when none is on its
 * way), its email, and — once the email is out — the grant that makes the
 * item part of what accepting gives. An email that cannot be sent gives
 * nothing, and withdraws an invitation created for it.
 */
const sendInvitation = async (input: {
  principal: UserPrincipal;
  node: LoadedNode;
  type: SharingResourceType;
  level: AccessLevel;
  entry: PreparedInvitation;
  inviter: typeof user.$inferSelect;
  organizationName: string;
}): Promise<GuestInviteOutcome> => {
  const { principal, node, type, level, entry } = input;
  const { organizationId } = principal;
  const adapter = await organizationAdapter();

  const created =
    entry.pending === null
      ? await adapter.createInvitation({
          invitation: {
            email: entry.email,
            role: "guest",
            organizationId,
            teamIds: [],
          },
          user: input.inviter,
        })
      : null;
  const target: InvitationFacts | null =
    entry.pending ?? (created ? toFacts(created) : null);
  if (target === null) return { email: entry.email, status: "failed" };

  try {
    await sendOrganizationInvitationEmail({
      invitationId: target.id,
      email: entry.email,
      inviterName: input.inviter.name,
      organizationName: input.organizationName,
      role: target.role,
      teamId: target.teamIds[0] ?? null,
      expiresAt: target.expiresAt,
      item: { type, id: node.id, name: node.name, level, teamId: node.teamId },
    });
  } catch (err) {
    console.warn(`[guests] invitation email to ${entry.email} failed:`, err);
    if (created) {
      await adapter.updateInvitation({
        invitationId: created.id,
        status: "canceled",
        fromStatus: "pending",
      });
    }
    return { email: entry.email, status: "failed" };
  }

  await db.transaction(async (tx) => {
    const resource = { type, id: node.id };
    const previous = await lockInvitationGrant(tx, resource, target.id);
    await upsertInvitationGrant(tx, {
      organizationId,
      resource,
      invitationId: target.id,
      level,
      actorUserId: principal.userId,
    });
    await recordAccessEvents(tx, [
      ...(created
        ? [
            {
              organizationId,
              actorUserId: principal.userId,
              action: "invitation.sent" as const,
              principal: { type: "invitation" as const, id: target.id },
              metadata: { email: entry.email, role: "guest" },
            },
          ]
        : []),
      {
        organizationId,
        actorUserId: principal.userId,
        action: previous === null ? "grant.created" : "grant.updated",
        resource,
        principal: { type: "invitation", id: target.id },
        metadata: {
          level,
          ...(previous === null ? {} : { previousLevel: previous.level }),
          principalName: entry.email,
          resourceName: node.name,
        },
      },
    ]);
  });
  return { email: entry.email, status: "invited" };
};
