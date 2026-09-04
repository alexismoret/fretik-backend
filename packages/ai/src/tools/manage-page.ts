import {
  COLLECTION_COLOR_TOKENS,
  isValidCollectionColor,
} from "@fretik/shared/lib/colors/collection-colors";
import { isValidIcon } from "@fretik/shared/lib/icons/search";
import { parseApiError } from "@fretik/shared/schemas/errors";
import {
  PAGE_ENTRY_FILE,
  PAGE_LIMITS,
  PageBriefSchema,
  PageCodeEditsSchema,
  PageDatasetSchema,
  PageOperationSchema,
  PageThemeSchema,
  PageVariableSchema,
  pageBlankError,
  type PageDefinition,
  type PageResponse,
} from "@fretik/shared/schemas/pages";
import { isOrgAdmin } from "@fretik/shared/services/organization/member-role";
import { applyPageProjectEdits } from "@fretik/shared/services/pages/apply-code-edits";
import { deletePage } from "@fretik/shared/services/pages/delete";
import { dryRunPage } from "@fretik/shared/services/pages/dry-run";
import {
  publishPage,
  unpublishPage,
} from "@fretik/shared/services/pages/publish";
import { getPage, listPages } from "@fretik/shared/services/pages/retrieve";
import { updatePage } from "@fretik/shared/services/pages/update";
import type { PageRequester } from "@fretik/shared/services/pages/visibility";
import { tool } from "ai";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  maybePersistLargeOutput,
  persistSidecar,
} from "../lib/persisted-output";
import {
  TOOL_ERROR_CODES,
  toolError,
  type ToolErrorOutput,
} from "../lib/tool-error-codes";
import { renderProjectManifest } from "../services/page-project/manifest";
import { projectFromDefinition } from "../services/page-project/store";
import { runPageReview } from "../services/page-review/run-review";

/** A `list` entry states what the page shows, not its whole document. */
const LISTING_DESCRIPTION_CHARS = 200;
const truncateForListing = (text: string): string =>
  text.length > LISTING_DESCRIPTION_CHARS
    ? `${text.slice(0, LISTING_DESCRIPTION_CHARS).trimEnd()}…`
    : text;

/** Warnings surfaced per call — past this the list stops teaching anything. */
const MAX_WARNINGS_RETURNED = 25;
/** Runtime errors surfaced per call — the self-heal feed's readable tail. */
const MAX_RUNTIME_ERRORS_RETURNED = 5;

/**
 * A write merges findings from three sources — icon/colour sanitising, the
 * service's own static pass, and the dry run — and the same sentence can reach
 * two of them. Two copies of one sentence read as two problems in a channel the
 * model is already skimming.
 */
const distinctWarnings = (warnings: string[]): string[] => [
  ...new Set(warnings),
];

/**
 * Accept a nested object that arrived JSON-ENCODED.
 *
 * A page definition is the deepest argument this agent ever sends, and
 * serialising it to a string is the classic weak-model slip (observed on
 * deepseek-v4-flash). A string that does not parse falls THROUGH unchanged, so
 * the model still gets the schema's own message rather than a JSON-parse error
 * about a field it does not know it sent as text.
 */
const jsonTolerant = <TSchema extends z.ZodType>(schema: TSchema) =>
  z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }, schema);

/**
 * The definition as the AGENT sends it: every section optional, the tool
 * assembles the stored document (version stamp, defaults). Omitted sections
 * KEEP their stored value on update — send a section to replace it whole.
 */
