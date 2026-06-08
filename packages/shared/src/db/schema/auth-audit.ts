import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth-schema";

/**
 * Lightweight security audit trail for auth-sensitive events (sign-in,
 * email change, password reset, ...). Written from the Better Auth database
 * hooks in `lib/auth.ts`. `userId` is nullable with `ON DELETE SET NULL` so
 * the trail survives account deletion.
 */
export const authAuditLog = pgTable(
  "auth_audit_log",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),
    userId: uuid("user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    event: text("event").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("authAuditLog_userId_idx").on(table.userId),
    index("authAuditLog_event_idx").on(table.event),
  ],
);
