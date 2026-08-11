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
import { b2bEfficiencySuite } from "./b2b-efficiency";
import { bashExecutionSuite } from "./bash-execution";
import { dispatchAgentSuite } from "./dispatch-agent";
import { doctrineSuite } from "./doctrine";
import { edgeCasesSuite } from "./edge-cases";
import { extractionSuite } from "./extraction";
import { fileAttachmentsSuite } from "./file-attachments";
import { instructionFollowingSuite } from "./instruction-following";
import { longContextSuite } from "./long-context";
import { memorySuite } from "./memory";
import { multiStepSuite } from "./multi-step";
import { multimodalSuite } from "./multimodal";
import { objectGraphSuite } from "./object-graph";
import { objectsAutonomySuite } from "./objects-autonomy";
import { pagesSuite } from "./pages";
import { ragMetadataSuite } from "./rag-metadata";
import { ragPrecisionSuite } from "./rag-precision";
import { securitySuite } from "./security";
import { simpleQaSuite } from "./simple-qa";
import { toolPortabilitySuite } from "./tool-portability";
import { transformSuite } from "./transform";

export const allSuites: EvalSuite[] = [
  simpleQaSuite,
  ragPrecisionSuite,
  ragMetadataSuite,
  multiStepSuite,
  edgeCasesSuite,
  extractionSuite,
  fileAttachmentsSuite,
  bashExecutionSuite,
  memorySuite,
  dispatchAgentSuite,
  doctrineSuite,
  toolPortabilitySuite,
  transformSuite,
  instructionFollowingSuite,
  longContextSuite,
  securitySuite,
  b2bEfficiencySuite,
  multimodalSuite,
  objectGraphSuite,
  objectsAutonomySuite,
  pagesSuite,
];
