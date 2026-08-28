import db from "@fretik/shared/db";
import {
  COLLECTION_COLOR_TOKENS,
  isValidCollectionColor,
} from "@fretik/shared/lib/colors/collection-colors";
import { isValidIcon } from "@fretik/shared/lib/icons/search";
import { parseApiError } from "@fretik/shared/schemas/errors";
import {
  EMPTY_PAGE_DEFINITION,
  PAGE_LIMITS,
  PageBriefSchema,
  PageCodeEditsSchema,
  PageDatasetSchema,
  PageOperationSchema,
  PageThemeSchema,
  PageVariableSchema,
  describePageDataContract,
  pageBlankError,
  type PageDefinition,
  type PageResponse,
} from "@fretik/shared/schemas/pages";
import { isOrgAdmin } from "@fretik/shared/services/organization/member-role";
import { applyPageCodeEdits } from "@fretik/shared/services/pages/apply-code-edits";
import { createPage } from "@fretik/shared/services/pages/create";
import { deletePage } from "@fretik/shared/services/pages/delete";
import { dryRunPage } from "@fretik/shared/services/pages/dry-run";
import {
  publishPage,
  unpublishPage,
} from "@fretik/shared/services/pages/publish";
import { renderPage } from "@fretik/shared/services/pages/render/render-page";
import { restorePageVersion } from "@fretik/shared/services/pages/restore";
import { getPage, listPages } from "@fretik/shared/services/pages/retrieve";
import { updatePage } from "@fretik/shared/services/pages/update";
import { writePageVersion } from "@fretik/shared/services/pages/versions";
import type { PageRequester } from "@fretik/shared/services/pages/visibility";
import { tool } from "ai";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  DOMAIN_TOOL_THRESHOLD_CHARS,
  maybePersistLargeOutput,
  persistSidecar,
} from "../lib/persisted-output";
import {
  TOOL_ERROR_CODES,
  toolError,
  type ToolErrorOutput,
} from "../lib/tool-error-codes";
import {
  SHIP_SCORE,
  evaluatePageDesign,
} from "../services/page-review/evaluate";
import { gatePageRender } from "../services/page-review/gate";
import {
  MAX_PAGE_REVIEW_ITERATIONS,
  bestEarlierRound,
  bumpPageReviewIteration,
  clearPageDraft,
  hashPageSource,
  listComponentsRead,
  listPageReviewRounds,
  readPageDraft,
  readPageReviewIterations,
  readPageReviewVerdict,
  recordComponentsRead,
  recordPageReviewRound,
  recordPageReviewVerdict,
  savePageDraft,
} from "../services/page-review/page-session-store";
import {
  MAX_COMPONENT_DOCS,
  listComponentNames,
  listContractHeavy,
  readComponentDocs,
} from "./page-component-docs";
import {
  EMITTED_SOURCE_SENTINEL,
  resolveEmittedSource,
} from "./page-emitted-source";
import { PAGE_ENVIRONMENT_GUIDE } from "./page-environment-guide";

/**
 * A page's own name, when the `create` call forgot to send one.
 *
 * Refusing was measured to be the expensive answer: on 2026-08-22 a builder
 * spent an 8 000-token generation writing a complete page, called `create`
 * without `name`, was refused — and the only way to retry is to regenerate the
 * whole SFC, which is exactly where that build produced a zombie step and saved
 * nothing at all. Two of thirteen eval cases died that way, having written
 * their page correctly.
 *
 * Derived, never invented: the `<h1>` a page renders IS its title, so there is
 * exactly one correct answer — the condition `autofix.ts` sets for repairing
 * rather than reporting. A heading built entirely from an interpolation gives
 * nothing, and the caller still refuses.
 */
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;

const derivePageName = (
  definition: DefinitionSections | undefined,
): string | null => {
  const heading = H1_RE.exec(definition?.code?.source ?? "")?.[1] ?? "";
  const text = heading
    .replace(/\{\{[\s\S]*?\}\}/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > 0) return text.slice(0, 120);
  const job = definition?.brief?.product?.job?.trim() ?? "";
  return job.length > 0 ? job.slice(0, 120) : null;
};

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

/** `<UModal`, `<u-modal`, `</USlideover>` — every Nuxt UI tag in a template. */
const USED_COMPONENT_RE = /<\/?[uU][A-Z-][A-Za-z0-9-]*/g;

const componentsUsedIn = (source: string): string[] => [
  ...new Set(
    [...source.matchAll(USED_COMPONENT_RE)].map((match) =>
      match[0].replace(/^<\/?/, ""),
    ),
  ),
];

/**
 * Name the components this page places by hand without ever having read their
 * API. Not a refusal — compile stays the only write gate — but the omission
 * stops being invisible, and the next `review` can be read against it.
 *
 * This exists because documenting the rule did not work. The skill says to call
 * `components` before writing a template; two shipped pages skipped it and both
 * failed the same way, on a slot placed by intuition. Nuxt UI does not complain
 * — it renders something plausible — so nothing downstream could catch it.
 */
const unreadComponentWarnings = async (
  source: string,
  conversationId: string | undefined,
): Promise<string[]> => {
  // No conversation, nothing to have remembered: warning about everything
  // would only teach the agent that this channel is noise.
  if (!conversationId) return [];
  const heavy = await listContractHeavy(componentsUsedIn(source));
  if (heavy.length === 0) return [];
  const read = await listComponentsRead(conversationId);
  const unread = heavy.filter((name) => !read.has(name));
  if (unread.length === 0) return [];
  return [
    `Placed without reading their API: ${unread.join(", ")}. These components expect their parts in NAMED slots — put content in the wrong one and it renders somewhere else, or not at all, with no error. Call { action: "components", components: [${unread
      .slice(0, MAX_COMPONENT_DOCS)
      .map((name) => `"${name}"`)
      .join(", ")}] } and check each one you used.`,
  ];
};

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
      `The COMPLETE Vue SFC — never a fragment. Page-scale source does not travel here: write it as a \`\`\`vue fenced block in your message, then send exactly "${EMITTED_SOURCE_SENTINEL}" as this value and it is read back from that fence. Code inside a tool call is cut mid-write by provider timeouts; code as text is not.`,
    ),
});
type DefinitionSections = z.infer<typeof definitionSectionsSchema>;

