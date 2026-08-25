import type { FieldDefinition } from "../../db/schema";
import { badRequest, throwHttpError } from "../../lib/errors";
import { filterTeamMemberIds } from "../team/members";

/**
 * Collect the userId(s) assigned to every `member` field in `data`. A
 * single-assignee field holds a string; a `multiple` one holds an array. Other
 * shapes are ignored here (the Zod record shape already rejected them).
 */
export const collectMemberUserIds = (
  fieldDefs: FieldDefinition[],
  data: Record<string, unknown>,
): string[] => {
  const ids: string[] = [];
  for (const def of fieldDefs) {
    if (def.type !== "member") continue;
    const value = data[def.key];
    if (typeof value === "string") {
      if (value) ids.push(value);
    } else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === "string" && v) ids.push(v);
    }
  }
  return ids;
};

/**
 * Reject a write that assigns a `member` field to anyone who is not a real
 * (non-bot) member of the team — the same guard `filterTeamMemberIds` applies
 * to conversation seating. Keeps assignment trustworthy: a teammate picker (or
 * the AI) can never point an "assignee"/"owner" at a user from another team or
 * the agent bot. No-op when the type has no `member` fields.
 */
export const assertMemberFieldsValid = async (input: {
  teamId: string;
  fieldDefs: FieldDefinition[];
  data: Record<string, unknown>;
}): Promise<void> => {
  const requested = collectMemberUserIds(input.fieldDefs, input.data);
  if (requested.length === 0) return;

  const allowed = new Set(await filterTeamMemberIds(input.teamId, requested));
  const invalid = requested.filter((id) => !allowed.has(id));
  if (invalid.length > 0) {
    return throwHttpError(
      400,
      badRequest(
        `Cannot assign member field(s) to non-team user(s): ${[...new Set(invalid)].join(", ")}.`,
      ),
    );
  }
};