const definitionSectionsSchema = z.object({
  brief: PageBriefSchema.optional().describe(
    "What the page is for and how it should look. Write it BEFORE the code — `get` returns it to every later turn as the spec to build against, so it outlives the conversation that produced it.",
  ),
  variables: z
    .array(PageVariableSchema)
    .max(PAGE_LIMITS.maxVariables)
    .optional(),
  datasets: z.array(PageDatasetSchema).max(PAGE_LIMITS.maxDatasets).optional(),
  operations: z
    .array(PageOperationSchema)
    .max(PAGE_LIMITS.maxOperations)
    .optional(),
  theme: PageThemeSchema.nullable().optional(),
  code: z
    .object({
      source: z.string().max(PAGE_LIMITS.maxSourceChars),
    })
    .optional()
    .describe(
      "Not accepted here: writing a page's code is `buildPage`'s work. Send `edits` for a targeted change.",
    ),
});

/**
 * Translate a thrown `HTTPException` from the page services into the envelope
 * the agent reads. Returns null for anything it does not recognise, and the
 * caller rethrows — `guardToolExecute` stays the backstop for real bugs.
 *
 * The compile refusal is the load-bearing branch: `ensurePageCompiled` refuses
 * a write with the compiler's own errors (block, message, line), and those
 * must travel VERBATIM — they are the agent's fix list.
 */
export const liftPageError = (
  err: unknown,
  ctx: { action: string; pageId?: string },
): ToolErrorOutput | null => {
  if (!(err instanceof HTTPException)) return null;
  const parsed = parseApiError(err.message);

  if (err.status === 404) {
    return toolError(
      TOOL_ERROR_CODES.NOT_FOUND,
      `No page ${ctx.pageId ?? "with that id"} in this team — it may be deleted, or private to another member.`,
      `Call { action: "list" } and retry ${ctx.action} with a pageId from that list.`,
    );
  }
  if (err.status === 400) {
    const message = parsed?.message ?? "The page rejected this operation.";
    if (message.startsWith("Page code failed to compile")) {
      return toolError(
        TOOL_ERROR_CODES.INVALID_ARGS,
        message,
        "Nothing was saved. Fix the named lines with another `edits` call — the error names the file and the line.",
      );
    }
    const publishing = ctx.action === "publish";
    return toolError(
      publishing
        ? TOOL_ERROR_CODES.PAGE_NOT_PUBLISHABLE
        : TOOL_ERROR_CODES.FORBIDDEN,
      message,
      publishing
        ? "Fix what the message names (update the page), then publish again."
        : 'A page is either team-shared or private to you — send scope: "team" or scope: "private", never another member\'s page.',
    );
  }
  return null;
};

/**
 * The one shape of whole-file update the guard still refuses: a replacement
 * dramatically shorter than what it replaces. 0.7 is set from the measured
 * destructive case (370 of 1272 lines kept, ratio 0.29) with room for honest
 * shrink — dead code removed, a section consolidated — which stays above it.
 */
export const isDestructiveRewrite = (
  storedSource: string,
  submittedSource: string,
): boolean =>
  storedSource.trim().length > 0 &&
  submittedSource.length < storedSource.length * 0.7;

/** The compiler's own message when `err` is a compile refusal, else null. */
const compileRefusalMessage = (err: unknown): string | null => {
  if (!(err instanceof HTTPException) || err.status !== 400) return null;
  const message = parseApiError(err.message)?.message;
  return message !== undefined &&
    message.startsWith("Page code failed to compile")
    ? message
    : null;
};

const sanitizeIcon = (
  icon: string | undefined,
): { icon: string | undefined; warnings: string[] } => {
  if (icon === undefined || isValidIcon(icon)) return { icon, warnings: [] };
  return {
    icon: undefined,
    warnings: [
      `Ignored unknown icon '${icon}' — searchIcons lists the catalog.`,
    ],
  };
};

const sanitizeColor = (
  color: string | undefined,
): { color: string | undefined; warnings: string[] } => {
  if (color === undefined || isValidCollectionColor(color)) {
    return { color, warnings: [] };
  }
  return {
    color: undefined,
    warnings: [
      `Ignored unknown color '${color}' — kept the default. Valid tokens: ${COLLECTION_COLOR_TOKENS.join(", ")}.`,
    ],
  };
};

