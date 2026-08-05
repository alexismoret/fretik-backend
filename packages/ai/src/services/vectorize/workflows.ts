import db from "@fretik/shared/db";
import type { WorkflowVectorMetadata } from "@fretik/shared/db/schema";
import { aiVectors, workflows } from "@fretik/shared/db/schema";
import { buildWorkflowCard } from "@fretik/shared/services/workflows/vector-refresh";
import { and, eq, ne, notExists, sql } from "drizzle-orm";
import { vectorizeSource, type VectorizeSourceResult } from "./index";

/**
 * Workflow-card vectoriser — what a workflow does, how it fires, and what it
 * needs, as one embedded card.
 *
 * The point is discovery from natural language: a user asks for an outcome
 * ("get me last month's supplier totals") without knowing a workflow for it
 * exists. `searchKnowledge` surfaces the card, and the assistant runs the
 * existing workflow instead of building a second one.
 *
 * Identity is the workflow id (`source_id`) — no lookup needed, unlike skills
 * whose identity is a (name, file) tuple. Idempotence rides on
 * `metadata.content_hash`: a workflow saved without a meaningful change skips
 * the embed round-trip. Single chunk, enrichment skipped (the card is already
 * self-describing) — same shape as record cards.
 */

/** Hex SHA-256 — see `skills.ts` for why the algorithm is named, not `Bun.hash`. */
const sha256Hex = (input: string): string =>
  new Bun.CryptoHasher("sha256").update(input).digest("hex");

export interface VectorizeWorkflowInput {
  workflowId: string;
  teamId: string;
  organizationId: string;
  /** Owner of a private workflow; null for a team-shared one. */
  userId: string | null;
  name: string;
  description: string;
  triggerType: string;
  status: string;
  taskCount: number;
  /** The card body: goal, tasks, trigger and inputs, in plain text. */
  content: string;
}

export interface VectorizeWorkflowResult extends VectorizeSourceResult {
  /** True when the card was unchanged and the embed round-trip was skipped. */
  skipped: boolean;
}

const SKIPPED: VectorizeWorkflowResult = {
  skipped: true,
  chunksProduced: 0,
  chunksEnriched: 0,
  rowsInserted: 0,
  rowsDropped: 0,
  metadataOnly: false,
};

export const vectorizeWorkflow = async (
  input: VectorizeWorkflowInput,
): Promise<VectorizeWorkflowResult> => {
  const contentHash = sha256Hex(input.content);

  const existing = await db
    .select({ metadata: aiVectors.metadata })
    .from(aiVectors)
    .where(
      and(
        eq(aiVectors.sourceType, "workflows"),
        eq(aiVectors.sourceId, input.workflowId),
      ),
    )
    .limit(1);

  const previous = existing[0]?.metadata;
  if (
    previous &&
    "content_hash" in previous &&
    previous.content_hash === contentHash
  ) {
    return SKIPPED;
  }

  const metadata: WorkflowVectorMetadata = {
    name: input.name,
    description: input.description,
    trigger_type: input.triggerType,
    status: input.status,
    task_count: input.taskCount,
    content_hash: contentHash,
    version_indexed_at: new Date().toISOString(),
  };

  const result = await vectorizeSource({
    sourceType: "workflows",
    sourceId: input.workflowId,
    content: input.content,
    metadata,
    teamId: input.teamId,
    organizationId: input.organizationId,
    userId: input.userId,
  });

  return { ...result, skipped: false };
};

/**
 * Index every workflow that has no card yet.
 *
 * Without this, discovery would only cover workflows saved AFTER the feature
 * shipped: an existing one stays invisible until somebody happens to edit it.
 * Self-limiting — it selects only workflows with no row in `ai_vectors`, so
 * the second boot finds nothing and does no work.
 *
 * Fire-and-forget at boot, like the bundled-skills indexer.
 */
export const backfillWorkflowVectors = async (): Promise<{
  indexed: number;
}> => {
  const alreadyIndexed = db
    .select({ one: sql`1` })
    .from(aiVectors)
    .where(
      and(
        eq(aiVectors.sourceType, "workflows"),
        eq(aiVectors.sourceId, sql`${workflows.id}::text`),
      ),
    );

  const rows = await db
    .select()
    .from(workflows)
    .where(and(ne(workflows.status, "archived"), notExists(alreadyIndexed)));

  let indexed = 0;
  for (const workflow of rows) {
    try {
      await vectorizeWorkflow({
        workflowId: workflow.id,
        teamId: workflow.teamId,
        organizationId: workflow.organizationId,
        userId: workflow.userId,
        name: workflow.name,
        description: workflow.description ?? "",
        triggerType: workflow.triggerType,
        status: workflow.status,
        taskCount: workflow.playbook.tasks.length,
        content: buildWorkflowCard(workflow),
      });
      indexed += 1;
    } catch (error) {
      // One bad workflow must not stop the backfill — it retries next boot.
      console.warn(
        `[vectorize.workflows] backfill failed for ${workflow.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { indexed };
};

/**
 * Drop a workflow's card. Direct SQL — the embed pipeline has nothing to do
 * when a workflow is archived or deleted; it must simply stop being
 * discoverable.
 */
export const deleteWorkflowVectors = async (
  workflowId: string,
): Promise<number> => {
  const deleted = await db
    .delete(aiVectors)
    .where(
      and(
        eq(aiVectors.sourceType, "workflows"),
        eq(aiVectors.sourceId, workflowId),
      ),
    )
    .returning({ id: aiVectors.id });
  return deleted.length;
};
