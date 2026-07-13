import { z } from "@hono/zod-openapi";
import { recordRelationInputSchema } from "./ontology";

/**
 * HTTP + wire schemas for the generic approval domain (`/approvals/*`). One
 * lifecycle serves every kind (external_app_plan / record_write / question);
 * the wire shape is deliberately distinct from the DB row (`ToolApprovalRequest`).
 */

export const toolApprovalStatusSchema = z.enum([
  "pending",
  "granted",
  "executing",
  "consumed",
  "rejected",
]);
export type ToolApprovalStatusValue = z.infer<typeof toolApprovalStatusSchema>;

export const toolApprovalKindSchema = z.enum([
  "external_app_plan",
  "external_app_read",
  "record_write",
  "tool_call",
  "question",
]);
export type ToolApprovalKindValue = z.infer<typeof toolApprovalKindSchema>;

// ---- `question` payload (askUserQuestion shape, shared with the tool) ------

export const approvalQuestionOptionSchema = z.object({
  label: z.string().min(1).max(120),
  description: z.string().max(500).default(""),
});

export const approvalQuestionSchema = z.object({
  question: z.string().min(1).max(500),
  /** Short chip label shown above the question (≤40 chars). */
  header: z.string().min(1).max(40),
  options: z.array(approvalQuestionOptionSchema).min(2).max(4),
  multiSelect: z.boolean().default(false),
});
export type ApprovalQuestionDto = z.infer<typeof approvalQuestionSchema>;

export const approvalQuestionPayloadSchema = z.object({
  questions: z.array(approvalQuestionSchema).min(1).max(4),
});
export type ApprovalQuestionPayloadDto = z.infer<
  typeof approvalQuestionPayloadSchema
>;

// ---- `record_write` payload (one gated bulk op: create/update/delete) ------

export const approvalRecordWriteOpSchema = z.enum([
  "create",
  "update",
  "delete",
]);

export const approvalRecordWriteItemSchema = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
  relations: z.array(recordRelationInputSchema).optional(),
  recordId: z.string().optional(),
  currentLabel: z.string().optional(),
  /** Snapshot of the target record's field values (before→after / preview). */
  currentData: z.record(z.string(), z.unknown()).optional(),
  /** Per-item type (update/delete may span types). */
  objectTypeId: z.uuid().optional(),
  typeKey: z.string().optional(),
});

export const approvalRecordWritePayloadSchema = z.object({
  op: approvalRecordWriteOpSchema,
  typeKey: z.string().optional(),
  objectTypeId: z.uuid().optional(),
  typeName: z.string().optional(),
  typeIcon: z.string().optional(),
  typeColor: z.string().optional(),
  /** `bulk_update` merge mode (patch vs full-replace). `update` only. */
  merge: z.boolean().optional(),
  items: z.array(approvalRecordWriteItemSchema).min(1),
  note: z.string().max(1000).optional(),
});
export type ApprovalRecordWritePayloadDto = z.infer<
  typeof approvalRecordWritePayloadSchema
>;

// ---- `tool_call` payload (one gated builtin write tool) -------------------

/** A key/value preview field on the card — label referenced by i18n key. */
export const approvalSummaryFieldSchema = z.object({
  labelKey: z.string(),
  value: z.string(),
  kind: z.enum(["text", "html"]).optional(),
});

export const approvalToolCallPayloadSchema = z.object({
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  note: z.string().max(1000).optional(),
  summaryFields: z.array(approvalSummaryFieldSchema).optional(),
});
export type ApprovalToolCallPayloadDto = z.infer<
  typeof approvalToolCallPayloadSchema
>;

export const approvalPayloadSchema = z.union([
  approvalQuestionPayloadSchema,
  approvalRecordWritePayloadSchema,
  approvalToolCallPayloadSchema,
]);
export type ApprovalPayloadDto = z.infer<typeof approvalPayloadSchema>;

// ---- Per-kind result shapes (what `grant` writes back) --------------------

/** `question` answers, keyed by question header. */
export const toolApprovalAnswersSchema = z.record(z.string(), z.string());

/** One `record_write` outcome — positionally aligned with the proposed
 * records; unselected entries are `{ skipped: true }`. */