/**
 * Past this, an inline source is long enough to be killed mid-generation on a
 * slow upstream (see `page-emitted-source.ts`). Warned, never refused: a
 * refusal lands AFTER the emission was paid for, and one that arrived intact
 * survived — the point is to move the NEXT write onto the fence, not to bill
 * this one twice.
 */
const INLINE_SOURCE_WARNING_CHARS = 8_000;

const inlineSourceWarnings = (
  sections: DefinitionSections | undefined,
  wasEmitted: boolean,
): string[] =>
  !wasEmitted &&
  (sections?.code?.source.length ?? 0) > INLINE_SOURCE_WARNING_CHARS
    ? [
        `Source this size sent as a tool argument is cut mid-write when the provider is slow, and a cut write saves nothing. Next time emit it as a \`\`\`vue fenced block in your message and send "${EMITTED_SOURCE_SENTINEL}" as definition.code.source.`,
      ]
    : [];

/** Assemble a stored definition from sections + a base (the stored page on
 * update, the empty page on create). */
const assembleDefinition = (
  base: PageDefinition,
  sections: DefinitionSections | undefined,
): PageDefinition => ({
  version: 3,
  ...((sections?.brief ?? base.brief)
    ? { brief: sections?.brief ?? base.brief }
    : {}),
  variables: sections?.variables ?? base.variables,
  datasets: sections?.datasets ?? base.datasets,
  operations: sections?.operations ?? base.operations,
  ...(sections?.theme === null
    ? {}
    : (sections?.theme ?? base.theme)
      ? { theme: sections?.theme ?? base.theme }
      : {}),
  code: sections?.code
    ? { source: sections.code.source }
    : {
        source: base.code.source,
        ...(base.code.compiled ? { compiled: base.code.compiled } : {}),
      },
});

/**
 * The directive that closes a data-first draft. It has to name the NEXT CALL,
 * not describe the state: a page opened without code renders nothing, and a
 * result that only said so is what let a blank page be reported as finished.
 */
const DRAFT_NEXT_STEP = (pageId: string): string =>
  `The page is open and its datasets resolve, but it has no code yet — nothing renders. Emit the complete SFC as a \`\`\`vue block, then save it with update { pageId: "${pageId}", definition: { code: { source: "${EMITTED_SOURCE_SENTINEL}" } } }, and hand back the url.`;

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
        "Nothing was saved. Fix the named lines in the SFC and resend it.",
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

/**
 * Draft slot for a page that does not exist yet — a `create` the compiler
 * refused. One per turn: a builder writes one page at a time.
 */
const NEW_PAGE_DRAFT = "new";

/** The compiler's own message when `err` is a compile refusal, else null. */
const compileRefusalMessage = (err: unknown): string | null => {
  if (!(err instanceof HTTPException) || err.status !== 400) return null;
  const message = parseApiError(err.message)?.message;
  return message !== undefined &&
    message.startsWith("Page code failed to compile")
    ? message
    : null;
};

/**
 * The outcome of saving a source nobody asked to save — see `savePageSource`.
 * `reason` is written for the AGENT: it ends up in the build marker, and the
 * parent decides what to tell the user from it.
 */
export type SalvageOutcome =
  | { saved: true; pageId: string; url: string }
  | { saved: false; reason: string };

/**
 * Save a page source OUTSIDE a tool call — the recovery path for a run that
 * wrote its SFC and died before saving it.
 *
 * This exists because of what the fence protocol makes possible. The source
 * now streams as text, so a build cut mid-flight leaves the complete file in
 * its own transcript: the worst failure in the product (a whole page written,
 * paid for, and lost — measured ten times on 2026-08-26) becomes a page on
 * disk. `build-page.ts` calls this when it finds such a fence unclaimed.
 *
 * Best-effort by construction: every failure comes back as a sentence rather
 * than a throw, because the alternative to an imperfect save here is nothing
 * at all.
 */
export const savePageSource = async (params: {
  source: string;
  pageId?: string;
  name?: string;
  teamId: string;
  organizationId: string;
  userId: string | null;
  conversationId?: string;
}): Promise<SalvageOutcome> => {
  const sections: DefinitionSections = { code: { source: params.source } };
  const actor = {
    actor: "agent" as const,
    userId: params.userId ?? null,
    conversationId: params.conversationId ?? null,
  };
  try {
    if (params.pageId !== undefined) {
      const requester: PageRequester | undefined = params.userId
        ? {
            userId: params.userId,
            isAdmin: await isOrgAdmin(params.organizationId, params.userId),
          }
        : undefined;
      const existing = await getPage({
        pageId: params.pageId,
        teamId: params.teamId,
        requester,
      });
      // The same guard the tool applies, for the same reason: an unclaimed
      // fence can be a SECTION the builder was about to splice in, and
      // overwriting a whole page with it is destruction under a rescue's name.
      if (
        isDestructiveRewrite(existing.definition.code.source, params.source)
      ) {
        return {
          saved: false,
          reason:
            "the source it wrote is far shorter than the stored page, so it was left alone",
        };
      }
      const updated = await updatePage({
        pageId: params.pageId,
        teamId: params.teamId,
        actingUserId: params.userId ?? "",
        requester,
        input: {
          definition: assembleDefinition(existing.definition, sections),
        },
        actor,
      });
      return {
        saved: true,
        pageId: updated.page.id,
        url: `/pages/${updated.page.id}`,
      };
    }
    const name = params.name ?? derivePageName(sections);
    if (name === null) {
      return { saved: false, reason: "it carries no heading to name it from" };
    }
    const created = await createPage({
      organizationId: params.organizationId,
      teamId: params.teamId,
      createdByUserId: params.userId ?? "",
      input: {
        name,
        description: "",
        userId: null,
        definition: assembleDefinition(EMPTY_PAGE_DEFINITION, sections),
        ...(params.conversationId
          ? { sourceConversationId: params.conversationId }
          : {}),
      },
      actor,
    });
    return {
      saved: true,
      pageId: created.page.id,
      url: `/pages/${created.page.id}`,
    };
  } catch (error) {
    const compileMessage = compileRefusalMessage(error);
    return {
      saved: false,
      reason:
        compileMessage ??
        (error instanceof Error ? error.message : "it could not be saved"),
    };
  }
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
 * is noise; `source` is the document), the error feed's tail is attached.
 *
 * `draftSource`, when a refused write left one behind, REPLACES `code.source`.
 * Returning the saved page while `update { edits }` patches the kept draft is
 * two different documents behind one name: it is what let an agent spend seven
 * calls "fixing" a line that only existed in a text it was never shown
 * (2026-08-28). What `get` prints must be what the next edit anchors on, and
 * what the compile errors count lines against. */