type PageScope = "team" | "private";
const scopeOf = (userId: string | null): PageScope =>
  userId ? "private" : "team";

/** What the agent reads back of a page — `compiled` is stripped (build output
 * is noise; the files are the document), the error feed's tail is attached.
 *
 * ONE file's text per call, named, because a page is a project now: printing
 * every file would spend a whole context on a retouch that changes a label, and
 * an edit anchors inside one file anyway. The manifest says what else there is.
 *
 * The text is unnumbered on purpose. `update { edits }` matches it literally,
 * and line numbers pasted into an anchor are a failure this tool cannot see
 * coming; the builder's `pageRead` numbers its output because `pageEdit`
 * forgives the difference. */
const agentPageView = (
  page: PageResponse,
  files: Record<string, string>,
  path: string,
) => ({
  pageId: page.id,
  name: page.name,
  description: page.description,
  scope: scopeOf(page.userId),
  url: `/pages/${page.id}`,
  publicUrl: page.publicUrl,
  project: renderProjectManifest(files),
  file: path,
  source: files[path] ?? "",
  definition: {
    // First, because it is what the rest is answerable to: a later turn edits
    // the page against its own brief rather than against a chat history
    // compaction may already have dropped.
    ...(page.definition.brief ? { brief: page.definition.brief } : {}),
    variables: page.definition.variables,
    datasets: page.definition.datasets,
    operations: page.definition.operations,
    ...(page.definition.theme ? { theme: page.definition.theme } : {}),
  },
  ...(page.runtimeErrors.length > 0
    ? {
        runtimeErrors: page.runtimeErrors
          .slice(-MAX_RUNTIME_ERRORS_RETURNED)
          .map((entry) => ({
            at: entry.at,
            ...(entry.source ? { source: entry.source } : {}),
            message: entry.message,
          })),
      }
    : {}),
});

/**
 * Domain tool (deferred) — the conversational builder for pages: live,
 * data-bound mini-apps the team opens like any other view of the workspace.
 * A page is REAL CODE — a small Vue project — against a declared data
 * contract; the server compiles it; no model runs at view time.
 *
 * Two refusal points, everything else sanitize-and-warn:
 * - a compile failure refuses the write with the compiler's error list;
 * - an empty `code.source` on a call that claims to have authored a page is
 *   refused (`pageBlankError`) — a saved blank page reports success, so the
 *   model reads a URL, believes it built something, and loops.
 *
 * TWO INSTANCES, and the split is a capability rather than a sentence because
 * the sentence lost. Measured 2026-08-21 on a real conversation: the parent had
 * `buildPage` loaded (`searchTools` had activated it by name) and this
 * description opened with "building one is `buildPage`'s job, not yours" — and
 * it read 91 344 characters of the build corpus, then authored the page itself
 * across 22 steps on the conversation's own model instead of the one the
 * `page-build` role picks. The page was visibly worse than the delegate's.
 * A prohibition the model must obey is weaker than an action it does not have,
 * and a description that goes on to teach the whole craft reads as permission
 * whatever its first line says.
 *
 * So this tool operates on a page that already EXISTS — read it, tweak it,
 * look at it, publish it. Authoring one is the builder's eight `page*` tools
 * (`tools/page-project/`), which hold a working copy and build it.
 */

/** Everything this tool does. Authoring is not among them, by construction. */
const PAGE_ACTIONS = [
  "get",
  "list",
  "update",
  "review",
  "delete",
  "publish",
  "unpublish",
] as const;

