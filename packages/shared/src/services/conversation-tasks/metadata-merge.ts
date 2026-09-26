import { type SQL, sql } from "drizzle-orm";
import type { ConversationTaskMetadata } from "../../db/schema";
import { conversationBackgroundTasks } from "../../db/schema";

/**
 * The SQL that merges `patch` into a task row's metadata: top-level keys
 * replace, and an object-valued key (`subAgent`) is merged one level down
 * rather than replaced.
 *
 * One level down is what keeps two writers from erasing each other. A running
 * sub-agent rewrites its whole live state every few seconds while a stop
 * request (`request-sub-agent-stop.ts`) or a workflow's billing stamp
 * (`sub-agent-spend.ts`) sets one field of the same object from elsewhere — a
 * top-level `||` would drop that field on the next progress write.
 */
export const mergeTaskMetadata = (patch: ConversationTaskMetadata): SQL => {
  let merged: SQL = sql`coalesce(${conversationBackgroundTasks.metadata}, '{}'::jsonb)`;
  for (const [key, value] of Object.entries(patch)) {
    const json = JSON.stringify(value);
    merged =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? sql`(${merged} || jsonb_build_object(${key}::text, coalesce(${merged} -> ${key}::text, '{}'::jsonb) || ${json}::jsonb))`
        : sql`(${merged} || jsonb_build_object(${key}::text, ${json}::jsonb))`;
  }
  return merged;
};