export const toolApprovalRecordResultSchema = z.union([
  z.object({ ok: z.literal(true), id: z.uuid(), label: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
  z.object({ skipped: z.literal(true) }),
]);
export type ToolApprovalRecordResultDto = z.infer<
  typeof toolApprovalRecordResultSchema
>;

/** A single op as stored in `tool_approval_requests.operations`. */
export const toolApprovalOperationSchema = z.object({
  action: z.string().min(1).openapi({
    example: "outlook.send_email",
    description: "Fully-qualified action name (provider.action).",
  }),
  args: z.record(z.string(), z.unknown()).openapi({
    description:
      "Executable args. Validated server-side against the manifest at modify-time.",
  }),
});
export type ToolApprovalOperationDto = z.infer<
  typeof toolApprovalOperationSchema
>;

/** A field on the approval card, after backend i18n rendering. */
export const renderedApprovalFieldSchema = z.object({
  label: z.string(),
  value: z.string(),
  kind: z.enum(["text", "html"]).optional(),
});
export type RenderedApprovalFieldDto = z.infer<
  typeof renderedApprovalFieldSchema
>;

export const renderedApprovalOperationSchema = z.object({
  providerKey: z.string(),
  action: z.string(),
  title: z.string(),
  fields: z.array(renderedApprovalFieldSchema),
});
export type RenderedApprovalOperationDto = z.infer<
  typeof renderedApprovalOperationSchema
>;

export const renderedApprovalSummarySchema = z.object({
  title: z.string(),
  operations: z.array(renderedApprovalOperationSchema),
});
export type RenderedApprovalSummaryDto = z.infer<
  typeof renderedApprovalSummarySchema
>;

/** Outcome of a single op after execution — mirrors `ToolApprovalOpResult`. */
export const toolApprovalOpResultSchema = z.union([
  z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type ToolApprovalOpResultDto = z.infer<
  typeof toolApprovalOpResultSchema
>;

export const approvalResponseSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  turnId: z.string(),
  /** Selects which of `summary`/`operations`/`payload` is populated + how
   * the card renders and grant executes. */
  kind: toolApprovalKindSchema,
  status: toolApprovalStatusSchema,
  itemCount: z.int(),
  /** Translated, ready-to-render. `external_app_plan` only (else null). */
  summary: renderedApprovalSummarySchema.nullable(),
  /** Raw ops (mutable via modify-and-grant). `external_app_plan` only. */
  operations: z.array(toolApprovalOperationSchema).nullable(),
  /** Structured payload for `record_write` / `question` (else null). */
  payload: approvalPayloadSchema.nullable(),
  /** Per-kind outcome after a decision: plan/read op results (array),
   * record-write results (array), `question` answers, or a single `tool_call`
   * result (op-result shape). */
  result: z
    .union([
      z.array(toolApprovalOpResultSchema),
      z.array(toolApprovalRecordResultSchema),
      toolApprovalAnswersSchema,
      toolApprovalOpResultSchema,
    ])
    .nullable(),
  decisionFeedback: z.string().nullable(),
  decisionAt: z.coerce.date().nullable(),
  executedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type ApprovalResponse = z.infer<typeof approvalResponseSchema>;

export const modifyAndGrantRequestSchema = z.object({
  operations: z.array(toolApprovalOperationSchema).min(1),
});
export type ModifyAndGrantRequest = z.infer<typeof modifyAndGrantRequestSchema>;

/**
 * Optional body on `POST /approvals/:id/grant`, interpreted per kind:
 *  - `question`     → `answers` (keyed by question header).
 *  - `record_write` → `selectedIndexes` (subset to write; omitted = all) and
 *    `edits` (reviewer's inline field changes, keyed by item index — overrides
 *    the proposed `data` at execution: create = new values, update = the patch).
 *  - `external_app_plan` → no body (edited via `/modify-and-grant`).
 */
export const grantApprovalRequestSchema = z.object({
  answers: toolApprovalAnswersSchema.optional(),
  selectedIndexes: z.array(z.int().nonnegative()).optional(),
  edits: z
    .array(
      z.object({
        index: z.int().nonnegative(),
        data: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
});
export type GrantApprovalRequest = z.infer<typeof grantApprovalRequestSchema>;

export const rejectApprovalRequestSchema = z.object({
  feedback: z.string().max(4096).optional(),
});
export type RejectApprovalRequest = z.infer<typeof rejectApprovalRequestSchema>;