const editingDescription = [
  "Work with pages that already exist — live dashboards, directories and mini-apps the team opens in the app, written as real Vue code over the team's data. A page stores CODE plus a data contract, not a snapshot: datasets re-query on every view, so the numbers are never stale.",
  "",
  "You cannot author a page here, and that is the routing: **`buildPage` makes every page and every change worth calling a change** — a new page, a new view or feature, a redesign, a section that needs different data. It runs a specialist that probes the data, reads the component APIs, and renders the result in a real browser before handing it back; it carries its own design doctrine, so there is nothing for you to read first. What is left here is what you do to a page you did not have to write: read it, retouch a word, look at it, publish it.",
  "",
  "- update: pageId + `edits`: [{ file?, oldString, newString, after?, replaceAll? }] — each patches the file it names, exact-match-once, then the project recompiles. This is for a TARGETED change: a label, a wording, a colour, a threshold, a column the user wants gone. `get` the file first when unsure of its current text. Anything larger — a new view, a new dataset, a layout the user is unhappy with — is `buildPage` with the pageId in its task, not a pile of edits here. Page metadata (name, icon, color, description, scope) also lives on this action.",
  "- get / list: one page — its manifest (a page is a small Vue project: `Page.vue`, `components/*.vue`, `pages/*.vue` when it has views of its own, `composables/*.ts`, `page.json`), its data contract, the source of ONE file (`file`, default `Page.vue`), and its recent runtime errors — fix those when present / the team's pages.",
  "- review: pageId — RENDER the saved page in a browser and report what using it is like: captures at three widths plus below the fold and with every dataset emptied, a scripted click pass that serialises the overlays it opens, then a design critique. Call it to CHECK a page — after a build came back `incomplete`, or when the user says something is broken and you want to see it. `blocking` is MEASURED, not judged. If it comes back with real work in it, that work is `buildPage`'s, not a repair campaign of your own.",
  "- delete: pageId — remove a page for good, and its public URL with it. Yours to call when a page just built is the wrong answer, or when the user asks; ask first otherwise. There is no undo.",
  "- publish / unpublish: mint or revoke a public URL anyone can open without an account. publish FREEZES the current page for that URL while the DATA stays live. It exposes everything the owning team can see, so get the user's explicit agreement first, and hand back the returned publicUrl. A page that reads or writes a connected app is refused — an anonymous visitor cannot spend the team's credentials.",
  "",
  "An `update` EXECUTES the datasets and COMPILES the code, and reports what it finds in `warnings` — fix those in the same turn rather than reporting a page you have not seen work. Compiling is not working, though: `review` is the only action here that has SEEN the page. After a user has the page open, `get` returns its recent RUNTIME errors — what the browser saw.",
  "",
  "Deciding WHETHER a page is the right feature (vs a workflow, a collection, or a one-off file) is `skills/platform-guide/SKILL.md` territory.",
].join("\n");

