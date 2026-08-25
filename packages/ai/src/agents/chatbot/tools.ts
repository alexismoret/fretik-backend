import { pruneWebToolsIfUnavailable } from "../../lib/web-egress";
import { createAskUserQuestionTool } from "../../tools/ask-user/chat";
import { createBashTool } from "../../tools/bash";
import type { createBuildPageTool } from "../../tools/build-page";
import { createCreateSkillTool } from "../../tools/create-skill";
import { createDescribeCollectionTool } from "../../tools/describe-collection";
import type { createDispatchAgentTool } from "../../tools/dispatch-agent";
import { createDownloadDriveDocumentTool } from "../../tools/download-drive-document";
import { createExtractTool } from "../../tools/extract";
import { createGetRecordTool } from "../../tools/get-record";
import { createInstallSkillTool } from "../../tools/install-skill";
import { createListDocumentsTool } from "../../tools/list-documents";
import { createListFoldersTool } from "../../tools/list-folders";
import { createListRecordsTool } from "../../tools/list-records";
import { createManageCollectionTool } from "../../tools/manage-collection";
import { createManageDocumentTool } from "../../tools/manage-document";
import { createManageDriveTool } from "../../tools/manage-drive";
import { createManageFieldTool } from "../../tools/manage-field";
import { createManageLinkTool } from "../../tools/manage-link";
import { createManagePageTool } from "../../tools/manage-page";
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
  }),
  querySql: buildChatbotTool({
    ...createSqlQueryTool(),
    category: "core",
    searchHint: "postgres sql structured query count filter aggregate",
  }),
  searchWeb: buildChatbotTool({
    ...createWebSearchTool(),
    category: "core",
    searchHint: "web tavily external regulation market news",
  }),
  read: buildChatbotTool({
    ...createReadTool(),
    category: "core",
    searchHint:
      "read file attachment pdf docx pptx text json csv slice offset limit inspect ocr sidecar persisted output",
    // Self-bounds via its own MAX_READ_CHARS (see tools/read.ts) — persisting
    // the output of a file-read tool back to disk would be circular.
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
    // Stdout is captured but the script can also write files into the
    // sandbox dir, so this tool is not strictly read-only.
    isReadOnly: false,
  }),
  bash: buildChatbotTool({
    ...createBashTool(),
    category: "core",
    searchHint:
      "execute bash shell command run ls cat grep find sed awk head tail wc sort tar diff terminal pipeline directory listing",
    // Bash can mutate /workspace (rm, mv, >); not read-only.
    isReadOnly: false,
  }),
  presentFiles: buildChatbotTool({
    ...createPresentFilesTool(),
    category: "core",
    searchHint:
      "present surface display show generated file card download inline image preview deliverable excel word powerpoint pdf chart",
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
 * - **describeCollection / listRecords / getRecord**:
 *   the AI READ path over the dynamic-data graph — inspect one type's
 *   fields + relations, browse a type's records, and fetch one record with
 *   its links. The no-SQL companions to `querySql` over the per-type typed
 *   tables + registry. The type catalogue itself is the `<team_collections>`
 *   prompt block, so there is no separate `listCollections` tool.
 * - **manageRecord / manageLink / manageCollection / manageField**:
 *   the AI WRITE path — single-record CRUD + status, relation link/unlink,
 *   and type/field schema edits. Each routes through the validated shared
 *   services (field validation, typed table, `domain_events`). Bulk writes
 *   and type migrations go through the Python `collections` SDK (fretik_apps),
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
/**
 * @param config.pageAuthoring — whether this registry's `managePage` may WRITE
 * a page (`create`, `dry_run`, and the two reference actions that only matter
 * to whoever writes code). True for the page builder alone; every other agent
 * routes a page through `buildPage`. Explicit at all three call sites rather
 * than defaulted, because a default is how the wrong one gets picked silently.
 */
export const buildDomainTools = (config: { pageAuthoring: boolean }) => ({
  listDocuments: buildChatbotTool({
    ...createListDocumentsTool(),
    category: "domain",
    searchHint:
      "search filter list team documents by type folder status filename",
  }),
  describeCollection: buildChatbotTool({
    ...createDescribeCollectionTool(),
    category: "domain",
    searchHint:
      "describe collection fields columns schema metadata key label type description config options enum allowed values choices select multi_select bounds min max relations typed view what fields",
  }),
  listRecords: buildChatbotTool({
    ...createListRecordsTool(),
    category: "domain",
    searchHint:
      "list browse records of a type rows entities companies people custom records search status confirmed suggested pending pagination",
  }),
  getRecord: buildChatbotTool({
    ...createGetRecordTool(),
    category: "domain",
    searchHint:
      "get record by id detail fields linked records relations connections neighbors what is connected to",
  }),
  manageRecord: buildChatbotTool({
    ...createManageRecordTool(),
    category: "domain",
    searchHint:
      "create add update edit delete remove record row entity confirm reject accept ai suggestion set status write data object",
  }),
  manageLink: buildChatbotTool({
    ...createManageLinkTool(),
    category: "domain",
    searchHint:
      "link unlink connect disconnect relate records relationship edge association attach detach",
  }),
  manageCollection: buildChatbotTool({
    ...createManageCollectionTool(),
    category: "domain",
    searchHint:
      "create update delete collection schema table model define new kind of thing entity category rename",
  }),
  manageField: buildChatbotTool({
    ...createManageFieldTool(),
    category: "domain",
    searchHint:
      "add edit remove change field column attribute property type schema select options number bounds relation rollup formula computed calculated derived",
  }),
  searchIcons: buildChatbotTool({
    ...createSearchIconsTool(),
    category: "domain",
    searchHint:
      "find icon lucide glyph symbol for collection select option picker visual",
  }),
  webFetch: buildChatbotTool({
    ...createWebFetchTool(),
    category: "domain",
    searchHint: "fetch extract read content specific url page markdown article",
  }),
  webMap: buildChatbotTool({
    ...createWebMapTool(),
    category: "domain",
    searchHint:
      "map site discover urls pages structure sitemap find page on website pricing contact docs section",
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
    // Copies bytes into the Drive + enqueues processing — not read-only.
    isReadOnly: false,
  }),
  manageDocument: buildChatbotTool({
    ...createManageDocumentTool(),
    category: "domain",
    searchHint:
      "write author create edit update revise document report note summary spec markdown text version history restore revert previous version rollback what changed",
    // `get` returns a whole document, so a long one is worth persisting; the
    // write actions return small descriptors and are re-fetchable via `get`.
    microcompactable: true,
    // Writes document content + mints versions — not read-only.
    isReadOnly: false,
  }),
  manageDrive: buildChatbotTool({
    ...createManageDriveTool(),
    category: "domain",
    searchHint:
      "create rename move delete folder directory organize drive tree relocate document rename file into folder file structure",
    // Mutates the folder tree + document locations — not read-only.
    isReadOnly: false,
  }),
  listFolders: buildChatbotTool({
    ...createListFoldersTool(),
    category: "domain",
    searchHint:
      "list browse folders directories drive tree navigate discover folder ids subfolders",
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
    // Returns a draft for user confirmation — does not mutate DB.
    isReadOnly: true,
  }),
  updateSkill: buildChatbotTool({
    ...createUpdateSkillTool(),
    category: "domain",
    searchHint:
      "update existing skill edit improve refine extend rewrite adjust modify enhance",
    isReadOnly: true,
  }),
  searchSkills: buildChatbotTool({
    ...createSearchSkillCatalogTool(),
    category: "domain",
    searchHint:
      "find discover search skill catalog marketplace capability playbook ability ready-made install add",
    isReadOnly: true,
  }),
  installSkill: buildChatbotTool({
    ...createInstallSkillTool(),
    category: "domain",
    searchHint:
      "install add skill from catalog marketplace capability playbook to team enable",
    // Persists a skill to the team (behind the write-approval gate).
    isReadOnly: false,
  }),
  managePage: buildChatbotTool({
    // Authoring belongs to `buildPage`, which resolves the `page-build` model
    // and carries the doctrine in its cached prompt. See the docblock on
    // `createManagePageTool` for the measurement behind the split.
    ...createManagePageTool({ authoring: config.pageAuthoring }),
    category: "domain",
    searchHint:
      "page dashboard app interface view chart graph kpi table visualise visualize report display layout custom ui mini-app tool public link share live data",
    // Writes page code (and mints public URLs) — not read-only.
    isReadOnly: false,
    // …but every result it returns is RE-FETCHABLE, which is what compaction
    // actually cares about: get_guide, list, get and dry_run all replay
    // identically, and the one durable fact a create returns (the pageId) is
    // recoverable with `list`. Without this override the guide + page source
    // stayed pinned for the life of the conversation — heaviest exactly when
    // the window is under pressure.
    microcompactable: true,
  }),
  manageWorkflow: buildChatbotTool({
    ...createManageWorkflowTool(),
    category: "domain",
    searchHint:
      "create build manage workflow automation autonomous agent scheduled recurring cron trigger event playbook tasks run test activate pause draft",
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

/** Same construction seam as `DispatchAgentTool`, for the same reason: the
 * page-builder agent it wraps is assembled in `./index.ts`. */
export type BuildPageTool = ReturnType<typeof createBuildPageTool>;

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
  buildPage: BuildPageTool;
}) => {
  // `buildPage` joins the DOMAIN set, not the returned object, and that
  // distinction is load-bearing: `searchTools` indexes and activates from the
  // registry it is handed here, so a tool spliced in afterwards is present on
  // the agent, absent from every search result, and rejected by name when the
  // model asks for it explicitly. Measured 2026-08-16 — ten eval turns in a
  // row built their page inline with `managePage` and the page-builder
  // sub-agent never ran once. It cannot be built INSIDE `buildDomainTools`:
  // the builder agent is constructed from a tool set, so the caller has to
  // pass it in.
  const domainTools = {
    ...buildDomainTools({ pageAuthoring: false }),
    buildPage: extras.buildPage,
  };
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
  // A generic delegate authors no page either: the door to the builder is
  // `dispatchAgent({ agent: "page-builder" })`, which its parent already has.
  const domainTools = buildDomainTools({ pageAuthoring: false });
  const allCoreTools = buildCoreTools(domainTools);
  const { searchTools: _searchTools, ...coreWithoutSearch } = allCoreTools;
  // Sub-agents keep the web tools like everyone else; this only honours the
  // operator's kill switch (and a missing Tavily key), which the chatbot
  // applies per step and sub-agents would otherwise ignore entirely.
  return pruneWebToolsIfUnavailable({ ...coreWithoutSearch, ...domainTools });
};

export type SubAgentTools = ReturnType<typeof buildSubAgentTools>;

/**
 * Page-builder tool set — a POSITIVE list, not the sub-agent set minus a few.
 *
 * Building a page is one long ordered task, and every tool that is not part of
 * it is a way to leave the path: the two shipped pages that failed did so by
 * skipping `components`, not by lacking a capability. So this registry holds
 * `managePage`, the probes that answer "what is actually in this data", the
 * icon catalogue, and the two file tools that open the skill — nothing else.
 * `python`/`bash`-driven analysis, memory, Drive writes, workflows and skill
 * authoring all belong to the parent agent.
 *
 * `bash` is here for one reason (`ls skills/…` to see what the bundle offers);
 * `read` is what actually opens those files.
 */
export const buildPageBuilderTools = () => {
  // The one registry that may AUTHOR a page. `create`, `dry_run`, `get_guide`
  // and `components` exist here and nowhere else in the product.
  const domainTools = buildDomainTools({ pageAuthoring: true });
  const coreTools = buildCoreTools(domainTools);
  return {
    managePage: domainTools.managePage,
    describeCollection: domainTools.describeCollection,
    listRecords: domainTools.listRecords,
    getRecord: domainTools.getRecord,
    listDocuments: domainTools.listDocuments,
    searchIcons: domainTools.searchIcons,
    querySql: coreTools.querySql,
    read: coreTools.read,
    bash: coreTools.bash,
  };
};

export type PageBuilderTools = ReturnType<typeof buildPageBuilderTools>;
