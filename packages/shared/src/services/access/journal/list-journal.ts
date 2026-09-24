import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  type EngineResourceType,
  isEngineResourceType,
  resolveAccessMany,
} from "../../../authz/access";
import { requireCapability } from "../../../authz/gates";
import type { UserPrincipal } from "../../../authz/principal";
import db from "../../../db";
import { accessAuditLog, projects, team, user } from "../../../db/schema";
import { badRequest, throwHttpError } from "../../../lib/errors";
import {
  accessAuditActionSchema,
  type AccessLevel,
  accessLevelSchema,
  type AccessPrincipalType,
  type AccessResourceType,
} from "../../../schemas/access";
import {
  type AccessJournalDetails,
  type AccessJournalEntry,
  type AccessJournalPage,
  type AccessJournalQuery,
  JOURNAL_ACTIONS,
} from "../../../schemas/access-journal";

/**
 * The access journal, for whoever may read it (`audit.read`: the
 * organization's admins): every change to who may do what, newest first, a
 * page at a time, filtered by kind of change or by person.
 *
 * The journal keeps names as they were when the change was made
 * (`record-event.ts`). An item's name is shown only to a reader who can open
 * it now: admins run the organization's structure, not its people's work, and
 * a private file's name is part of the work. "Olivia shared a file with Marc"
 * is there for every reader; which file, only for whoever could open it. The
 * same holds for a project named as a group something was shared with, or as
 * the place something moved from or to. People, teams, invitations and
 * policies are the structure the reader runs, and are always named.
 */
export const listAccessJournal = async (input: {
  principal: UserPrincipal;
  query: AccessJournalQuery;
}): Promise<AccessJournalPage> => {
  const { principal, query } = input;
  await requireCapability({ principal, capability: "audit.read" });

  const after = query.cursor === undefined ? null : parseCursor(query.cursor);
  const rows = await db
    .select({
      id: accessAuditLog.id,
      // Microseconds and all: the cursor must name this exact row.
      at: sql<string>`${accessAuditLog.createdAt}::text`,
      createdAt: accessAuditLog.createdAt,
      action: accessAuditLog.action,
      actorUserId: accessAuditLog.actorUserId,
      actorName: user.name,
      resourceType: accessAuditLog.resourceType,
      resourceId: accessAuditLog.resourceId,
      principalType: accessAuditLog.principalType,
      principalId: accessAuditLog.principalId,
      metadata: accessAuditLog.metadata,
    })
    .from(accessAuditLog)
    .leftJoin(user, eq(user.id, accessAuditLog.actorUserId))
    .where(
      and(
        eq(accessAuditLog.organizationId, principal.organizationId),
        query.category === undefined
          ? undefined
          : inArray(accessAuditLog.action, [
              ...JOURNAL_ACTIONS[query.category],
            ]),
        query.userId === undefined
          ? undefined
          : or(
              eq(accessAuditLog.actorUserId, query.userId),
              and(
                eq(accessAuditLog.principalType, "user"),
                eq(accessAuditLog.principalId, query.userId),
              ),
            ),
        after === null
          ? undefined
          : sql`(${accessAuditLog.createdAt}, ${accessAuditLog.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`,
      ),
    )
    .orderBy(desc(accessAuditLog.createdAt), desc(accessAuditLog.id))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const names = await namesFor(principal, page);
  return {
    entries: page.flatMap((row) => {
      const entry = toEntry(row, names);
      return entry === null ? [] : [entry];
    }),
    nextCursor:
      rows.length > query.limit && last ? cursorOf(last.at, last.id) : null,
  };
};

type JournalRow = {
  id: string;
  at: string;
  createdAt: Date;
  action: string;
  actorUserId: string | null;
  actorName: string | null;
  resourceType: AccessResourceType | null;
  resourceId: string | null;
  principalType: AccessPrincipalType | null;
  principalId: string | null;
  metadata: Record<string, unknown> | null;
};

// --- The cursor: where a page stopped ----------------------------------------

