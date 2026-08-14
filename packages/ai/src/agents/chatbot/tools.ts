import { pruneWebToolsIfUnavailable } from "../../lib/web-egress";
import { createAskUserQuestionTool } from "../../tools/ask-user/chat";
import { createBashTool } from "../../tools/bash";
import { createCreateSkillTool } from "../../tools/create-skill";
import { createDescribeObjectTypeTool } from "../../tools/describe-object-type";
import type { createDispatchAgentTool } from "../../tools/dispatch-agent";
import { createDownloadDriveDocumentTool } from "../../tools/download-drive-document";
import { createExtractTool } from "../../tools/extract";
import { createGetObjectTool } from "../../tools/get-object";
import { createInstallSkillTool } from "../../tools/install-skill";
import { createListDocumentsTool } from "../../tools/list-documents";
import { createListFoldersTool } from "../../tools/list-folders";
import { createListObjectsTool } from "../../tools/list-objects";
import { createManageDriveTool } from "../../tools/manage-drive";
import { createManageFieldTool } from "../../tools/manage-field";
import { createManageLinkTool } from "../../tools/manage-link";
import { createManageObjectTypeTool } from "../../tools/manage-object-type";
import { createManageRecordTool } from "../../tools/manage-record";
import { createManageWorkflowTool } from "../../tools/manage-workflow";
import { createMemoryTool } from "../../tools/memory";
import { createPresentFilesTool } from "../../tools/present-files";
import { createPythonTool } from "../../tools/python";
import { createRagSearchTool } from "../../tools/rag-search";
import { createReadTool } from "../../tools/read";
import { createSearchIconsTool } from "../../tools/search-icons";
import { createSearchSkillCatalogTool } from "../../tools/search-skill-catalog";
import { createSearchToolsTool } from "../../tools/search-tools";
import { createSqlQueryTool } from "../../tools/sql-query";
import { createTransformTool } from "../../tools/transform";
import { createUpdateSkillTool } from "../../tools/update-skill";
import { createUploadToDriveTool } from "../../tools/upload-to-drive";
import { createVisionTool } from "../../tools/vision";
import { createWebFetchTool } from "../../tools/web-fetch";
import { createWebMapTool } from "../../tools/web-map";
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
 * to each tool's `execute` via `toolsContext` (recovered with
 * `getRuntimeContext`). See `../shared/runtime-context.ts` for
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
  extract: buildChatbotTool({
    ...createExtractTool(),
    // Core, deliberately: this tool exists to replace the model's
    // reflex (ad-hoc python parsing) on a top-frequency flow, and a
    // reflex can only be redirected to a tool that is active when the
    // instinct fires — a searchTools round-trip would leave read+python
    // as the path of least resistance. Its file-routing siblings
    // (read/vision/python/bash) are all core; the ~500-token
    // description rides the cached static prefix.
    category: "core",
    searchHint:
      "extract structured data fields line items table rows records document pdf docx invoice json schema",
    // Row sets can get big — same threshold as querySql; oversized
    // results land in a <persisted-output> file the agent reads back
    // or processes with python.
    maxResultSizeChars: 32_000,
    // Paid remote model call, but stateless and re-derivable from the
    // same file + schema — same microcompact stance as vision.
    isReadOnly: false,
    microcompactable: true,
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
  memory: buildChatbotTool({
    ...createMemoryTool(),
    category: "core",
    searchHint:
      "memory remember persistent file user team vendors clients partners conventions preferences view create overwrite delete rename search",
    // `view` of a directory is the largest payload — bounded server-side
    // (depth-2 listing, line-truncation, 30K total cap). Aligned with the
    // SQL/web cap.
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
 * - **listDocuments**: paginated browse over the team's documents.
 *   Backed by a shared service in `@fretik/shared/services/*` — the same
 *   code path the API handlers use, so filter semantics stay consistent.
 * - **describeObjectType / listObjects / getObject**:
 *   the AI READ path over the dynamic-data graph — inspect one type's
 *   fields + relations, browse a type's records, and fetch one record with
 *   its links. The no-SQL companions to `querySql` over the per-type typed
 *   tables + registry. The type catalogue itself is the `<team_objects>`
 *   prompt block, so there is no separate `listObjectTypes` tool.
 * - **manageRecord / manageLink / manageObjectType / manageField**:
 *   the AI WRITE path — single-record CRUD + status, relation link/unlink,
 *   and type/field schema edits. Each routes through the validated shared
 *   services (field validation, typed table, `domain_events`). Bulk writes
 *   and type migrations go through the Python `objects` SDK (fretik_apps),
 *   not these tools.
 * - **webFetch**: pulls up to 5 public URLs as cleaned Markdown via
 *   Tavily `/extract`. Paired with the core `searchWeb` tool —
 *   search first, fetch specific hits second.
 * - **webMap**: lists a site's URLs (Tavily `/map`, no content) when
 *   the site is known but the page isn't — map, pick, then `webFetch`.
 * - **downloadDriveDocument**: pulls a Drive document's binary bytes
 *   into the conversation sandbox under `/workspace/drive/`. Use
 *   only when `searchKnowledge` (RAG) isn't enough — typically for
 *   `vision` on layout/signatures, structural parsing
 *   (pandas/openpyxl/pypdf), or template-driven generation.
 * - **uploadToDrive / manageDrive / listFolders**: the Drive WRITE +
 *   folder-navigation path. `uploadToDrive` saves a conversation
 *   attachment into the Drive (inverse of `downloadDriveDocument`);
 *   `manageDrive` creates/renames/moves/deletes folders and moves
 *   documents; `listFolders` discovers folder ids (incl. empty ones
 *   `listDocuments` never shows). All route through the validated
 *   shared folder/document services.
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
  describeObjectType: buildChatbotTool({
    ...createDescribeObjectTypeTool(),
    category: "domain",
    searchHint:
      "describe object type fields columns schema metadata key label type description config options enum allowed values choices select multi_select bounds min max relations typed view what fields",
    maxResultSizeChars: 16_000,
  }),
  listObjects: buildChatbotTool({
    ...createListObjectsTool(),
    category: "domain",
    searchHint:
      "list browse object records of a type rows entities companies people custom records search status confirmed suggested pending pagination",
    maxResultSizeChars: 16_000,
  }),
  getObject: buildChatbotTool({
    ...createGetObjectTool(),
    category: "domain",
    searchHint:
      "get object record by id detail fields linked records relations connections neighbors what is connected to",
    maxResultSizeChars: 16_000,
  }),
  manageRecord: buildChatbotTool({
    ...createManageRecordTool(),
    category: "domain",
    searchHint:
      "create add update edit delete remove record row entity confirm reject accept ai suggestion set status write data object",
    maxResultSizeChars: 16_000,
  }),
  manageLink: buildChatbotTool({
    ...createManageLinkTool(),
    category: "domain",
    searchHint:
      "link unlink connect disconnect relate records relationship edge association attach detach",
    maxResultSizeChars: 8_000,
  }),
  manageObjectType: buildChatbotTool({
    ...createManageObjectTypeTool(),
    category: "domain",
    searchHint:
      "create update delete object type schema table model define new kind of thing entity category rename",
    maxResultSizeChars: 8_000,
  }),
  manageField: buildChatbotTool({
    ...createManageFieldTool(),
    category: "domain",
    searchHint:
      "add edit remove change field column attribute property type schema select options number bounds relation rollup",
    maxResultSizeChars: 8_000,
  }),
  searchIcons: buildChatbotTool({
    ...createSearchIconsTool(),
    category: "domain",
    searchHint:
      "find icon lucide glyph symbol for object type select option picker visual",
    maxResultSizeChars: 8_000,
  }),
  webFetch: buildChatbotTool({
    ...createWebFetchTool(),
    category: "domain",
    searchHint: "fetch extract read content specific url page markdown article",
    maxResultSizeChars: 48_000,
  }),
  webMap: buildChatbotTool({
    ...createWebMapTool(),
    category: "domain",
    searchHint:
      "map site discover urls pages structure sitemap find page on website pricing contact docs section",
    // URLs only — a 100-URL map is a few KB.
    maxResultSizeChars: 16_000,
  }),
  transform: buildChatbotTool({
    ...createTransformTool(),
    // Domain, not core (unlike extract): a translate/rewrite intent is
    // explicit in the user's message, so the `<tool_routing>` row fires at
    // plan time and one `searchTools` round-trip is cheap — keeping the
    // ~450-token description out of the always-cached static prefix.
    // Promote to core if a WS4 eval shows the model still authoring prose
    // in python instead of activating transform.
    category: "domain",
    searchHint:
      "transform translate rewrite restyle reword rephrase reformat redact anonymise document text file markdown language french english whole document to file",
    // Small by construction — the tool returns a preview + path, never the
    // transformed document itself.
    maxResultSizeChars: 8_000,
    // Paid remote model calls + writes an output file — not read-only, but
    // stateless and re-derivable from the same source + instruction.
    isReadOnly: false,
    microcompactable: true,
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
  uploadToDrive: buildChatbotTool({
    ...createUploadToDriveTool(),
    category: "domain",
    searchHint:
      "upload save file to drive promote attachment conversation store persist archive keep document",
    // Output is a small descriptor (documentId / filename / status) — never large.
    maxResultSizeChars: 8_000,
    // Copies bytes into the Drive + enqueues processing — not read-only.
    isReadOnly: false,
  }),
  manageDrive: buildChatbotTool({
    ...createManageDriveTool(),
    category: "domain",
    searchHint:
      "create rename move delete folder directory organize drive tree relocate document into folder file structure",
    maxResultSizeChars: 8_000,
    // Mutates the folder tree + document locations — not read-only.
    isReadOnly: false,
  }),
  listFolders: buildChatbotTool({
    ...createListFoldersTool(),
    category: "domain",
    searchHint:
      "list browse folders directories drive tree navigate discover folder ids subfolders",
    maxResultSizeChars: 8_000,
  }),
  createSkill: buildChatbotTool({
    ...createCreateSkillTool(),
    category: "domain",
    // Skill-coded terms only — deliberately omit "save" / "remember"
    // which overlap with the always-on `memory` tool (memory stores
    // facts; skills store procedures). Disambiguation lives in the
    // tool description itself.
    searchHint:
      "create new skill recipe playbook procedure instructions template reusable repeat task custom assistant ability set up automate",
    // Slim envelope (slug + status). Body lives in the call's args,
    // not in the result — see create-skill.ts for the rationale.
    maxResultSizeChars: 2_000,
    // Returns a draft for user confirmation — does not mutate DB.
    isReadOnly: true,
  }),
  updateSkill: buildChatbotTool({
    ...createUpdateSkillTool(),
    category: "domain",
    searchHint:
      "update existing skill edit improve refine extend rewrite adjust modify enhance",
    maxResultSizeChars: 2_000,
    isReadOnly: true,
  }),
  searchSkills: buildChatbotTool({
    ...createSearchSkillCatalogTool(),
    category: "domain",
    searchHint:
      "find discover search skill catalog marketplace capability playbook ability ready-made install add",
    maxResultSizeChars: 4_000,
    isReadOnly: true,
  }),
  installSkill: buildChatbotTool({
    ...createInstallSkillTool(),
    category: "domain",
    searchHint:
      "install add skill from catalog marketplace capability playbook to team enable",
    maxResultSizeChars: 2_000,
    // Persists a skill to the team (behind the write-approval gate).
    isReadOnly: false,
  }),
  manageWorkflow: buildChatbotTool({
    ...createManageWorkflowTool(),
    category: "domain",
    searchHint:
      "create build manage workflow automation autonomous agent scheduled recurring cron trigger event playbook tasks run test activate pause draft",
    maxResultSizeChars: 8_000,
    // Mutates workflow definitions + fires test runs — not read-only.
    isReadOnly: false,
  }),
});

/**
 * `dispatchAgent` is built outside this module (in `./index.ts`,
 * after the sub-agent sets it routes to are constructed). We accept
 * it as a parameter so this module never imports the sub-agent
 * factory directly — that pattern keeps `tools.ts` a pure tool
 * registry and avoids a circular import between `tools.ts`,
 * `tools/dispatch-agent.ts`, and `./index.ts` (the latter would
 * otherwise import from this file AND inject `dispatchAgent` back).
 *
 * The static `import { createDispatchAgentTool }` above is used only
 * to derive the slot's return type; the function itself is invoked
 * by `./index.ts`, never here. `tsgo`'s unused-value check is happy
 * because the symbol is consumed by the `typeof` below.
 */
export type DispatchAgentTool = ReturnType<typeof createDispatchAgentTool>;

/**
 * Full chatbot tool set (core + domain + dispatchAgent). Both halves
 * are passed to `ToolLoopAgent` upfront; the `prepareStep` hook in
 * `./index.ts` is what gates which ones the model sees on each step.
 * Passing the full set upfront is what the AI SDK requires —
 * `activeTools` can only subset a known registry, it cannot
 * introduce new tools mid-run.
 *
 * `dispatchAgent` is registered with the rest of the core tools so
 * the parent agent can delegate at any step without first calling
 * `searchTools`.
 */
export const buildChatbotTools = (extras: {
  dispatchAgent: DispatchAgentTool;
}) => {
  const domainTools = buildDomainTools();
  const coreTools = buildCoreTools(domainTools);
  return {
    ...coreTools,
    ...domainTools,
    dispatchAgent: extras.dispatchAgent,
  };
};

export type ChatbotTools = ReturnType<typeof buildChatbotTools>;

/**
 * Sub-agent tool set — same as the chatbot tool set MINUS:
 *   - `dispatchAgent`: prevents recursion. A sub-agent cannot spawn
 *     another sub-agent.
 *   - `searchTools`: Progressive Disclosure is unnecessary inside a
 *     sub-agent run because every domain tool is loaded directly
 *     into the registry; the sub-agent calls them by name without
 *     having to "activate" anything first.
 *
 * Domain tools are still registered as `category: "domain"` here,
 * but the sub-agent's `buildAgentSet` config does NOT install a
 * `prepareStep` hook — so the framework's default applies (= every
 * tool name in the registry is active on every step). Net effect:
 * the sub-agent has direct access to every tool from the start.
 */
export const buildSubAgentTools = () => {
  const domainTools = buildDomainTools();
  const allCoreTools = buildCoreTools(domainTools);
  const { searchTools: _searchTools, ...coreWithoutSearch } = allCoreTools;
  // Sub-agents keep the web tools like everyone else; this only honours the
  // operator's kill switch (and a missing Tavily key), which the chatbot
  // applies per step and sub-agents would otherwise ignore entirely.
  return pruneWebToolsIfUnavailable({ ...coreWithoutSearch, ...domainTools });
};

export type SubAgentTools = ReturnType<typeof buildSubAgentTools>;
