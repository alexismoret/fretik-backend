import {
  OBJECT_COLOR_TOKENS,
  isValidObjectColor,
} from "@fretik/shared/lib/colors/object-colors";
import { isValidIcon } from "@fretik/shared/lib/icons/search";
import { parseApiError } from "@fretik/shared/schemas/errors";
import {
  EMPTY_PAGE_DEFINITION,
  PAGE_LIMITS,
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
  TOOL_ERROR_CODES,
  toolError,
  type ToolErrorOutput,
} from "../lib/tool-error-codes";
import {
  MAX_COMPONENT_DOCS,
  listComponentNames,
  readComponentDocs,
} from "./page-component-docs";

/** A `list` entry states what the page shows, not its whole document. */
const LISTING_DESCRIPTION_CHARS = 200;
const truncateForListing = (text: string): string =>
  text.length > LISTING_DESCRIPTION_CHARS
    ? `${text.slice(0, LISTING_DESCRIPTION_CHARS).trimEnd()}…`
    : text;

/** Warnings surfaced per call — past this the list stops teaching anything. */
const MAX_WARNINGS_RETURNED = 25;
/** Polish is taste. Past a handful it stops being actionable in the turn. */
const MAX_POLISH_RETURNED = 10;
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

const mergePolish = (...lists: string[][]): string[] =>
  [...new Set(lists.flat())].slice(0, MAX_POLISH_RETURNED);

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
    .describe("The COMPLETE Vue SFC — never a fragment."),
});
type DefinitionSections = z.infer<typeof definitionSectionsSchema>;

/** Assemble a stored definition from sections + a base (the stored page on
 * update, the empty page on create). */
