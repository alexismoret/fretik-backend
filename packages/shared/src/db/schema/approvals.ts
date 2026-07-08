import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { RecordRelationInput } from "../../services/links/resolve-relation-inputs";
import { aiConversations } from "./ai";
import { organization, team, user } from "./auth-schema";

/**
 * Approvals — the human-in-the-loop decision gate shared by the chatbot and the
 * workflow executor. ONE lifecycle (pending→granted→executing→consumed /
 * rejected) serves every decision the agent needs a human to make; the `kind`
 * selects the payload shape and how a grant is executed. The domain is generic
 * on purpose — external-app write plans are just one kind among several.
 */

/**
 * Status of an approval request.
 *
 *  - `pending`   : awaiting the user's decision. Never expires — a request
 *                  stays actionable indefinitely (the user can approve it
 *                  days later; the card re-renders on conversation reload).
 *  - `granted`   : the user approved; not yet executed.
 *  - `executing` : claimed atomically from `granted` — execution in progress.
 *                  A re-run that lands here gets an explicit error (never a
 *                  silent NULL result), closing the crash window between
 *                  "consume the grant" and "store the result".
 *  - `consumed`  : executed; `result` holds the outcome. A re-run of the
 *                  identical hashed call returns this cached `result` — no
 *                  double-execute.
 *  - `rejected`  : the user refused; `decisionFeedback` carries their note.
 */
export const toolApprovalStatusEnum = pgEnum("tool_approval_status", [
  "pending",
  "granted",
  "executing",
  "consumed",
  "rejected",
]);

/**
 * What kind of decision a `tool_approval_requests` row gates. One approval
 * lifecycle serves all three; the `kind` selects the payload shape and how
 * `grant` executes:
 *  - `external_app_plan` : `run_plan([...])` write plan → executed via Nango.
 *  - `record_write`      : object records the agent proposes → written via
 *                          `bulk{Create,Update,Delete}ObjectRecords` on grant
 *                          (the user may select a subset).
 *  - `question`          : a structured question (askUserQuestion shape) →
 *                          no execution; grant just records the answers.
 */
export const toolApprovalKindEnum = pgEnum("tool_approval_kind", [
  "external_app_plan",
  "record_write",
  "question",
]);

/**
 * One row = ONE decision the agent parks for a human. For `external_app_plan`
 * it bundles N write operations behind a single approval; for `record_write` it
 * is one gated bulk object write; for `question` it is a structured question.
 *
 * `lookup_hash` is the gate key for the sandbox-driven kinds
 * (`external_app_plan`, `record_write`): sha256 over the write's *stable* args
 * (volatile/display fields excluded). Frozen at creation. On re-run the agent
 * re-emits the same code → same hash → the consumed grant is matched and its
 * cached result replayed (no double-execute). NULL for `question`, which never
 * re-emits an identical hashed call.
 *
 * Requests never expire: there is no `expires_at`. The durable state lives
 * here; the E2B sandbox may be recycled between turns without consequence.
 */
export const toolApprovalRequests = pgTable(
  "tool_approval_requests",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),

    /** What this row gates — selects the payload shape + grant execution. */
    kind: toolApprovalKindEnum("kind").notNull().default("external_app_plan"),

    /** Sandbox turn that produced this request — UI correlation only. */
    turnId: varchar("turn_id", { length: 128 }).notNull(),

    /** Gate key — sha256 of the write's stable args, frozen at creation.
     * Sandbox-driven kinds (`external_app_plan`, `record_write`); NULL for
     * `question`, which never re-emits an identical hashed call. */
    lookupHash: varchar("lookup_hash", { length: 64 }),

    /**
     * The plan: `[{ action, args }, …]`. `args` are the executable args,
     * mutable via `modify-and-grant`. Execution always uses these stored
     * args, never the args of a re-run call. `external_app_plan` only.
     */
    operations: jsonb("operations").$type<ToolApprovalOperation[]>(),
    itemCount: integer("item_count").notNull().default(0),

    /** Display payload for the `external_app_plan` card — built by the
     * summary fns. NULL for `record_write` / `question`, which render from
     * `payload` (structured data) instead of an i18n-keyed summary. */
    summary: jsonb("summary").$type<ToolApprovalSummary>(),

    /**
     * Kind-specific structured payload the frontend renders directly:
     *  - `record_write` → `ToolApprovalRecordWritePayload` (object type +
     *    proposed records, shown field-by-field, selectable).
     *  - `question`     → `ToolApprovalQuestionPayload` (askUserQuestion shape).
     * NULL for `external_app_plan` (which uses `operations` + `summary`).
     */
    payload: jsonb("payload").$type<ToolApprovalPayload>(),

    /**
     * Decision outcome, kind-specific: `external_app_plan` → per-op results
     * (written incrementally as ops complete); `record_write` → per-record
     * results; `question` → the captured answers. NULL until decided.
     */
    result: jsonb("result").$type<ToolApprovalResult>(),

    status: toolApprovalStatusEnum("status").notNull().default("pending"),

    decisionAt: timestamp("decision_at", {
      mode: "date",
      withTimezone: true,
    }),
    decidedByUserId: uuid("decided_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    decisionFeedback: text("decision_feedback"),

    executedAt: timestamp("executed_at", {
      mode: "date",
      withTimezone: true,
    }),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("idx_tar_lookup").on(t.conversationId, t.lookupHash, t.status),
    index("idx_tar_conversation").on(t.conversationId),
  ],
);

