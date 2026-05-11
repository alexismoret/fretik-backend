import { createAskUserQuestionTool } from "../../tools/ask-user";
import { createBashTool } from "../../tools/bash";
import { createDownloadDriveDocumentTool } from "../../tools/download-drive-document";
import { createGetEntityDetailsTool } from "../../tools/get-entity-details";
import { createListDocumentsTool } from "../../tools/list-documents";
import { createListEntitiesTool } from "../../tools/list-entities";
import { createManageTasksTool } from "../../tools/manage-tasks";
import { createMemoryTool } from "../../tools/memory";
import { createPresentFilesTool } from "../../tools/present-files";
import { createPythonTool } from "../../tools/python";
import { createRagSearchTool } from "../../tools/rag-search";
import { createReadTool } from "../../tools/read";
import { createSearchToolsTool } from "../../tools/search-tools";
import { createSqlQueryTool } from "../../tools/sql-query";
import { createVisionTool } from "../../tools/vision";
import { createWebFetchTool } from "../../tools/web-fetch";
import { createWebSearchTool } from "../../tools/web-search";
import {
  buildChatbotTool,
  type SearchableToolRegistry,
} from "../shared/chatbot-tool";

/**
 * Chatbot tool set. Tools carry their own `category` metadata
 * (`"core" | "domain"`) set through `buildChatbotTool()`, so callers
 * can decide at runtime which ones to expose on a given step. This
 * mirrors Claude Code's own pattern — see
 * `claude-code/src/tools.ts` and `ToolSearchTool/prompt.ts::isDeferredTool`
 * — where each tool declares `shouldDefer` on itself and the query
 * engine filters by it at step time. No separate "list of core
 * names" registry to keep in sync.
 *
 * - **core** tools are always available. Gated on every step via
 *   `prepareStep.activeTools` in `./index.ts`. Includes the
 *   workhorses (RAG, SQL, web) plus `searchTools` — the Progressive
 *   Disclosure entry point.
 * - **domain** tools are listed by name in the system prompt under
 *   `<domain_tools>` but NOT active by default. The model calls
 *   `searchTools` which mutates `ctx.dynamicToolManager`;
 *   `prepareStep` picks up the activated names on the next step and
 *   adds them to `activeTools`.
 *
 * Tool factories do NOT take a `ctx`. The `ToolLoopAgent` singleton
 * constructs its tools once at boot; per-request state is threaded
 * to each tool's `execute` via `experimental_context` (recovered
 * with `getRuntimeContext`). See `../shared/runtime-context.ts` for
 * the DI helper. Closing over ctx at construction would leak
 * per-request state across concurrent requests.
 *
 * Return types are inferred rather than annotated with `ChatbotToolSet`
 * because the underlying AI SDK `Tool` is invariant over its input
 * type — inference keeps each field concrete and still flows
 * correctly into `ToolLoopAgent`'s generic `TOOLS`.
 *
 * **Adding a new core tool**: append one entry to `buildCoreTools`
 * with `category: "core"`. That's it — `prepareStep` discovers it
 * automatically because it filters by `tool.category`.
 */