export const createManagePageTool = () =>
  tool({
    description: editingDescription,
    inputSchema: z.object({
      action: z.enum(PAGE_ACTIONS),
      pageId: z.uuid().optional(),
      name: z.string().max(120).optional(),
      description: z.string().max(4000).optional(),
      icon: z.string().max(60).optional(),
      // A NARROWER palette than Tailwind's hues: the hub swatch tokens only.
      color: z
        .string()
        .max(20)
        .optional()
        .describe(
          `Hub swatch — one of: ${COLLECTION_COLOR_TOKENS.join(", ")}.`,
        ),
      scope: z.enum(["team", "private"]).optional(),
      file: z
        .string()
        .max(80)
        .optional()
        .describe(
          `get only: which file's source to return. Defaults to "${PAGE_ENTRY_FILE}"; the manifest in every get names the others.`,
        ),
      definition: jsonTolerant(definitionSectionsSchema)
        .optional()
        .describe(
          "Sections of the page. On update, a section you send replaces the stored one whole; sections you omit are kept — code included.",
        ),
      edits: jsonTolerant(PageCodeEditsSchema)
        .optional()
        .describe(
          'Targeted source edits, applied in order — [{ file?, oldString, newString, after?, replaceAll? }]. Each patches the file it names (`Page.vue` when it names none), and oldString must match exactly once IN THAT FILE. In a file that repeats itself — twenty cards built the same way — do not widen the anchor until it is unique: name a nearby landmark in `after` and keep oldString short, e.g. { after: "Overdue invoices", oldString: "color=\\"neutral\\"", newString: "color=\\"error\\"" }. Widening is what makes an update cost more than writing the page did, because every line inside the anchor is sent twice. Send one edit per changed site rather than one block spanning several. Edits that match are applied and stored even when a sibling misses; the misses come back in `editsNotApplied` with the real surrounding lines — re-send only those.',
        ),
    }),
    execute: async (input, options) => {
      const ctx = getRuntimeContext(options);
      const { teamId, organizationId, userId } = ctx;
      // A private page is invisible to anyone but its owner (org admins see
      // everything) — same rule as the API/UI.
      const requester: PageRequester | undefined = userId
        ? { userId, isAdmin: await isOrgAdmin(organizationId, userId) }
        : undefined;
      /**
       * What "this build session" means for everything Redis remembers: the
       * review budget, the standing verdict, the draft a refused write left.
       *
       * The TURN, identified by its trace. The page builder runs under
       * `${traceId}.page`, so stripping the suffix puts the delegate and its
       * parent on the SAME budget — keyed per-agent they had one each, and the
       * three-round budget measured five rounds (2026-08-23). A new user
       * message is a new trace, hence a fresh budget and a fresh look at the
       * page, which is what a turn saying "this looks broken" needs.
       */
      const turnScope = ctx.traceId?.split(".")[0] ?? ctx.conversationId;

      const definitionInput = input.definition;

      try {
        switch (input.action) {
          case "get": {
            if (!input.pageId) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "get needs a pageId.",
                "Call { action: 'list' } to find it.",
              );
            }
            const page = await getPage({
              pageId: input.pageId,
              teamId,
              requester,
            });
            const files = projectFromDefinition(page.definition, {
              id: page.id,
              name: page.name,
              description: page.description,
            }).files;
            const path = input.file ?? PAGE_ENTRY_FILE;
            if (files[path] === undefined) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                `This page has no ${path}.`,
                `Its files are: ${Object.keys(files).join(", ")}.`,
              );
            }
            // One file can reach 240k chars. Persisting beats truncating: the
            // agent anchors its edits on exact text, and a half-streamed file
            // is text it cannot anchor on.
            const view = agentPageView(page, files, path);
            const persisted = await maybePersistLargeOutput(
              view,
              ctx.conversationId,
              options.toolCallId,
            );
            if (typeof persisted !== "string" || !ctx.conversationId) {
              return persisted;
            }
            // The persisted JSON escapes the whole file onto one line. Anchors
            // are copied from this text, so hand it over unescaped as well.
            const sourcePath = await persistSidecar(
              view.source,
              ctx.conversationId,
              options.toolCallId,
              path.endsWith(".ts") ? "source.ts" : "source.vue",
            );
            return `${persisted}\n${path} on its own, unescaped: ${sourcePath} — read it with \`read\`, and copy edit anchors from there rather than from the JSON above.`;
          }

          case "delete": {
            if (!input.pageId) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "delete needs a pageId.",
                "Call { action: 'list' } to find it.",
              );
            }
            // Read it first so the result names what went — a bare "deleted"
            // leaves the agent unable to tell the user which page it removed.
            const doomed = await getPage({
              pageId: input.pageId,
              teamId,
              requester,
            });
            await deletePage({ pageId: input.pageId, teamId, requester });
            return { pageId: doomed.id, name: doomed.name, deleted: true };
          }

          case "list": {
            const pages = await listPages({ teamId, requester });
            return {
              pages: pages.map((page) => ({
                pageId: page.id,
                name: page.name,
                description: truncateForListing(page.description),
                scope: scopeOf(page.userId),
                datasetCount: page.datasetCount,
                sourceBytes: page.sourceBytes,
                published: page.publicToken !== null,
                updatedAt: page.updatedAt.toISOString(),
              })),
            };
          }

          case "update": {
            if (!input.pageId) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "update needs a pageId.",
                "Call { action: 'list' } to find it.",
              );
            }
            // An update carrying nothing to change. Measured in production
            // (Langfuse `01a0469c…`): `update { pageId, definition: {} }` was
            // accepted, wrote a version identical to the one before it, and
            // came back reporting success — so the agent believed a fix had
            // landed, and reviewed a page nothing had touched. Refused before
            // the read, because the cheapest answer to "what did this change?"
            // is "nothing, and here is what you meant to send".
            const changes = [
              definitionInput !== undefined &&
                Object.values(definitionInput).some(
                  (section) => section !== undefined,
                ),
              (input.edits?.length ?? 0) > 0,
              input.name !== undefined,
              input.description !== undefined,
              input.icon !== undefined,
              input.color !== undefined,
              input.scope !== undefined,
            ];
            if (!changes.some(Boolean)) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "This update carries nothing to change — no edits, no definition section, no metadata.",
                "Send `edits` for a targeted source change, a `definition` section for datasets/operations/brief, or `name`/`description`/`icon`/`color`/`scope` for the card. An empty `definition: {}` changes nothing and is not how a page is saved.",
              );
            }
            // The back door, closed. Removing `create` from the enum stops a
            // page being authored here; a `definition` on update is the same
            // thing under another name — `{ code: { source } }` replaces the
            // whole file. `edits` stay open: a targeted patch against the
            // stored source is the cheap change this tool SHOULD make rather
            // than paying for a delegate to retitle a card.
            if (definitionInput) {
              return toolError(
                TOOL_ERROR_CODES.PAGE_REQUIRES_BUILDER,
                "Rewriting a page's definition is `buildPage`'s work, not this tool's.",
                "For a targeted change send `edits` instead — [{ oldString, newString }] against the stored source. For anything larger, call buildPage with this pageId and the full request in its task.",
              );
            }
            const existing = await getPage({
              pageId: input.pageId,
              teamId,
              requester,
            });
            const storedSource = existing.definition.code.source;

            // Edits patch the file each one names — `file` on an edit, the
            // entry when it names none. Anchor uniqueness is a property of ONE
            // file: the same `class="p-4"` occurs in six components and in
            // none of them ambiguously.
            let definition: PageDefinition | undefined;
            let editFailures: string[] = [];
            if (input.edits) {
              const edited = applyPageProjectEdits(
                existing.definition.code,
                input.edits,
              );
              if (!edited.ok) {
                return toolError(
                  TOOL_ERROR_CODES.INVALID_ARGS,
                  edited.error,
                  "Call { action: 'get' } to read the current files, then re-anchor the edit.",
                );
              }
              // What landed is kept; what missed is named. Refusing all of them
              // over one drifted anchor bills a whole re-emission for a write
              // that was mostly right.
              editFailures = edited.failures.map((failure) => failure.error);
              definition = {
                ...existing.definition,
                code: {
                  ...edited.code,
                  ...(existing.definition.code.compiled !== undefined
                    ? { compiled: existing.definition.code.compiled }
                    : {}),
                },
              };
            }
            // A definition that ERASES the code is the blank-page mistake in
            // update clothing — refuse it before it reaches the store.
            if (definition) {
              const blank = pageBlankError(definition.code);
              if (blank && storedSource.trim().length > 0) {
                return toolError(TOOL_ERROR_CODES.INVALID_ARGS, blank);
              }
            }

            const icon = sanitizeIcon(input.icon ?? undefined);
            const color = sanitizeColor(input.color ?? undefined);
            let updated: Awaited<ReturnType<typeof updatePage>>;
            try {
              updated = await updatePage({
                pageId: input.pageId,
                teamId,
                actingUserId: userId ?? "",
                requester,
                input: {
                  ...(input.name !== undefined ? { name: input.name } : {}),
                  ...(input.description !== undefined
                    ? { description: input.description }
                    : {}),
                  ...(input.icon !== undefined
                    ? { icon: icon.icon ?? null }
                    : {}),
                  ...(input.color !== undefined
                    ? { color: color.color ?? null }
                    : {}),
                  ...(input.scope !== undefined
                    ? {
                        userId:
                          input.scope === "private" ? (userId ?? null) : null,
                      }
                    : {}),
                  ...(definition ? { definition } : {}),
                },
                // Fills the provenance of a page the hub created empty; never
                // re-parents one that already names its conversation.
                ...(ctx.conversationId
                  ? { sourceConversationId: ctx.conversationId }
                  : {}),
                actor: {
                  actor: "agent",
                  userId: userId ?? null,
                  conversationId: ctx.conversationId ?? null,
                },
              });
            } catch (error) {
              const compileMessage = compileRefusalMessage(error);
              if (compileMessage !== null) {
                // Naming what did NOT land is the difference between one more
                // edit and a loop: an agent whose repair edit silently missed
                // sees the same error twice and concludes the tool ignored it.
                const missed =
                  editFailures.length > 0
                    ? ` ${editFailures.length.toString()} of your edits did NOT apply: ${editFailures.join(" ")}`
                    : "";
                return toolError(
                  TOOL_ERROR_CODES.COMPILE_FAILED,
                  compileMessage,
                  `Nothing was saved and the page is untouched. Read it with { action: 'get' }, then fix the named lines with update { edits }.${missed} If two attempts have not cleared it, hand the whole repair to buildPage with this pageId.`,
                );
              }
              throw error;
            }
            const run = definition
              ? await dryRunPage({
                  definition: updated.page.definition,
                  teamId,
                  userId: userId ?? null,
                  assumeSanitized: true,
                  assumeCompiled: true,
                })
              : { samples: {}, warnings: [], refusals: [] };

            return {
              pageId: updated.page.id,
              url: `/pages/${updated.page.id}`,
              ...(definition ? { samples: run.samples } : {}),
              // Its own field, ahead of `warnings`: those are advice and get
              // truncated, this is the part of the change that is NOT in the
              // page. Re-send only these — the rest is already stored.
              ...(editFailures.length > 0
                ? { editsNotApplied: editFailures }
                : {}),
              warnings: distinctWarnings([
                ...editFailures,
                ...icon.warnings,
                ...color.warnings,
                ...updated.warnings,
                // A refusal from the data half is not advice: it names
                // something that cannot load for anybody. It leads.
                ...run.refusals,
                ...run.warnings,
              ]).slice(0, MAX_WARNINGS_RETURNED),
            };
          }

          case "review": {
            if (!input.pageId) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "review needs a pageId.",
                "Call { action: 'list' } to find it.",
              );
            }
            const page = await getPage({
              pageId: input.pageId,
              teamId,
              requester,
            });
            // The loop itself lives in `services/page-review/run-review.ts`:
            // the builder's `pageReview` and this call are the same review of
            // the same page, sharing one budget, one verdict cache and one
            // critique.
            return await runPageReview({
              page,
              teamId,
              userId: userId ?? null,
              conversationId: ctx.conversationId,
              scope: turnScope,
            });
          }

          case "publish": {
            if (!input.pageId) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "publish needs a pageId.",
              );
            }
            const page = await publishPage({
              pageId: input.pageId,
              teamId,
              publishedByUserId: userId ?? "",
              requester,
            });
            return { pageId: page.id, publicUrl: page.publicUrl };
          }

          case "unpublish": {
            if (!input.pageId) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "unpublish needs a pageId.",
              );
            }
            const page = await unpublishPage({
              pageId: input.pageId,
              teamId,
              requester,
            });
            return { pageId: page.id, published: false };
          }
        }
      } catch (error) {
        const lifted = liftPageError(error, {
          action: input.action,
          ...(input.pageId ? { pageId: input.pageId } : {}),
        });
        if (lifted) return lifted;
        throw error;
      }
    },
  });
