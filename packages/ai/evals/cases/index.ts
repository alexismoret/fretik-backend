/**
 * Registry of every eval suite the harness runs. Each suite is
 * self-contained in its own file under `./` and listed here so the
 * runner can discover them without import-glob plumbing.
 *
 * Add a new category by creating `./<name>.ts` with an
 * `export const <name>Suite: EvalSuite = { ... }` and appending it
 * below.
 */

import type { EvalSuite } from "../types";
import { askUserSuite } from "./ask-user";
import { autoMemorySuite } from "./auto-memory";
import { bashExecutionSuite } from "./bash-execution";
import { compactionSuite } from "./compaction";
import { edgeCasesSuite } from "./edge-cases";
import { fileAttachmentsSuite } from "./file-attachments";
import { latencyStressSuite } from "./latency-stress";
import { memorySuite } from "./memory";
import { multiStepSuite } from "./multi-step";
import { parallelToolCallsSuite } from "./parallel-tool-calls";
import { ragMetadataSuite } from "./rag-metadata";
import { ragPrecisionSuite } from "./rag-precision";
import { simpleQaSuite } from "./simple-qa";
import { sqlAnalyticsSuite } from "./sql-analytics";
import { tabularExtractionSuite } from "./tabular-extraction";
import { vaguePromptsSuite } from "./vague-prompts";

export const allSuites: EvalSuite[] = [
  simpleQaSuite,
  ragPrecisionSuite,
  ragMetadataSuite,
  sqlAnalyticsSuite,
  multiStepSuite,
  vaguePromptsSuite,
  edgeCasesSuite,
  latencyStressSuite,
  fileAttachmentsSuite,
  compactionSuite,
  bashExecutionSuite,
  memorySuite,
  tabularExtractionSuite,
  parallelToolCallsSuite,
  askUserSuite,
  autoMemorySuite,
];