export const buildCoreTools = (domainTools: SearchableToolRegistry) => ({
  searchKnowledge: buildChatbotTool({
    ...createRagSearchTool(),
    category: "core",
    searchHint: "semantic rag documents content search",
    // RAG chunks are verbose by nature; give them extra room before
    // the persisted-output layer kicks in.
    maxResultSizeChars: 48_000,
  }),
  querySql: buildChatbotTool({
    ...createSqlQueryTool(),
    category: "core",
    searchHint: "postgres sql structured query count filter aggregate",
    maxResultSizeChars: 32_000,
  }),
  searchWeb: buildChatbotTool({
    ...createWebSearchTool(),
    category: "core",
    searchHint: "web tavily external regulation market news",
    // Tavily results are compact — a smaller cap avoids wasted context.
    maxResultSizeChars: 24_000,
  }),
  read: buildChatbotTool({
    ...createReadTool(),
    category: "core",
    searchHint:
      "read file attachment pdf docx pptx text json csv slice offset limit inspect ocr sidecar persisted output",
    // Opt out of the persistence layer entirely: persisting the
    // output of a file-read tool back to disk would be circular.
    // The tool self-bounds via its own MAX_READ_CHARS (see
    // tools/read.ts).
    maxResultSizeChars: Number.POSITIVE_INFINITY,
  }),
  vision: buildChatbotTool({
    ...createVisionTool(),
    category: "core",
    searchHint:
      "view image pdf vision describe photo diagram chart layout colour signature visual question gemini document",
    // Vision payloads are short descriptions — leave Fretik's
    // default threshold in place. Not strictly read-only (it
    // invokes a remote vision model), but no side-effects on local
    // state.
    maxResultSizeChars: 8_000,
    isReadOnly: false,
    // Vision returns a stateless description that the model can
    // re-generate by calling vision again on the same path. Override
    // the `isReadOnly`-derived default so microcompact can clear old
    // descriptions to free context.
    microcompactable: true,
  }),
  python: buildChatbotTool({
    ...createPythonTool(),
    category: "core",
    searchHint:
      "execute python code script sandbox transform filter aggregate compute json csv",
    // Mirrors Claude Code's BashTool cap (30K). `python` is the
    // chatbot's general-purpose "run code, get stdout" escape hatch —
    // same conceptual role as Bash in Claude Code, so the threshold
    // tracks Bash's. See tools/python.ts for the full rationale.
    maxResultSizeChars: 30_000,
    // Stdout is captured but the script can also write files into the
    // sandbox dir, so this tool is not strictly read-only.
    isReadOnly: false,
  }),
  bash: buildChatbotTool({
    ...createBashTool(),
    category: "core",
    searchHint:
      "execute bash shell command run ls cat grep find sed awk head tail wc sort tar diff terminal pipeline directory listing",
    // Same cap as `python` and Claude Code's BashTool — stdout dumps
    // from `find` / `grep -R` / `ls -R` are the primary reason the
    // persisted-output layer exists.
    maxResultSizeChars: 30_000,
    // Bash can mutate /workspace (rm, mv, >); not read-only.
    isReadOnly: false,
  }),
  presentFiles: buildChatbotTool({
    ...createPresentFilesTool(),
    category: "core",
    searchHint:
      "present surface display show generated file card download inline image preview deliverable excel word powerpoint pdf chart",
    // Output is a small descriptor array (filename/mime/size per file)
    // plus an optional caption — always comfortably under any cap.
    maxResultSizeChars: 8_000,
    // Mirrors produced files to S3, so not strictly read-only.
    isReadOnly: false,
  }),
  searchTools: buildChatbotTool({
    ...createSearchToolsTool(domainTools),
    category: "core",
    searchHint:
      "activate enable discover load domain tools deferred progressive disclosure",
    // searchTools responses only carry tool names, never payloads.
    // A tight cap keeps the context footprint negligible.
    maxResultSizeChars: 8_000,
    // Replay-critical: `replayActivationFromHistory` reconstructs the
    // DynamicToolManager state by reading the JSON payload of past
    // searchTools results. Microcompact must NEVER clear these or
    // the model loses track of which domain tools it already activated
    // and re-runs `searchTools` on every turn.
    microcompactable: false,
  }),
  manageTasks: buildChatbotTool({
    ...createManageTasksTool(),
    category: "core",
    searchHint:
      "manage session task checklist multi-step plan track progress todo",
    // manageTasks returns the current task list only — always small.
    // Matches keyDecisions.persistedOutputThreshold for manageTasks (8K).
    maxResultSizeChars: 8_000,
    // The tool mutates ctx.taskManager state; not strictly read-only.
    isReadOnly: false,
  }),
  memory: buildChatbotTool({
    ...createMemoryTool(),
    category: "core",
    searchHint:
      "memory remember persistent file user team carriers clients conventions preferences view create overwrite delete rename grep search",
    // `view` of a directory + `grep` results are the largest payloads
    // — both are bounded server-side (depth-2 listing, line-truncation,
    // 30K total cap on grep). Aligned with the SQL/web cap.
    maxResultSizeChars: 32_000,
    // memory mutates the durable `ai_memories` table — not read-only.
    isReadOnly: false,
  }),
  askUserQuestion: buildChatbotTool({
    ...createAskUserQuestionTool(),
    category: "core",
    searchHint:
      "ask user question multiple choice clarify ambiguity preference decision confirm propose memory disambiguate",
    // Output is a small descriptor (1-4 questions × up to 4 options each)
    // — always comfortably under any cap.
    maxResultSizeChars: 8_000,
    // No external side effects on local state at execute time; the
    // actual answer collection happens client-side via a fresh user
    // turn carrying the answers.
    isReadOnly: true,
    // Output is purely the echoed input — re-fetchable, safe to clear.
    microcompactable: true,
  }),
});

