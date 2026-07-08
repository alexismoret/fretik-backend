import { getProducerConnection } from "@fretik/shared/lib/queue/connection";
import { Queue } from "bullmq";
import {
  MEMORY_DISTILL_QUEUE,
  MEMORY_DREAMING_QUEUE,
  MEMORY_MAINTENANCE_QUEUE,
  MEMORY_RESOLVE_QUEUE,
  RECORD_CARD_QUEUE,
  WORKFLOW_TRIGGER_QUEUE,
  type DreamingTeamJobData,
  type EagerConsolidateJobData,
  type MemoryDistillJobData,
  type MemoryResolveJobData,
  type RecordCardJobData,
  type WorkflowRunCreateJobData,
} from "./names";

/** Both job shapes ride the dreaming queue (see EAGER_CONSOLIDATE_JOB). */
export type DreamingJobData = DreamingTeamJobData | EagerConsolidateJobData;

/**
 * Lazily-created Queue singletons (producer side — the sweep fans out through
 * these). All share the process-wide producer connection.
 */

let resolveQueue: Queue<MemoryResolveJobData> | null = null;
let distillQueue: Queue<MemoryDistillJobData> | null = null;
let maintenanceQueue: Queue | null = null;
let recordCardQueue: Queue<RecordCardJobData> | null = null;

export const getMemoryResolveQueue = (): Queue<MemoryResolveJobData> => {
  resolveQueue ??= new Queue<MemoryResolveJobData>(MEMORY_RESOLVE_QUEUE, {
    connection: getProducerConnection(),
  });
  return resolveQueue;
};

export const getMemoryDistillQueue = (): Queue<MemoryDistillJobData> => {
  distillQueue ??= new Queue<MemoryDistillJobData>(MEMORY_DISTILL_QUEUE, {
    connection: getProducerConnection(),
  });
  return distillQueue;
};

export const getMemoryMaintenanceQueue = (): Queue => {
  maintenanceQueue ??= new Queue(MEMORY_MAINTENANCE_QUEUE, {
    connection: getProducerConnection(),
  });
  return maintenanceQueue;
};

export const getRecordCardQueue = (): Queue<RecordCardJobData> => {
  recordCardQueue ??= new Queue<RecordCardJobData>(RECORD_CARD_QUEUE, {
    connection: getProducerConnection(),
  });
  return recordCardQueue;
};

let dreamingQueue: Queue<DreamingJobData> | null = null;

export const getMemoryDreamingQueue = (): Queue<DreamingJobData> => {
  dreamingQueue ??= new Queue<DreamingJobData>(MEMORY_DREAMING_QUEUE, {
    connection: getProducerConnection(),
  });
  return dreamingQueue;
};

let workflowTriggerQueue: Queue<WorkflowRunCreateJobData> | null = null;

export const getWorkflowTriggerQueue = (): Queue<WorkflowRunCreateJobData> => {
  workflowTriggerQueue ??= new Queue<WorkflowRunCreateJobData>(
    WORKFLOW_TRIGGER_QUEUE,
    { connection: getProducerConnection() },
  );
  return workflowTriggerQueue;
};
