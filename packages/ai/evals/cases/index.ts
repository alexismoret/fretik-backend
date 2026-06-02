/**
 * Registry of every eval suite the harness runs. Each suite is
 * self-contained in its own file under `./` and listed here so the
 * runner can discover them without import-glob plumbing.
 *
 * Only CURATED cases (`../curation.ts`) sync to the Langfuse
 * `chatbot-eval` dataset and actually run; the suites below hold those
 * curated case definitions. New cases enter the gold set from
 * production failures via `promoteTrace` — see `evals/RUNBOOK.md`.
 */

import type { EvalSuite } from "../types";
import { bashExecutionSuite } from "./bash-execution";
import { dispatchAgentSuite } from "./dispatch-agent";
import { edgeCasesSuite } from "./edge-cases";
import { fileAttachmentsSuite } from "./file-attachments";
import { latencyStressSuite } from "./latency-stress";
import { memorySuite } from "./memory";
import { multiStepSuite } from "./multi-step";
import { ragMetadataSuite } from "./rag-metadata";
import { ragPrecisionSuite } from "./rag-precision";
import { simpleQaSuite } from "./simple-qa";

export const allSuites: EvalSuite[] = [
  simpleQaSuite,
  ragPrecisionSuite,
  ragMetadataSuite,
  multiStepSuite,
  edgeCasesSuite,
  latencyStressSuite,
  fileAttachmentsSuite,
  bashExecutionSuite,
  memorySuite,
  dispatchAgentSuite,
];