/**
 * Domain tools — not loaded by default, activated on demand via
 * `searchTools`. Currently registered:
 *
 * - **listDocuments / listEntities**: paginated browse operations over
 *   the SaaS core objects. Backed by shared services in
 *   `@fretik/shared/services/*` — the same code paths the API handlers
 *   use, so filter semantics stay consistent across every caller.
 * - **getEntityDetails**: single-row read that carries the full payload
 *   (entity's linked documents), again via a shared service.
 * - **webFetch**: pulls a specific public URL as cleaned Markdown
 *   via Tavily `/extract`. Paired with the core `searchWeb` tool —
 *   search first, fetch specific hits second.
 * - **downloadDriveDocument**: pulls a Drive document's binary bytes
 *   into the conversation sandbox under `/workspace/drive/`. Use
 *   only when `searchKnowledge` (RAG) isn't enough — typically for
 *   `vision` on layout/signatures, structural parsing
 *   (pandas/openpyxl/pypdf), or template-driven generation.
 *
 * Every tool here has `category: "domain"` so `buildChatbotTool`
 * auto-sets `shouldDefer: true` and `prepareStep` in `./index.ts`
 * keeps them inactive until `searchTools` activates them by name.
 */
export const buildDomainTools = () => ({
  listDocuments: buildChatbotTool({
    ...createListDocumentsTool(),
    category: "domain",
    searchHint:
      "search filter list team documents by type folder status filename",
    maxResultSizeChars: 16_000,
  }),
  listEntities: buildChatbotTool({
    ...createListEntitiesTool(),
    category: "domain",
    searchHint:
      "search filter list entities carriers clients companies by type country",
    maxResultSizeChars: 16_000,
  }),
  getEntityDetails: buildChatbotTool({
    ...createGetEntityDetailsTool(),
    category: "domain",
    searchHint:
      "read entity details linked documents carrier client one specific id",
    maxResultSizeChars: 16_000,
  }),
  webFetch: buildChatbotTool({
    ...createWebFetchTool(),
    category: "domain",
    searchHint: "fetch extract read content specific url page markdown article",
    maxResultSizeChars: 48_000,
  }),
  downloadDriveDocument: buildChatbotTool({
    ...createDownloadDriveDocumentTool(),
    category: "domain",
    searchHint:
      "download drive document binary pdf docx xlsx pull file workspace sandbox local copy parse vision generate template",
    // Output is a small descriptor (path / filename / mimeType / size)
    // — never large.
    maxResultSizeChars: 8_000,
    // Mutates `/workspace/drive/` and (potentially) the conversation
    // sandbox quota — not strictly read-only.
    isReadOnly: false,
  }),
});

/**
 * Full chatbot tool set (core + domain). Both halves are passed to
 * `ToolLoopAgent` upfront; the `prepareStep` hook in `./index.ts` is
 * what gates which ones the model sees on each step. Passing the
 * full set upfront is what the AI SDK requires — `activeTools` can
 * only subset a known registry, it cannot introduce new tools
 * mid-run.
 */
export const buildChatbotTools = () => {
  const domainTools = buildDomainTools();
  const coreTools = buildCoreTools(domainTools);
  return { ...coreTools, ...domainTools };
};

export type ChatbotTools = ReturnType<typeof buildChatbotTools>;