const cursorOf = (at: string, id: string): string =>
  Buffer.from(`${at}|${id}`).toString("base64url");

const parseCursor = (cursor: string): { at: string; id: string } => {
  const [at, id] = Buffer.from(cursor, "base64url").toString().split("|");
  if (!at || !id || Number.isNaN(Date.parse(at))) {
    return throwHttpError(400, badRequest("This page of the journal is gone."));
  }
  return { at, id };
};

// --- Names the reader may read ------------------------------------------------

interface Names {
  /** Whether the reader can open this item now. */
  canOpen: (type: EngineResourceType, id: string) => boolean;
  /** Current names, for the entries that were written without one. */
  person: (id: string) => string | null;
  team: (id: string) => string | null;
  project: (id: string) => string | null;
  organization: string | null;
}

/** A project an entry names as where something moved from or to. */
const movedProjectId = (value: unknown): string | null =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "string"
    ? value.id
    : null;

/**
 * Everything a page needs beyond its rows, in one batch per kind: which of
 * its items the reader can open, and the current names of the people, teams
 * and projects its entries name without a name of their own.
 */
const namesFor = async (
  principal: UserPrincipal,
  rows: readonly JournalRow[],
): Promise<Names> => {
  const items = new Map<EngineResourceType, Set<string>>();
  const people = new Set<string>();
  const teams = new Set<string>();
  const want = (type: EngineResourceType, id: string) => {
    const ids = items.get(type) ?? new Set<string>();
    ids.add(id);
    items.set(type, ids);
  };
  for (const row of rows) {
    if (row.resourceType && row.resourceId) {
      if (isEngineResourceType(row.resourceType)) {
        want(row.resourceType, row.resourceId);
      }
    }
    if (row.principalId !== null) {
      if (row.principalType === "project") want("project", row.principalId);
      if (row.principalType === "user") people.add(row.principalId);
      if (row.principalType === "team") teams.add(row.principalId);
    }
    for (const id of [
      movedProjectId(row.metadata?.from),
      movedProjectId(row.metadata?.to),
    ]) {
      if (id !== null) want("project", id);
    }
  }

  const [open, personRows, teamRows, projectRows, org] = await Promise.all([
    Promise.all(
      [...items].map(async ([type, ids]) => {
        const resolved = await resolveAccessMany(principal, type, [...ids]);
        return [...resolved.keys()].map((id) => `${type}:${id}`);
      }),
    ),
    people.size === 0
      ? []
      : db
          .select({ id: user.id, name: user.name })
          .from(user)
          .where(inArray(user.id, [...people])),
    teams.size === 0
      ? []
      : db
          .select({ id: team.id, name: team.name })
          .from(team)
          .where(
            and(
              eq(team.organizationId, principal.organizationId),
              inArray(team.id, [...teams]),
            ),
          ),
    (items.get("project")?.size ?? 0) === 0
      ? []
      : db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(
            and(
              eq(projects.organizationId, principal.organizationId),
              inArray(projects.id, [...(items.get("project") ?? [])]),
            ),
          ),
    db.query.organization.findFirst({
      columns: { name: true },
      where: { id: principal.organizationId },
    }),
  ]);
  const visible = new Set(open.flat());
  const byId = (list: readonly { id: string; name: string }[]) =>
    new Map(list.map((row) => [row.id, row.name]));
  const personNames = byId(personRows);
  const teamNames = byId(teamRows);
  const projectNames = byId(projectRows);
  return {
    canOpen: (type, id) => visible.has(`${type}:${id}`),
    person: (id) => personNames.get(id) ?? null,
    team: (id) => teamNames.get(id) ?? null,
    project: (id) => projectNames.get(id) ?? null,
    organization: org?.name ?? null,
  };
};