// ---- Plan (external_app_plan) payload ------------------------------------

/** One write operation inside a plan. */
export interface ToolApprovalOperation {
  /** Fully-qualified action name, e.g. `outlook.send_email`. */
  action: string;
  /** Executable args (validated against the manifest at dispatch). */
  args: Record<string, unknown>;
}

/**
 * A field shown on the approval card. The label is referenced by i18n key
 * (`chatbot.approvals.fields.<labelKey>`) so the frontend can translate it;
 * the value is data (recipients, subject, etc.) and is shown as-is.
 */
export interface ToolApprovalSummaryField {
  /** i18n key suffix under `chatbot.approvals.fields.*`. */
  labelKey: string;
  value: string;
  /** `text` (default) or `html` (rendered) for rich values like email bodies. */
  kind?: "text" | "html";
}

/**
 * Approval card payload — fully translatable. Every human string is an
 * i18n key + interpolation params; the backend never composes display
 * strings.
 */
export interface ToolApprovalSummary {
  /** i18n key for the plan-level title (e.g. `chatbot.approvals.plan.title`). */
  titleKey: string;
  /** Interpolation values for the plan title (e.g. `{ count: 3 }`). */
  titleParams?: Record<string, string | number>;
  operations: ToolApprovalOperationSummary[];
}

export interface ToolApprovalOperationSummary {
  providerKey: string;
  action: string;
  /** i18n key under `chatbot.approvals.<providerKey>.<action>.title`. */
  titleKey: string;
  titleParams?: Record<string, string | number>;
  fields: ToolApprovalSummaryField[];
}

/** Outcome of a single operation after execution. */
export type ToolApprovalOpResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

// ---- Question payload -----------------------------------------------------

/** One question in a `question` approval — mirrors the askUserQuestion tool
 * shape so the same option/free-text UI renders it. */
export interface ToolApprovalQuestion {
  question: string;
  /** Short chip label (≤12 chars). */
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export interface ToolApprovalQuestionPayload {
  questions: ToolApprovalQuestion[];
}

// ---- Record-write payload -------------------------------------------------

/** Which record write a `record_write` approval gates — one bulk op from the
 * Python `objects` SDK (`records.bulk_create` / `bulk_update` / `bulk_delete`). */
export type ToolApprovalRecordWriteOp = "create" | "update" | "delete";

/** One item in a gated record write, shown on the card and re-executed on
 * grant. `create` → `data` (new fields) + optional outgoing `relations`;
 * `update` → `recordId` + `data` (changed fields) + `currentData`/`currentLabel`
 * for the before→after view; `delete` → `recordId` + `currentData`/`currentLabel`
 * for the full-record preview. `objectTypeId` is per-item because update/delete
 * may span types. */
export interface ToolApprovalRecordWriteItem {
  data?: Record<string, unknown>;
  relations?: RecordRelationInput[];
  recordId?: string;
  currentLabel?: string;
  /** Snapshot of the target record's field values at proposal time — powers
   * the field-type-aware before→after (update) / preview (delete) card.
   * Display-only: excluded from the lookup hash. */
  currentData?: Record<string, unknown>;
  /** Per-item type, for update/delete cards that span object types. */
  objectTypeId?: string;
  typeKey?: string;
}

export interface ToolApprovalRecordWritePayload {
  op: ToolApprovalRecordWriteOp;
  /** Object type of the affected records — present for create (single type);
   * for update/delete the per-item `objectTypeId` is authoritative (may span
   * types). Display metadata for the card. */
  typeKey?: string;
  objectTypeId?: string;
  typeName?: string;
  typeIcon?: string;
  typeColor?: string;
  /** `bulk_update` merge mode — `true` patches provided keys, `false` (default
   * of the bulk service) full-replaces. Captured from the SDK call so the grant
   * writes with the semantics the agent intended. `update` only. */
  merge?: boolean;
  /** The write items — the user reviews and approves a subset. */
  items: ToolApprovalRecordWriteItem[];
  /** Optional one-line rationale from the agent. */
  note?: string;
}

export type ToolApprovalPayload =
  | ToolApprovalQuestionPayload
  | ToolApprovalRecordWritePayload;

/** Answers captured on a `question` grant, keyed by question header. */
export type ToolApprovalAnswers = Record<string, string>;

/** Per-record outcome of a `record_write` grant — positionally aligned with
 * the payload's `items` (only the selected subset is executed; unselected
 * entries are `{ skipped: true }`). */
export type ToolApprovalRecordResult =
  | { ok: true; id: string; label: string }
  | { ok: false; error: string }
  | { skipped: true };

/** Union of what `result` holds, keyed by the row's `kind`. */
export type ToolApprovalResult =
  | ToolApprovalOpResult[]
  | ToolApprovalRecordResult[]
  | ToolApprovalAnswers;

export type ToolApprovalRequest = typeof toolApprovalRequests.$inferSelect;
export type NewToolApprovalRequest = typeof toolApprovalRequests.$inferInsert;
export type ToolApprovalStatus = ToolApprovalRequest["status"];
export type ToolApprovalKind = ToolApprovalRequest["kind"];