const assembleDefinition = (
  base: PageDefinition,
  sections: DefinitionSections | undefined,
): PageDefinition => ({
  version: 3,
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
  `The page is open and its datasets resolve, but it has no code yet — nothing renders. Send the complete SFC with update { pageId: "${pageId}", definition: { code: { source } } }, then hand back the url.`;

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
  if (color === undefined || isValidObjectColor(color)) {
    return { color, warnings: [] };
  }
  return {
    color: undefined,
    warnings: [
      `Ignored unknown color '${color}' — kept the default. Valid tokens: ${OBJECT_COLOR_TOKENS.join(", ")}.`,
    ],
  };
};

type PageScope = "team" | "private";
const scopeOf = (userId: string | null): PageScope =>
  userId ? "private" : "team";

/** What the agent reads back of a page — `compiled` is stripped (build output
 * is noise; `source` is the document), the error feed's tail is attached. */
const agentPageView = (page: PageResponse) => ({
  pageId: page.id,
  name: page.name,
  description: page.description,
  scope: scopeOf(page.userId),
  url: `/pages/${page.id}`,
  publicUrl: page.publicUrl,
  definition: {
    variables: page.definition.variables,
    datasets: page.definition.datasets,
    operations: page.definition.operations,
    ...(page.definition.theme ? { theme: page.definition.theme } : {}),
    code: { source: page.definition.code.source },
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
 * The page runtime's environment contract — what the code may import, what the
 * bridge offers, what the sandbox forbids. Served by `get_guide` together with
 * the data contract, on demand, never in the cached system prompt. Vue, Nuxt
 * UI, Tailwind and Chart.js themselves are NOT documented: the model knows
 * them; only what is SPECIFIC to this runtime is.
 */
const PAGE_ENVIRONMENT_GUIDE = [
  "## the page",
  'A page is ONE complete Vue SFC: `<template>` + `<script setup lang="ts">` (+ optional `<style scoped>`, plain CSS). The server compiles it on save — a compile error refuses the write and names the lines. It renders inside a sandboxed iframe styled with the app\'s design system.',
  "",
  "## imports",
  "Exactly these, nothing else (the compiler refuses others by name): `vue`, `@nuxt/ui`, `chart.js` (or `chart.js/auto`, pre-registered), `#fretik/sdk`, `@vueuse/core` (curated — scroll/virtualise/measure/debounce; storage, fetch and clipboard composables are absent, they cannot work here), `@internationalized/date` (the value type `UCalendar`/`UInputDate`/`UInputTime` take — never a `Date`), and drag-and-drop: `@atlaskit/pragmatic-drag-and-drop/element/adapter`, `/combine`, `/reorder`, `@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge`. One file — no relative imports.",
  "",
  "## components & styling",
  "Every Nuxt UI component is registered globally — use `<UButton>`, `<UTable>`, `<UModal>`, `<UCard>`… without importing. `useToast()`/`useOverlay()` come from `@nuxt/ui`. The app's UApp wrapper is already mounted (toasts, tooltips, overlays work).",
  'Tailwind classes compile from your STATIC class strings — never build a class name at runtime (`:class="`bg-${x}-500`"` yields nothing; toggle between full literal strings instead). App tokens are live: `text-muted`, `text-dimmed`, `text-highlighted`, `bg-default`, `bg-elevated`, `bg-accented`, `border-default`, `primary`/`error`/`success` scales, `dark:` variants, `font-display` (headings), `font-mono`. Icons: `<UIcon name="i-lucide-inbox" />` — the `i-lucide-*` set only.',
  "",
  "## the bridge — `import { fretik } from '#fretik/sdk'`",
  "`await fretik.data.query({ variables?, datasetIds?, queries?, fresh? })` → `{ datasets: { <id>: result } }`. A result is `{ status: 'ok', rows, totalCount?, fields?, page?, pageSize? }` or `{ status: 'forbidden' | 'needs_connection' | 'error' }` — render every status, not just ok. `queries` pages/sorts a records dataset server-side: `{ orders: { page: 2, pageSize: 25, sortBy: 'date', sortDir: 'desc' } }`.",
  "`await fretik.ops.run('<operationId>', { variables? })` → verdict `{ status: 'ok' | 'needs_connection' | 'blocked' | 'cancelled' | 'error', message? }`. The PARENT app shows the confirmation for destructive operations — render the verdict (toast the outcome), never re-confirm.",
  "`fretik.ui.openUrl(url)` / `fretik.ui.copy(text)` — plain `<a href>` clicks are routed through the parent automatically.",
  "`fretik.theme.color('blue' | 'blue-600' | 'primary' | '--any-var')` → the CONCRETE colour. Required for anything drawn on a canvas (Chart.js): canvas cannot resolve `var(--…)`, drops it silently and paints black. CSS `:style` bindings need no such thing.",
  "`fretik.context` — reactive `{ dark, locale, mode }`. Colors/dark-mode are synced automatically; read it only when the CODE must branch.",
  "",
  "## sandbox rules",
  "No `fetch`/XHR/WebSocket (CSP blocks all network — data comes from `fretik.data.query` only). No `localStorage`/`sessionStorage` (opaque origin — they throw; keep state in refs). No `window.open` (use `fretik.ui.openUrl`). External images over https are allowed in `<img>`.",
  "",
  "## shape of a page",
  'Load in `onMounted` (one `fretik.data.query()` for everything, then targeted `datasetIds` refetches) and keep rows in refs. HOW the page should then look and behave — layout, component choice, formatting through `fields`, chart wiring, the four dataset states — is `skills/building-pages/`, and `{ action: "components" }` here gives you the real API of any component before you use it.',
].join("\n");

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
 */
export const createManagePageTool = () =>
  tool({
    description: [
      "Build and manage pages — live dashboards, directories and mini-apps the team opens in the app, written as real Vue code over the team's data. A page stores CODE plus a data contract, not a snapshot: datasets re-query on every view, so the numbers are never stale. Deciding WHETHER a page is the right feature (vs a workflow, an object type, or a one-off file) is `skills/platform-guide/SKILL.md` territory. Read `skills/building-pages/SKILL.md` BEFORE writing one — design doctrine and worked patterns live there, not here.",
      "",
      "- get_guide: the runtime contract (allowed imports, the fretik bridge API, sandbox rules, styling tokens) + the dataset/variable/operation grammar. Read it before your FIRST page in a conversation.",
      "- components: the real Nuxt UI API — every prop, slot and variant — for up to 6 components at a time, generated from the library's own docs. Ask for the ones your page will actually use, before writing the template: guessed props are silently dropped and a component that is not registered renders as nothing. The skill says WHICH component fits; this says what it accepts.",
      "- dry_run: execute a definition WITHOUT saving — runs the datasets, compiles the code. Returns per-dataset samples (row count, real field names, one real row, distinct groups): every question you would otherwise pay a querySql round trip for. A definition without `code` is a pure DATA probe.",
      "- create: name + definition { variables?, datasets?, operations?, theme?, code? } (+ icon, color, description, scope team|private). The tool stamps the version and fills defaults. Omit `code` to open a data-first draft, then write it via update.",
      "- update: pageId + any field. `definition` sections REPLACE whole; omitted sections keep their stored value (sending only `{ code: { source } }` rewrites the code and touches nothing else). For small code changes send `edits`: [{ oldString, newString, replaceAll? }] — exact-match-once against the stored source, then recompiled. `get` first when unsure of the current source.",
      "- get / list: one page's full source + data contract (+ its recent runtime errors — fix those when present) / the team's pages.",
      "- publish / unpublish: mint or revoke a public URL anyone can open without an account. publish FREEZES the current page for that URL while the DATA stays live. It exposes everything the owning team can see, so get the user's explicit agreement first, and hand back the returned publicUrl. A page that reads or writes a connected app is refused — an anonymous visitor cannot spend the team's credentials.",
      "",
      "dry_run, create and update all EXECUTE the datasets and COMPILE the code. `warnings` is broken — a compile error, a wrong field key, a dataset with no rows; fix it in the same turn rather than reporting a page you have not seen work. `polish` reads as unfinished; treat it as the difference between a page that works and a page someone is glad to open. After a user has the page open, `get` returns its recent RUNTIME errors — what the browser saw; fix and update.",
      "",
      "Call describeObjectType for field keys, types and option values BEFORE writing an objects dataset; guessing keys is the main way a page comes back empty.",
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum([
        "get_guide",
        "components",
        "dry_run",
        "create",
        "get",
        "list",
        "update",
        "publish",
        "unpublish",
      ]),
      pageId: z.uuid().optional(),
      name: z.string().max(120).optional(),
      description: z.string().max(4000).optional(),
      icon: z.string().max(60).optional(),
      // A NARROWER palette than Tailwind's hues: the hub swatch tokens only.
      color: z
        .string()
        .max(20)
        .optional()
        .describe(`Hub swatch — one of: ${OBJECT_COLOR_TOKENS.join(", ")}.`),
      scope: z.enum(["team", "private"]).optional(),
      components: z
        .array(z.string().max(40))
        .max(MAX_COMPONENT_DOCS)
        .optional()
        .describe(
          `components only: up to ${MAX_COMPONENT_DOCS} component names — ["UTable", "UBadge", "USlideover"].`,
        ),
      definition: jsonTolerant(definitionSectionsSchema)
        .optional()
        .describe(
          "Sections of the page. On update, a section you send replaces the stored one whole; sections you omit are kept — code included.",
        ),
      edits: jsonTolerant(PageCodeEditsSchema)
        .optional()
        .describe(
          "update only: targeted source edits, applied in order — [{ oldString, newString, replaceAll? }]. oldString must match the stored source exactly once (widen it, or set replaceAll). Cheaper than resending the whole SFC for small changes; ignored when `definition` is sent too.",
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

      try {
        switch (input.action) {
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
            const result = await readComponentDocs(input.components);
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
            return {
              docs: result.docs,
              ...(result.unknown.length > 0
                ? {
                    unknown: result.unknown,
                    hint: "Those are not registered in the page runtime — do not use them in a template; they render as unknown elements.",
                  }
                : {}),
            };
          }

          case "dry_run": {
            if (!input.definition) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "dry_run needs a definition.",
                "Send { action: 'dry_run', definition: { datasets, code? } }.",
              );
            }
            const definition = assembleDefinition(
              EMPTY_PAGE_DEFINITION,
              input.definition,
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
              polish: run.polish.slice(0, MAX_POLISH_RETURNED),
            };
          }

          case "create": {
            if (!input.name) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "create needs a name.",
                "Send { action: 'create', name, definition }.",
              );
            }
            const icon = sanitizeIcon(input.icon);
            const color = sanitizeColor(input.color);
            const definition = assembleDefinition(
              EMPTY_PAGE_DEFINITION,
              input.definition,
            );
            const drafting = definition.code.source.trim().length === 0;

            const created = await createPage({
              organizationId,
              teamId,
              createdByUserId: userId ?? "",
              input: {
                name: input.name,
                description: input.description ?? "",
                icon: icon.icon,
                color: color.color,
                userId: input.scope === "private" ? (userId ?? null) : null,
                definition,
                ...(ctx.conversationId
                  ? { sourceConversationId: ctx.conversationId }
                  : {}),
              },
            });

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
              warnings: distinctWarnings([
                ...icon.warnings,
                ...color.warnings,
                ...created.warnings,
                ...run.warnings,
              ]).slice(0, MAX_WARNINGS_RETURNED),
              polish: mergePolish(created.polish, run.polish),
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
            return agentPageView(page);
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
            const existing = await getPage({
              pageId: input.pageId,
              teamId,
              requester,
            });

            let sections = input.definition;
            if (!sections && input.edits) {
              const edited = applyPageCodeEdits(
                existing.definition.code.source,
                input.edits,
              );
              if (!edited.ok) {
                return toolError(
                  TOOL_ERROR_CODES.INVALID_ARGS,
                  edited.error,
                  "Call { action: 'get' } to read the current source, then re-anchor the edit.",
                );
              }
              sections = { code: { source: edited.source } };
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
            const updated = await updatePage({
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
            });

            const run = definition
              ? await dryRunPage({
                  definition: updated.page.definition,
                  teamId,
                  userId: userId ?? null,
                  assumeSanitized: true,
                  assumeCompiled: true,
                })
              : { samples: {}, warnings: [], polish: [] };

            return {
              pageId: updated.page.id,
              url: `/pages/${updated.page.id}`,
              ...(definition ? { samples: run.samples } : {}),
              warnings: distinctWarnings([
                ...icon.warnings,
                ...color.warnings,
                ...updated.warnings,
                ...run.warnings,
              ]).slice(0, MAX_WARNINGS_RETURNED),
              polish: mergePolish(updated.polish, run.polish),
              ...(updated.page.definition.code.source.trim().length === 0
                ? { next: DRAFT_NEXT_STEP(updated.page.id) }
                : {}),
            };
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