// --- One entry ----------------------------------------------------------------

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const levelOf = (value: unknown): AccessLevel | null => {
  const parsed = accessLevelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const toEntry = (row: JournalRow, names: Names): AccessJournalEntry | null => {
  const action = accessAuditActionSchema.safeParse(row.action);
  // An action this version does not know is not one it can explain.
  if (!action.success) return null;
  const meta = row.metadata ?? {};

  return {
    id: row.id,
    createdAt: row.createdAt,
    action: action.data,
    actor:
      row.actorUserId !== null && row.actorName !== null
        ? { userId: row.actorUserId, name: row.actorName }
        : null,
    resource: resourceOf(row, meta, names),
    principal: principalOf(row, meta, names),
    details: detailsOf(action.data, meta, names),
  };
};

/**
 * The item, named when the reader can open it now. A project deleted while
 * open to its team was no secret to anyone who runs the team, and keeps its
 * name; anything else gone is nameless.
 */
const resourceOf = (
  row: JournalRow,
  meta: Record<string, unknown>,
  names: Names,
): AccessJournalEntry["resource"] => {
  if (row.resourceType === null || row.resourceId === null) return null;
  const recorded = text(meta.resourceName) ?? text(meta.projectName);
  const openNow =
    isEngineResourceType(row.resourceType) &&
    names.canOpen(row.resourceType, row.resourceId);
  const deletedOpen =
    row.action === "project.deleted" && meta.restricted === false;
  return {
    type: row.resourceType,
    id: row.resourceId,
    name: openNow || deletedOpen ? recorded : null,
  };
};

/** Who or what a change was about, by the name it had then. */
const principalOf = (
  row: JournalRow,
  meta: Record<string, unknown>,
  names: Names,
): AccessJournalEntry["principal"] => {
  if (row.principalType === null || row.principalId === null) return null;
  const { principalId: id } = row;
  const recorded =
    text(meta.principalName) ??
    text(meta.userName) ??
    (row.action === "team.renamed" ? text(meta.to) : text(meta.teamName)) ??
    text(meta.email);
  const name = (() => {
    const { principalType: type } = row;
    // A project is named only to whoever can open it, like any item.
    if (type === "project") {
      return names.canOpen("project", id)
        ? (recorded ?? names.project(id))
        : null;
    }
    if (type === "invitation") return text(meta.email) ?? recorded;
    if (type === "organization") return recorded ?? names.organization;
    if (type === "team") return recorded ?? names.team(id);
    return recorded ?? names.person(id);
  })();
  return { type: row.principalType, id, name };
};

const detailsOf = (
  action: AccessJournalEntry["action"],
  meta: Record<string, unknown>,
  names: Names,
): AccessJournalDetails => {
  const moved = action === "project.content_moved";
  const projectAt = (value: unknown): { name: string | null } | null => {
    const id = movedProjectId(value);
    if (id === null) return null;
    const recorded =
      typeof value === "object" && value !== null && "name" in value
        ? text(value.name)
        : null;
    return { name: names.canOpen("project", id) ? recorded : null };
  };
  const expiresAt = text(meta.expiresAt);
  return {
    // A decided request carries what was asked, and what was given if any.
    level: levelOf(meta.level) ?? levelOf(meta.requestedLevel),
    previousLevel: levelOf(meta.previousLevel),
    restricted: typeof meta.restricted === "boolean" ? meta.restricted : null,
    decision: text(meta.decision),
    email: text(meta.email),
    role: text(meta.role),
    from: moved ? null : text(meta.from),
    to: moved ? null : text(meta.to),
    team: text(meta.teamName),
    fromProject: moved ? projectAt(meta.from) : null,
    toProject: moved ? projectAt(meta.to) : null,
    changes: Array.isArray(meta.changes)
      ? meta.changes.flatMap((change: unknown) =>
          typeof change === "object" &&
          change !== null &&
          "setting" in change &&
          typeof change.setting === "string"
            ? [
                {
                  setting: change.setting,
                  from: "from" in change ? change.from : null,
                  to: "to" in change ? change.to : null,
                },
              ]
            : [],
        )
      : null,
    left: meta.left === true,
    expiresAt: expiresAt === null ? null : new Date(expiresAt),
    items: typeof meta.items === "number" ? meta.items : null,
    reason: text(meta.reason),
  };
};
