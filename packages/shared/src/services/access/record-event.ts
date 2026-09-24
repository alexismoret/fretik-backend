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
export interface AccessEvent {
  organizationId: string;
  /** Null when the change was the system's own (a departure, a trigger). */
  actorUserId: string | null;
  action: AccessAuditAction;
  resource?: { type: AccessResourceType; id: string };
  principal?: { type: AccessPrincipalType; id: string };
  metadata?: Record<string, unknown>;
}

const rowOf = (event: AccessEvent) => ({
  organizationId: event.organizationId,
  actorUserId: event.actorUserId,
  action: event.action,
  resourceType: event.resource?.type ?? null,
  resourceId: event.resource?.id ?? null,
  principalType: event.principal?.type ?? null,
  principalId: event.principal?.id ?? null,
  metadata: event.metadata ?? null,
});

export const recordAccessEvent = async (
  input: AccessEvent & { executor?: Executor },
): Promise<void> => {
  await (input.executor ?? db).insert(accessAuditLog).values(rowOf(input));
};

/** Several changes made together (one share to many), in one statement. */
export const recordAccessEvents = async (
  executor: Executor,
  events: readonly AccessEvent[],
): Promise<void> => {
  if (events.length === 0) return;
  await executor.insert(accessAuditLog).values(events.map(rowOf));
};