const agentPageView = (page: PageResponse, draftSource?: string) => ({
  pageId: page.id,
  name: page.name,
  description: page.description,
  scope: scopeOf(page.userId),
  url: `/pages/${page.id}`,
  publicUrl: page.publicUrl,
  definition: {
    // First, because it is what the rest is answerable to: a later turn edits
    // the page against its own brief rather than against a chat history
    // compaction may already have dropped.
    ...(page.definition.brief ? { brief: page.definition.brief } : {}),
    variables: page.definition.variables,
    datasets: page.definition.datasets,
    operations: page.definition.operations,
    ...(page.definition.theme ? { theme: page.definition.theme } : {}),
    code: { source: draftSource ?? page.definition.code.source },
  },
  ...(draftSource !== undefined
    ? {
        sourceIs: "kept-draft",
        keptDraftNote:
          "This is the source your last refused write left behind, NOT what is saved. It is what update { edits } anchors on and what the compile errors number lines against. Fix it here, or send a whole corrected file as definition.code.source to replace it.",
      }
    : {}),
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
 * The agent writes REAL CODE (a Vue SFC) against a declared data contract; the
 * server compiles it; no model runs at view time.
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
 * So `authoring: false` (the parent, and generic sub-agents) keeps the actions
 * that operate on a page that already exists — read it, tweak it, look at it,
 * publish it — and loses the four that AUTHOR one. `authoring: true` (the page
 * builder, whose prompt owns the process) keeps everything.
 */

/** Actions that operate on an EXISTING page. Both instances have these. */
const PAGE_ACTIONS = [
  "get",
  "list",
  "update",
  "review",
  "delete",
  "publish",
  "unpublish",
] as const;

/** Actions that AUTHOR a page. The builder's instance only. */
const AUTHORING_ACTIONS = [
  "get_guide",
  "components",
  "dry_run",
  "create",
  "stage",
  ...PAGE_ACTIONS,
] as const;

/**
 * What `stage` answers. It cannot read the fence it accompanies — a tool sees
 * the messages that PROMPTED its step, not the assistant message it was called
 * from — so its whole job is to keep the loop alive while the source streams as
 * text, and to name the call that claims it.
 */
const STAGE_NEXT_STEP = `The source is in your message. Now save it: create — or update { pageId } for a page that exists — with definition.code.source set to exactly "${EMITTED_SOURCE_SENTINEL}", plus name and the definition sections that go with it. Do not write the code again.`;

const authoringDescription = [
  "Read, write and publish pages — live dashboards, directories and mini-apps the team opens in the app, written as real Vue code over the team's data. A page stores CODE plus a data contract, not a snapshot: datasets re-query on every view, so the numbers are never stale.",
  "",
  "- get_guide: the runtime contract (allowed imports, the fretik bridge API, sandbox rules, styling tokens) + the dataset/variable/operation grammar. Read it before your FIRST page in a conversation.",
  "- components: the real Nuxt UI API — every prop, slot and emit — for up to 6 components at a time, generated from the library's own docs. Add `full: true` for usage notes and worked examples when the API alone leaves you guessing. Ask for the ones your page will actually use, before writing the template: guessed props are silently dropped, and content put in the wrong named slot renders somewhere else with no error. What you read here is remembered for the conversation, and a write that places a named-slot component you never read says so in `warnings`. The skill says WHICH component fits; this says what it accepts.",
  "- dry_run: execute a definition WITHOUT saving — runs the datasets, compiles the code. Returns per-dataset samples (row count, real field names, one real row, distinct groups): every question you would otherwise pay a querySql round trip for. A definition without `code` is a pure DATA probe. Never dry_run a page you are about to save or just saved: create and update already compile and return the same samples and warnings, so a dry_run there re-sends the whole source to learn nothing.",
  `- stage: call it in the SAME message as the \`\`\`vue block holding your source. Writing a page as text is what keeps the connection alive while it streams — source sent as a tool argument is cut mid-write whenever the provider is slow, and a cut write saves nothing. \`stage\` returns the call that saves what you just wrote.`,
  `- create: name + definition { brief?, variables?, datasets?, operations?, theme?, code? } (+ icon, color, description, scope team|private). The tool stamps the version and fills defaults. \`definition.code.source\` takes "${EMITTED_SOURCE_SENTINEL}", which reads back the \`\`\`vue block from your previous message — that is how a page is saved. Omit \`code\` to open a data-first draft, then write it via update. When a create fails to compile the source is KEPT for 15 minutes: repeat create with \`name\` + \`edits\` — one per named line, against that kept source — rather than writing the page a second time.`,
  `- update: pageId + any field. Code changes go through \`edits\` — [{ oldString, newString, after?, replaceAll? }], exact-match-once against the stored source, then recompiled — however many sites they touch; that is the normal path, not a small-change path. \`get\` first when unsure of the current source. Replacing the whole file instead goes through the same route as create: emit it as a \`\`\`vue block, then send definition.code.source "${EMITTED_SOURCE_SENTINEL}". The non-code \`definition\` sections REPLACE whole and omitted ones keep their stored value, so datasets, operations and the brief change here too, in the same call as the edits that use them. A whole-file replacement much SMALLER than the stored source is refused without \`rewrite: true\` — that shape is how a "targeted repair" once destroyed a page. When a write fails to compile, the source is KEPT for 15 minutes: fix the named lines with \`edits\` (they apply to that kept source) instead of writing the file again.`,
  '- review: pageId — RENDER the saved page in a browser and report what using it is like. Captures at desktop, tablet and mobile widths, plus below the fold when the page is taller than the screen and the same page with every dataset emptied, a scripted click pass — which also serialises the overlays it opens, so what is behind a click is judged too — then a design critique. `blocking` is MEASURED, not judged — an overlay that opens empty or prints a raw object, id or timestamp, a target that does nothing when clicked, sideways scroll, a blank empty state — and it fails a page the critique liked. Fix those first, apply `findings` with `edits`, review again. `verdict: "ship"` ENDS the loop: hand back the url and pass `elevations` (what would make the page better, not what is broken) on as next steps — an unchanged page returns its standing verdict rather than a re-score, and the budget is three scored reviews per turn, shared with whoever else reviews this page. Every scored round is SAVED, and if an earlier one scored clearly higher the page is restored to it and `restoredFromRound` says so — when that happens the stored source is no longer the one you sent, so `get` before editing again.',
  "- get / list: one page's full source + data contract (+ its recent runtime errors — fix those when present) / the team's pages.",
  "- delete: pageId — remove a page for good, and its public URL with it. Yours to call when a page you just made is the wrong answer, or when the user asks; ask first otherwise. There is no undo.",
  "- publish / unpublish: mint or revoke a public URL anyone can open without an account. publish FREEZES the current page for that URL while the DATA stays live. It exposes everything the owning team can see, so get the user's explicit agreement first, and hand back the returned publicUrl. A page that reads or writes a connected app is refused — an anonymous visitor cannot spend the team's credentials.",
  "",
  "dry_run, create and update all EXECUTE the datasets and COMPILE the code, and report what they find in `warnings` — a compile error, a wrong field key, a dataset with no rows, a component placed without reading its API. Fix them in the same turn rather than reporting a page you have not seen work. Compiling is not working, though: `review` is the only action here that has SEEN the page, so a page is finished when a review says so, not when the write succeeds. After a user has the page open, `get` returns its recent RUNTIME errors — what the browser saw; fix and update.",
  "",
  "Call describeCollection for field keys, types and option values BEFORE writing a collections dataset; guessing keys is the main way a page comes back empty.",
].join("\n");

const editingDescription = [
  "Work with pages that already exist — live dashboards, directories and mini-apps the team opens in the app, written as real Vue code over the team's data. A page stores CODE plus a data contract, not a snapshot: datasets re-query on every view, so the numbers are never stale.",
  "",
  "You cannot author a page here, and that is the routing: **`buildPage` makes every page and every change worth calling a change** — a new page, a new view or feature, a redesign, a section that needs different data. It runs a specialist that probes the data, reads the component APIs, and renders the result in a real browser before handing it back; it carries its own design doctrine, so there is nothing for you to read first. What is left here is what you do to a page you did not have to write: read it, retouch a word, look at it, publish it.",
  "",
  "- update: pageId + `edits`: [{ oldString, newString, after?, replaceAll? }] — exact-match-once against the stored source, then recompiled. This is for a TARGETED change: a label, a wording, a colour, a threshold, a column the user wants gone. `get` first when unsure of the current source. Anything larger — a new view, a new dataset, a layout the user is unhappy with — is `buildPage` with the pageId in its task, not a pile of edits here. Page metadata (name, icon, color, description, scope) also lives on this action.",
  "- get / list: one page's full source + data contract (+ its recent runtime errors — fix those when present) / the team's pages.",
  "- review: pageId — RENDER the saved page in a browser and report what using it is like: captures at three widths plus below the fold and with every dataset emptied, a scripted click pass that serialises the overlays it opens, then a design critique. Call it to CHECK a page — after a build came back `incomplete`, or when the user says something is broken and you want to see it. `blocking` is MEASURED, not judged. If it comes back with real work in it, that work is `buildPage`'s, not a repair campaign of your own.",
  "- delete: pageId — remove a page for good, and its public URL with it. Yours to call when a page just built is the wrong answer, or when the user asks; ask first otherwise. There is no undo.",
  "- publish / unpublish: mint or revoke a public URL anyone can open without an account. publish FREEZES the current page for that URL while the DATA stays live. It exposes everything the owning team can see, so get the user's explicit agreement first, and hand back the returned publicUrl. A page that reads or writes a connected app is refused — an anonymous visitor cannot spend the team's credentials.",
  "",
  "An `update` EXECUTES the datasets and COMPILES the code, and reports what it finds in `warnings` — fix those in the same turn rather than reporting a page you have not seen work. Compiling is not working, though: `review` is the only action here that has SEEN the page. After a user has the page open, `get` returns its recent RUNTIME errors — what the browser saw.",
  "",
  "Deciding WHETHER a page is the right feature (vs a workflow, a collection, or a one-off file) is `skills/platform-guide/SKILL.md` territory.",
].join("\n");

export const createManagePageTool = (config: { authoring: boolean }) =>
  tool({
    description: config.authoring ? authoringDescription : editingDescription,
    inputSchema: z.object({
      // One `z.enum` over a narrowed list, not two schemas: the model's JSON
      // schema really does lose the four authoring actions, while the switch
      // below stays exhaustive over both instances.
      action: z.enum(config.authoring ? AUTHORING_ACTIONS : PAGE_ACTIONS),
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
      components: z
        .array(z.string().max(40))
        .max(MAX_COMPONENT_DOCS)
        .optional()
        .describe(
          `components only: up to ${MAX_COMPONENT_DOCS} component names — ["UTable", "UBadge", "USlideover"].`,
        ),
      full: z
        .boolean()
        .optional()
        .describe(
          "components only: add the usage notes and worked examples to the API. Ask for it when the props and slots alone leave you guessing — it costs about three times the tokens.",
        ),
      definition: jsonTolerant(definitionSectionsSchema)
        .optional()
        .describe(
          "Sections of the page. On update, a section you send replaces the stored one whole; sections you omit are kept — code included.",
        ),
      edits: jsonTolerant(PageCodeEditsSchema)
        .optional()
        .describe(
          'Targeted source edits, applied in order — [{ oldString, newString, after?, replaceAll? }]. On update they patch the stored source; on create they patch the source a refused create kept. oldString must match exactly once. In a file that repeats itself — twenty cards built the same way — do NOT widen the anchor until it is unique: name a nearby landmark in `after` and keep oldString short, e.g. { after: "Overdue invoices", oldString: "color=\\"neutral\\"", newString: "color=\\"error\\"" }. Widening is what makes an update cost more than writing the page did, because every line inside the anchor is sent twice. Send one edit per changed site rather than one block spanning several. Edits that match are applied and stored even when a sibling misses; the misses come back in `editsNotApplied` with the real surrounding lines — re-send only those. Combine `edits` with the other `definition` sections in one call; they are ignored only when `definition.code` is sent too.',
        ),
      ...(config.authoring
        ? {
            rewrite: z
              .boolean()
              .optional()
              .describe(
                "update only: confirm replacing the SFC with a much SMALLER one. Required only when the sent code shrinks the page past what a fix plausibly would — set it when the user asked for a different, smaller page; a fix, a new section or a review finding is `edits`.",
              ),
          }
        : {}),
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

      /**
       * Resolve `"@emitted"` before any action reads the definition, so every
       * branch below works on real source and none of them knows about the
       * protocol. See `page-emitted-source.ts` for why the source travels as
       * text at all.
       */
      const claimsEmitted =
        input.definition?.code?.source === EMITTED_SOURCE_SENTINEL;
      let definitionInput: DefinitionSections | undefined = input.definition;
      if (claimsEmitted) {
        const emitted = resolveEmittedSource(options.messages);
        if (emitted === null) {
          // Cheap to retry BY DESIGN — the arguments are a few dozen tokens,
          // and the fence the model just wrote is already paid for. The one
          // thing this must never do is send it back to writing the file.
          return toolError(
            TOOL_ERROR_CODES.INVALID_ARGS,
            "No ```vue block found in your previous messages, so there is no source to save.",
            "If you emitted the source in the SAME message as this call, repeat this call unchanged — a fence becomes readable one step after it is written. Otherwise emit the complete SFC as a ```vue block first, then repeat.",
          );
        }
        definitionInput = {
          ...input.definition,
          code: { source: emitted },
        };
      }

      try {
        switch (input.action) {
          case "stage": {
            return { staged: true, next: STAGE_NEXT_STEP };
          }

          case "get_guide": {
            return {
              guide: PAGE_ENVIRONMENT_GUIDE,
              dataContract: describePageDataContract(),
            };
          }

          case "components": {
            if (!input.components || input.components.length === 0) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "No component names given.",
                `Send { action: "components", components: ["UTable", "UBadge"] } — up to ${MAX_COMPONENT_DOCS} per call.`,
              );
            }
            const result = await readComponentDocs(input.components, {
              ...(input.full !== undefined ? { full: input.full } : {}),
            });
            if ("error" in result) {
              return toolError(TOOL_ERROR_CODES.INTERNAL_ERROR, result.error);
            }
            if (result.docs.length === 0) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                `No such component: ${result.unknown.join(", ")}.`,
                `The page runtime registers: ${(await listComponentNames()).join(", ")}.`,
              );
            }
            await recordComponentsRead(
              ctx.conversationId,
              result.docs.map((doc) => doc.component),
            );
            // Six heavy components measure ~120k chars. Without this the
            // stream truncates and the model reads a mangled API — the exact
            // failure this action exists to prevent.
            return await maybePersistLargeOutput(
              {
                docs: result.docs,
                ...(result.unknown.length > 0
                  ? {
                      unknown: result.unknown,
                      hint: "Those are not registered in the page runtime — do not use them in a template; they render as unknown elements.",
                    }
                  : {}),
              },
              ctx.conversationId,
              options.toolCallId,
              DOMAIN_TOOL_THRESHOLD_CHARS,
            );
          }

          case "dry_run": {
            if (!definitionInput) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "dry_run needs a definition.",
                "Send { action: 'dry_run', definition: { datasets, code? } }.",
              );
            }
            const definition = assembleDefinition(
              EMPTY_PAGE_DEFINITION,
              definitionInput,
            );
            const run = await dryRunPage({
              definition,
              teamId,
              userId: userId ?? null,
            });
            return {
              samples: run.samples,
              warnings: distinctWarnings(run.warnings).slice(
                0,
                MAX_WARNINGS_RETURNED,
              ),
            };
          }

          case "create": {
            // A create refused on compile keeps its source too, and this is
            // the most expensive emission in the product to lose: the page
            // does not exist yet, so the only retry is to write the whole SFC
            // again. `edits` on `create` are how that retry gets paid once —
            // they anchor on the kept source, exactly like the update path.
            const pendingDraft = await readPageDraft(turnScope, NEW_PAGE_DRAFT);
            let createSections = definitionInput;
            let createEditFailures: string[] = [];
            if (input.edits && !definitionInput?.code) {
              if (pendingDraft === null) {
                return toolError(
                  TOOL_ERROR_CODES.INVALID_ARGS,
                  "There is no page to edit: `edits` on create only re-anchor a source a refused create left behind, and none is pending.",
                  "Send { action: 'create', name, definition } with the full SFC — or, for a page that exists, update { pageId, edits }.",
                );
              }
              const edited = applyPageCodeEdits(pendingDraft, input.edits);
              if (!edited.ok) {
                return toolError(
                  TOOL_ERROR_CODES.INVALID_ARGS,
                  edited.error,
                  "Re-anchor the edit on the source you last sent — it is what these edits apply to.",
                );
              }
              createEditFailures = edited.failures.map(
                (failure) => failure.error,
              );
              createSections = {
                ...(createSections ?? {}),
                code: { source: edited.source },
              };
            }

            const derivedName = input.name ?? derivePageName(createSections);
            if (!derivedName) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "create needs a name, and the page carries no heading to take one from.",
                "Send { action: 'create', name, definition }.",
              );
            }
            const icon = sanitizeIcon(input.icon);
            const color = sanitizeColor(input.color);
            const definition = assembleDefinition(
              EMPTY_PAGE_DEFINITION,
              createSections,
            );
            const drafting = definition.code.source.trim().length === 0;

            let created: Awaited<ReturnType<typeof createPage>>;
            try {
              created = await createPage({
                organizationId,
                teamId,
                createdByUserId: userId ?? "",
                input: {
                  name: derivedName,
                  description: input.description ?? "",
                  icon: icon.icon,
                  color: color.color,
                  userId: input.scope === "private" ? (userId ?? null) : null,
                  definition,
                  ...(ctx.conversationId
                    ? { sourceConversationId: ctx.conversationId }
                    : {}),
                },
                // Labelled as the agent's work so the history reads "the agent
                // wrote this", and so the coalescing window never folds a
                // person's state into a build's.
                actor: {
                  actor: "agent",
                  userId: userId ?? null,
                  conversationId: ctx.conversationId ?? null,
                },
              });
            } catch (error) {
              const compileMessage = compileRefusalMessage(error);
              if (compileMessage !== null && !drafting) {
                await savePageDraft(
                  turnScope,
                  NEW_PAGE_DRAFT,
                  definition.code.source,
                );
                return toolError(
                  TOOL_ERROR_CODES.INVALID_ARGS,
                  compileMessage,
                  'No page was created, but the source you sent WAS KEPT for 15 minutes. Do not write it again: repeat { action: "create", name, edits } with one edit per named line — they apply to the kept source.',
                );
              }
              throw error;
            }
            await clearPageDraft(turnScope, NEW_PAGE_DRAFT);

            const run = await dryRunPage({
              definition: created.page.definition,
              teamId,
              userId: userId ?? null,
              assumeSanitized: true,
              assumeCompiled: true,
            });

            return {
              pageId: created.page.id,
              url: `/pages/${created.page.id}`,
              scope: scopeOf(created.page.userId),
              samples: run.samples,
              ...(createEditFailures.length > 0
                ? { editsNotApplied: createEditFailures }
                : {}),
              warnings: distinctWarnings([
                ...createEditFailures,
                ...inlineSourceWarnings(input.definition, claimsEmitted),
                ...icon.warnings,
                ...color.warnings,
                ...created.warnings,
                ...run.warnings,
                ...(await unreadComponentWarnings(
                  created.page.definition.code.source,
                  ctx.conversationId,
                )),
              ]).slice(0, MAX_WARNINGS_RETURNED),
              ...(drafting ? { next: DRAFT_NEXT_STEP(created.page.id) } : {}),
            };
          }

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
            // Show the kept draft when there is one — `update { edits }` would
            // anchor on it, so printing the saved page instead hands the agent
            // a document its own next call does not patch.
            const keptDraft = await readPageDraft(turnScope, input.pageId);
            // A page's source can reach 240k chars. Persisting beats
            // truncating: the agent anchors its edits on exact text, and a
            // half-streamed SFC is text it cannot anchor on.
            const view = agentPageView(page, keptDraft ?? undefined);
            const persisted = await maybePersistLargeOutput(
              view,
              ctx.conversationId,
              options.toolCallId,
            );
            if (typeof persisted !== "string" || !ctx.conversationId) {
              return persisted;
            }
            // The persisted JSON escapes the whole SFC onto one line. Anchors
            // are copied from this text, so hand it over unescaped as well.
            const sourcePath = await persistSidecar(
              view.definition.code.source,
              ctx.conversationId,
              options.toolCallId,
              "source.vue",
            );
            return `${persisted}\nThe SFC source on its own, unescaped: ${sourcePath} — read it with \`read\`, and copy edit anchors from there rather than from the JSON above.`;
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
            // The other half of the authoring split. Removing `create` from the
            // enum closes the front door; a `definition` on update is the back
            // one — `{ code: { source } }` replaces the whole SFC, which is
            // authoring a page under an edit's name. `edits` stay open: a
            // targeted patch against the stored source is the cheap change the
            // parent SHOULD make rather than paying for a delegate to retitle
            // a card.
            if (!config.authoring && definitionInput) {
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

            // The builder's own door. The first cut of this guard refused
            // EVERY whole-file `definition.code` without `rewrite: true` — and
            // the measured result (2026-08-23) was the worst of both worlds:
            // the refusal lands AFTER the model has already paid ~16k output
            // tokens for the definition, and it re-emits the identical bytes
            // with the flag added, so every page-scale write was billed twice
            // and nothing got smaller. What the guard exists to stop is
            // DESTRUCTION — the "targeted repair" that kept 370 of 1272 lines
            // (2026-08-22) — so that is all it refuses now: a replacement
            // dramatically shorter than what it replaces. Growth and mild
            // shrink pass; keeping fixes cheap is the prompt's job, not a
            // post-payment toll booth's.
            if (
              config.authoring &&
              definitionInput?.code &&
              input.rewrite !== true &&
              isDestructiveRewrite(storedSource, definitionInput.code.source)
            ) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                `The sent code is ${definitionInput.code.source.length.toString()} chars against ${storedSource.length.toString()} stored — replacing the page with a much smaller one destroys work nobody asked to lose.`,
                "If the user asked for a different, smaller page, repeat with `rewrite: true`. Otherwise change only what needs changing, with `edits`.",
              );
            }

            let sections = definitionInput;
            let editFailures: string[] = [];
            let draftConsumed = false;
            // Which document the edits were applied to. Reported on every
            // outcome: an agent that cannot tell the kept draft from the saved
            // page cannot reason about why its anchors missed.
            let editedBase: "kept-draft" | "saved-page" | null = null;
            // `edits` compose with the OTHER sections, and only `definition.code`
            // displaces them. Declaring an operation and wiring the button that
            // runs it is one change; making the tool take it as two calls is
            // what pushed a whole-file `definition` back into the normal path.
            if (input.edits && !definitionInput?.code) {
              const edits = input.edits;
              // A refused write leaves its source behind (see the compile
              // catch below); edits sent right after a refusal mean "fix MY
              // version", so they anchor on the draft first and fall back to
              // the stored source.
              //
              // The draft only wins when EVERY anchor lands on it. Preferring
              // it on a single match is what turned one bad write into a loop
              // (2026-08-28, 7 identical compile refusals): the batch carried
              // both edits that still matched the draft and the repair edit
              // for the character that broke it. One match pinned the whole
              // batch to the draft, the repair silently missed, the same
              // broken text recompiled, and the refusal below re-saved it and
              // refreshed its TTL. A missed anchor means the agent is not
              // describing THIS text, so the draft is not the document it
              // means — partial application within one document is fine, but
              // choosing BETWEEN two documents is not a place to guess.
              const draft = await readPageDraft(turnScope, input.pageId);
              const onDraft =
                draft !== null ? applyPageCodeEdits(draft, edits) : null;
              const draftTakesAll =
                onDraft?.ok === true && onDraft.failures.length === 0;
              const edited = draftTakesAll
                ? onDraft
                : applyPageCodeEdits(storedSource, edits);
              draftConsumed = draftTakesAll;
              editedBase = draftTakesAll ? "kept-draft" : "saved-page";
              if (!edited.ok) {
                return toolError(
                  TOOL_ERROR_CODES.INVALID_ARGS,
                  `${edited.error} (anchored against the saved page${draft !== null ? ", after none of the edits matched the kept draft either" : ""}.)`,
                  "Call { action: 'get' } to read the current source, then re-anchor the edit.",
                );
              }
              // What landed is kept; what missed is named. The alternative —
              // refusing all of them over one drifted anchor — bills a whole
              // re-emission for a write that was mostly right, which is the
              // single most expensive shape an update takes.
              editFailures = edited.failures.map((failure) => failure.error);
              sections = {
                ...(sections ?? {}),
                code: { source: edited.source },
              };
            }

            const definition = sections
              ? assembleDefinition(existing.definition, sections)
              : undefined;
            // A definition that ERASES the code is the blank-page mistake in
            // update clothing — refuse it before it reaches the store.
            if (definition) {
              const blank = pageBlankError(definition.code);
              if (blank && existing.definition.code.source.trim().length > 0) {
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
              // A write refused on compile keeps what it carried: the resend
              // of a 60k-char page is ~16k output tokens paid twice, and it
              // was measured as roughly half the builder's answer tokens
              // (2026-08-23). The next `edits` call anchors on this draft.
              const compileMessage = compileRefusalMessage(error);
              if (compileMessage !== null && sections?.code) {
                await savePageDraft(
                  turnScope,
                  input.pageId,
                  sections.code.source,
                );
                // Naming what did NOT land is the difference between one more
                // edit and a loop. These misses used to be dropped on this
                // path (they were only reported on success), so an agent whose
                // repair edit had silently missed saw the same error twice and
                // concluded the tool was ignoring it.
                const missed =
                  editFailures.length > 0
                    ? ` ${editFailures.length.toString()} of your edits did NOT apply and are not in the kept source: ${editFailures.join(" ")}`
                    : "";
                const base =
                  editedBase === "kept-draft"
                    ? "the previously kept source"
                    : "the saved page";
                return toolError(
                  TOOL_ERROR_CODES.COMPILE_FAILED,
                  compileMessage,
                  `Nothing was saved. Your edits were applied to ${base}, and the RESULT is kept for 15 minutes — { action: 'get' } now returns THAT text, which is what the line numbers above refer to. Read it, then fix the named lines with update { edits }.${missed} If two attempts have not cleared it, stop editing and send the whole corrected file as definition.code.source — that replaces the kept source outright.`,
                );
              }
              throw error;
            }
            // The write landed, so the page IS the state the agent means —
            // a draft left behind would hijack the next edits.
            if (sections?.code || draftConsumed) {
              await clearPageDraft(turnScope, input.pageId);
            }

            const run = definition
              ? await dryRunPage({
                  definition: updated.page.definition,
                  teamId,
                  userId: userId ?? null,
                  assumeSanitized: true,
                  assumeCompiled: true,
                })
              : { samples: {}, warnings: [] };

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
              // Which document the edits patched. Silent on the normal path
              // (there was no draft, so there was nothing to disambiguate).
              ...(editedBase === "kept-draft"
                ? { editedBase: "kept-draft" }
                : {}),
              warnings: distinctWarnings([
                ...editFailures,
                ...inlineSourceWarnings(input.definition, claimsEmitted),
                ...icon.warnings,
                ...color.warnings,
                ...updated.warnings,
                ...run.warnings,
                ...(definition
                  ? await unreadComponentWarnings(
                      updated.page.definition.code.source,
                      ctx.conversationId,
                    )
                  : []),
              ]).slice(0, MAX_WARNINGS_RETURNED),
              ...(updated.page.definition.code.source.trim().length === 0
                ? { next: DRAFT_NEXT_STEP(updated.page.id) }
                : {}),
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
            const compiled = page.definition.code.compiled;
            if (!compiled) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "This page has no compiled code — there is nothing to render.",
                `Emit the SFC as a \`\`\`vue block, save it with update { pageId: "${page.id}", definition: { code: { source: "${EMITTED_SOURCE_SENTINEL}" } } }, then review.`,
              );
            }

            // Identical bytes get the verdict already paid for: re-scoring an
            // unchanged page measures the critic's variance, not the page
            // (the same source scored 6.8 then 7.8 two minutes apart,
            // 2026-08-23). This is also what makes "ship" final — a shipped
            // page cannot be re-reviewed into a revise without changing first.
            const sourceHash = hashPageSource(page.definition.code.source);
            const cachedVerdict = await readPageReviewVerdict(
              turnScope,
              page.id,
            );
            if (cachedVerdict && cachedVerdict.sourceHash === sourceHash) {
              return {
                ...cachedVerdict.result,
                cached: true,
                next: cachedVerdict.shipped
                  ? "This exact version was already reviewed: the verdict stands — ship. Hand back the url; do not review again."
                  : `This exact version was already reviewed (round ${cachedVerdict.round.toString()}) and the findings stand. Apply them with update { edits } — a review re-scores only after the page changes.`,
              };
            }

            // The budget is shared by EVERYONE reviewing in this turn — the
            // builder and the parent count against `turnScope`, which is what
            // "three reviews" means. Checked BEFORE the render so a spent
            // budget costs no browser, screenshots or critic.
            const spent = await readPageReviewIterations(turnScope, page.id);
            if (spent >= MAX_PAGE_REVIEW_ITERATIONS) {
              return {
                pageId: page.id,
                url: `/pages/${page.id}`,
                review: "refused",
                iteration: `${spent.toString()}/${MAX_PAGE_REVIEW_ITERATIONS.toString()}`,
                next: "The review budget is spent. Hand the page to the user, and state what you would do next in the words of the last `elevations` you received rather than a vague 'still perfectible' — that is something they can decide about.",
              };
            }

            const render = await renderPage({
              compiled,
              definition: page.definition,
              teamId,
              userId: userId ?? null,
              pageName: page.name,
            });

            // No browser reachable is OUR failure, not the page's — say so
            // plainly rather than reporting a page as unreviewable.
            if (render.degraded !== undefined) {
              return {
                pageId: page.id,
                review: "unavailable",
                reason: render.degraded,
                // Sending the reader to design.md would be wrong for either
                // caller: the builder already carries it verbatim, and the
                // parent cannot act on it — it has no way to author a fix.
                next: "Nobody can look at this page from here. Self-critique against the doctrine you already have, and say plainly that the page was not visually verified.",
              };
            }

            const gate = gatePageRender(
              render,
              page.definition.datasets.length,
            );
            // A page that never mounted was not judged, so the attempt
            // consumes no round: this is a crash-fix loop, not a review.
            if (!render.mounted) {
              return {
                pageId: page.id,
                url: `/pages/${page.id}`,
                gate: "fail",
                verdict: "unverified",
                ...(gate.blocking.length > 0
                  ? { blocking: gate.blocking }
                  : {}),
                next: "The page never mounted, so no review round was spent. Read its runtime errors with { action: 'get' }, fix the crash, and review again — nothing else about it can be judged until it renders.",
              };
            }

            const critique = await evaluatePageDesign({
              pageName: page.name,
              brief: page.definition.brief,
              shots: render.shots,
              interactions: render.interactions,
              known: gate.blocking,
            });
            // Same rule as the crash: a critic that failed (even after its
            // own retries) judged nothing, so the round is not consumed — on
            // 2026-08-23 a single upstream rate limit silently ate one of a
            // build's three rounds.
            if (!critique.ok) {
              return {
                pageId: page.id,
                url: `/pages/${page.id}`,
                gate: gate.pass ? "pass" : "fail",
                verdict: "unverified",
                ...(gate.blocking.length > 0
                  ? { blocking: gate.blocking }
                  : {}),
                ...(gate.observations.length > 0
                  ? { observed: gate.observations }
                  : {}),
                critiqueUnavailable: critique.reason,
                next: "The critic was unavailable — this attempt did not consume a review round. Fix any `blocking` lines with update { edits }, then review again.",
              };
            }

            const iteration = await bumpPageReviewIteration(turnScope, page.id);

            const verdict =
              gate.pass && critique.critique.score >= SHIP_SCORE
                ? "ship"
                : "revise";

            const elevations = critique.critique.elevations;
            const roundsLeft = MAX_PAGE_REVIEW_ITERATIONS - iteration;

            /**
             * Checkpoint what was just judged, so a round that scored well can
             * be returned to. Refinement is not monotonic — revisions regress,
             * and keeping only the last state discards the best one by
             * construction.
             */
            const checkpoint = await writePageVersion(db, {
              pageId: page.id,
              teamId,
              name: page.name,
              operation: "review-round",
              definition: page.definition,
              actor: {
                actor: "agent",
                userId: userId ?? null,
                conversationId: ctx.conversationId ?? null,
              },
              meta: { round: iteration, score: critique.critique.score },
            });
            await recordPageReviewRound(turnScope, page.id, {
              round: iteration,
              versionNumber: checkpoint.versionNumber,
              score: critique.critique.score,
              gatePass: gate.pass,
            });

            // On the LAST round only: if an earlier round was clearly better
            // and passed its gate, put the page back into it. "Clearly" is a
            // margin, not a tie-break — the critic's own run-to-run variance
            // is a few tenths, and swapping the page over noise would be its
            // own kind of damage.
            let restoredFrom: number | undefined;
            const isLastRound = roundsLeft <= 0 || verdict === "ship";
            if (isLastRound) {
              const rounds = await listPageReviewRounds(turnScope, page.id);
              const best = bestEarlierRound(rounds, {
                round: iteration,
                score: critique.critique.score,
              });
              if (best) {
                await restorePageVersion({
                  pageId: page.id,
                  teamId,
                  versionNumber: best.versionNumber,
                  actingUserId: userId ?? "",
                  requester,
                  actor: {
                    actor: "agent",
                    userId: userId ?? null,
                    conversationId: ctx.conversationId ?? null,
                  },
                });
                restoredFrom = best.round;
              }
            }

            const next =
              restoredFrom !== undefined
                ? // Said first and said plainly: the source on the server is no
                  // longer the one this agent last wrote, so any edit anchored
                  // on its own memory would miss — or, worse, match the wrong
                  // place.
                  `Round ${restoredFrom.toString()} scored higher than this one, so the page was RESTORED to that version. Its source is no longer what you last sent: call { action: "get" } before any further edit. Hand back the url and stop here.`
                : !gate.pass
                  ? roundsLeft <= 0
                    ? "This was the last round. Apply what you can of `blocking` with update { edits }, then hand the page over naming what you did not get to — the review will not score another pass."
                    : "Fix every line of `blocking` first: those are measured, not opinions. Use update { edits } for each one, then review again."
                  : verdict === "ship"
                    ? // Ship ends the loop, full stop. The polish round this
                      // branch used to invite spent ~200s and a page-scale
                      // write chasing tenths inside the critic's own variance
                      // (measured ≥1.0 on identical bytes, 2026-08-23) — the
                      // elevations are the user's decision now, not a round.
                      "Nothing blocks this page: it ships as it stands. Hand back its url and pass on any `elevations` as what you would do next. Do NOT edit or review again — the verdict is final for this version."
                    : roundsLeft <= 0
                      ? // The last round still has findings. Inviting a
                        // fourth review — which the next call refuses to
                        // score — sends the builder to spend its remaining
                        // steps on a door that is already shut.
                        "This was the last round. Apply what you can with update { edits }, then hand the page over naming the findings you did not get to — the review will not score another pass."
                      : `Apply the findings with update { edits } — one edit per finding, not a rewrite — then review again (${(iteration + 1).toString()} of ${MAX_PAGE_REVIEW_ITERATIONS.toString()}).`;

            const result = {
              pageId: page.id,
              url: `/pages/${page.id}`,
              iteration: `${iteration.toString()}/${MAX_PAGE_REVIEW_ITERATIONS.toString()}`,
              gate: gate.pass ? ("pass" as const) : ("fail" as const),
              verdict,
              ...(restoredFrom !== undefined
                ? { restoredFromRound: restoredFrom }
                : {}),
              ...(gate.blocking.length > 0 ? { blocking: gate.blocking } : {}),
              ...(gate.observations.length > 0
                ? { observed: gate.observations }
                : {}),
              score: critique.critique.score,
              scores: critique.critique.scores,
              summary: critique.critique.summary,
              ...(critique.critique.findings.length > 0
                ? { findings: critique.critique.findings }
                : {}),
              ...(elevations.length > 0 ? { elevations } : {}),
            };

            // Pin the verdict to the bytes it judged — after a restore those
            // are the restored version's, so re-read rather than assume.
            const judgedSource =
              restoredFrom !== undefined
                ? (await getPage({ pageId: page.id, teamId, requester }))
                    .definition.code.source
                : page.definition.code.source;
            await recordPageReviewVerdict(turnScope, page.id, {
              sourceHash: hashPageSource(judgedSource),
              shipped: verdict === "ship" || restoredFrom !== undefined,
              round: iteration,
              result,
            });

            return { ...result, next };
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
