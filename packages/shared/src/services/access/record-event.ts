import db, { type Executor } from "../../db";
import { accessAuditLog } from "../../db/schema";
import type {
  AccessAuditAction,
  AccessPrincipalType,
  AccessResourceType,
} from "../../schemas/access";

/**
 * The access journal: who changed who may do what — a team role, a
 * membership, a policy, a grant.
 *
 * Written in the SAME transaction as the change when the change is ours to
 * write, so the journal never records something that did not happen nor
 * misses something that did. When Better Auth's adapter makes the write (a
 * seat in a team, a membership), its transaction is its own: the entry
 * follows it, and records what has already happened.
 *
 * Names go into `metadata` at write time — a person renamed or a team deleted
 * later still reads as it was — and nothing of a resource's content is ever
 * recorded: the journal says who may open a page, not what the page says.
 */
export const recordAccessEvent = async (input: {
  executor?: Executor;
  organizationId: string;
  /** Null when the change was the system's own (a departure, a trigger). */
  actorUserId: string | null;
  action: AccessAuditAction;
  resource?: { type: AccessResourceType; id: string };
  principal?: { type: AccessPrincipalType; id: string };
  metadata?: Record<string, unknown>;
}): Promise<void> => {
  await (input.executor ?? db).insert(accessAuditLog).values({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: input.action,
    resourceType: input.resource?.type ?? null,
    resourceId: input.resource?.id ?? null,
    principalType: input.principal?.type ?? null,
    principalId: input.principal?.id ?? null,
    metadata: input.metadata ?? null,
  });
};
