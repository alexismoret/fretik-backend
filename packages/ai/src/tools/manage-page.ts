import { pagesCatalogPrompt } from "@fretik/render/catalogs/pages";
import {
  OBJECT_COLOR_TOKENS,
  isValidObjectColor,
} from "@fretik/shared/lib/colors/object-colors";
import { isValidIcon } from "@fretik/shared/lib/icons/search";
import { parseApiError } from "@fretik/shared/schemas/errors";
import {
  EMPTY_PAGE_DEFINITION,
  PageDefinitionPatchSchema,
  PageDraftDefinitionSchema,
  describePageDataContract,
  pageBlankError,
} from "@fretik/shared/schemas/pages";
import { isOrgAdmin } from "@fretik/shared/services/organization/member-role";
import { createPage } from "@fretik/shared/services/pages/create";
import { dryRunPage } from "@fretik/shared/services/pages/dry-run";
import { applyPageDefinitionPatch } from "@fretik/shared/services/pages/patch";
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
  type ToolErrorOutput,
  toolError,
} from "../lib/tool-error-codes";

/** A `list` entry states what the page shows, not its whole tree. */
const LISTING_DESCRIPTION_CHARS = 200;
const truncateForListing = (text: string): string =>
  text.length > LISTING_DESCRIPTION_CHARS
    ? `${text.slice(0, LISTING_DESCRIPTION_CHARS).trimEnd()}…`
    : text;

/** Warnings surfaced per call — past this the list stops teaching anything. */
const MAX_WARNINGS_RETURNED = 25;
/** Polish is taste. Past a handful it stops being actionable in the turn. */
const MAX_POLISH_RETURNED = 10;

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
 * Same merge for the other channel, and it is not symmetry for its own sake:
 * the dry run runs `assumeSanitized` on a write (the stored definition already
 * went through the static pass), so its `polish` holds the DATA findings only.
 * Without the service's half, a write returned an empty list where `dry_run`
 * on the very same definition returned notes.
 */
const mergePolish = (...lists: string[][]): string[] =>
  [...new Set(lists.flat())].slice(0, MAX_POLISH_RETURNED);

/**
 * Accept a nested object that arrived JSON-ENCODED.
 *
 * A page definition is the deepest argument this agent ever sends, and serialising
 * it to a string is the classic weak-model slip — observed on deepseek-v4-flash,
 * whose own next-step reasoning read "je corrige le format (objet au lieu de
 * chaîne)". It cost a discarded step plus a repair-model call to recover
 * something no information was missing from. Same doctrine as `manageRecord`'s
 * tolerant `value` union: widen where the intent is unambiguous rather than
 * spend a turn teaching it.
 *
 * A string that does not parse falls THROUGH unchanged, so the model still gets
 * the schema's own message rather than a JSON-parse error about a field it does
 * not know it sent as text.
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
 * Worked shape for the blank-page rejection — a page is elements, and the
 * failure it answers is a definition that carried datasets and nothing else.
 *
 * Rewriting this to advertise the spec-less two-pass path instead was measured
 * and REVERTED (2026-08-10, byte-faithful replay after a refused blank
 * definition, n=5 per cell): the upstream that cannot emit a nested element map
 * reached the working path 1/5 with either text, and the healthy one was 5/5
 * with either. The hint's wording is inert here — the model that finds the
 * two-pass path finds it from the tool description. Do not spend tokens here
 * again without a measurement.
 */
const BLANK_PAGE_HINT =
  'spec: { root: "root", elements: { "root": { type: "box", children: ["title", "total"] }, "title": { type: "heading", props: { text: "Q3" } }, "total": { type: "stat", props: { label: "Revenue", value: { "$": "data.sales[0].amount" } } } } }';

/**
 * The directive that closes a two-pass build. It has to name the NEXT CALL,
 * not describe the state: a page opened without a spec renders nothing, and a
 * result that only said so is what let a blank page be reported as finished.
 *
 * Measured to be the load-bearing half (2026-08-10, byte-faithful replay): the
 * upstream that cannot emit a nested spec goes from 0/5 to 5/5 once its create
 * result carries this line, while the upstream that never needed it stays 5/5
 * and writes MORE elements (12 vs 10 median).
 */
const DRAFT_NEXT_STEP = (pageId: string): string =>
  `The page is open and its datasets resolve, but it renders nothing yet. Add its elements with update + patch on pageId ${pageId} — one \`add\` op per element under /spec/elements — then dry_run it.`;

/**
 * Translate a thrown `HTTPException` from the page services into the envelope
 * the agent reads. Returns null for anything it does not recognise, and the
 * caller rethrows — `guardToolExecute` stays the backstop for real bugs, and
 * its "unexpected internal error, retry once" message stays reserved for them.
 *
 * The reason this exists: without it EVERY missing page, every publish gate and
 * every scope refusal reached the model as that generic backstop string. The
 * publish gate in particular names the cyclic element, the element count and
 * the depth against their ceilings — the most actionable messages in the whole
 * feature, and they were being discarded a layer below.
 *
 * None of the codes it emits are in `INPUT_SHAPE_CODES`: each of these is fixed
 * by a DIFFERENT call, never by re-sending the same one with a better shape.
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
    // The publish gate is the only 400 on that action; ownership is the only
    // other 400 the services raise. Both messages are written for the agent, so
    // they travel verbatim.
    const publishing = ctx.action === "publish";
    return toolError(
      publishing
        ? TOOL_ERROR_CODES.PAGE_NOT_PUBLISHABLE
        : TOOL_ERROR_CODES.FORBIDDEN,
      parsed?.message ?? "The page rejected this operation.",
      publishing
        ? "Fix the definition first: get the page, correct what the message names with update + patch, then publish again."
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

/**
 * Domain tool (deferred) — the conversational builder for pages: data-bound UI
 * documents the team opens like any other page of the app. The agent authors
 * the definition here; the frontend renders it with no model in the loop, so a
 * page stays live and costs nothing to view.
 *
 * Every write DRY-RUNS the page against real data before returning, and hands
 * the failures back as warnings. That is deliberate: the catalog is wide
 * enough to get wrong, so the correction loop belongs in the turn that wrote
 * it, not in the user's browser.
 *
 * One defect is refused instead: a spec that renders nothing (`pageBlankError`).
 * A warning only works when something was still produced — a saved blank page
 * reports success, so the model reads a URL, believes it built something, and
 * loops. Returning `INVALID_ARGS` also arms the shared loop guard, which steers
 * after two identical failures and ends the turn after eight.
 */
export const createManagePageTool = () =>
  tool({
    description: [
      "Build and manage pages — live dashboards and custom views the team opens in the app, built from their data. A page stores a layout, not a snapshot: it re-queries on every view, so the numbers are never stale and refreshing costs nothing. Deciding WHETHER a page is the right feature (vs a workflow, an object type, or a one-off file) is `skills/platform-guide/SKILL.md` territory. Read `skills/building-pages/SKILL.md` BEFORE writing a definition — layout, binding and chart doctrine live there, not here.",
      "",
      "- get_catalog: every component with its props and events, plus the dataset/state/binding grammar. Read it before your FIRST definition in a conversation.",
      "- dry_run: execute a definition WITHOUT saving it. Use it as your probe: it returns each dataset's row count, its distinct group values, its field types and one real row — every question you would otherwise pay a querySql round trip for.",
      "- create: name + definition (+ icon, color, description, scope team|private, default team). Best-guess icon/color is safe — an off-catalog value is dropped with a warning, never an error.",
      "- update: pageId + any field. To change PART of an existing page, send `patch` — RFC 6902 ops rooted at the definition, so one op reaches an element, a dataset filter or the theme — rather than a whole `definition`, which replaces the previous one and is how an element that was fine disappears. `get` it first when you are unsure of the current keys.",
      "  Building in passes uses the same channel: omit `definition.spec` on create to open the page on its datasets, then add the elements a few ops per call. A page that already exists cannot be lost by a later rewrite.",
      "- list / get: the team's pages (+ your private ones) / one page's full definition.",
      "- publish / unpublish: mint or revoke a public URL anyone can open without an account. publish FREEZES the current definition for that URL (later edits stay internal until you publish again) while the DATA stays live. It exposes everything the owning team can see, so get the user's explicit agreement first, and hand back the returned publicUrl. A page that reads a connected app or writes to one is refused — an anonymous visitor cannot spend the team's credentials.",
      "",
      "dry_run, create and update all EXECUTE the page: they run the datasets and evaluate every binding against the rows that come back. They return two separate lists. `warnings` is broken — a wrong field name, a chart that cannot draw, a dropped prop; fix it in the same turn rather than reporting a page you have not seen resolve. `polish` is not broken but reads as unfinished — an unlabelled metric, a row of KPIs with nothing to compare against; treat it as the difference between a page that works and a page someone is glad to open.",
      "",
      "A definition is { version: 2, variables, datasets, operations, spec, theme? }: `datasets` fetch or compute the data, `operations` write into connected apps, `variables` hold what the viewer changes, and `spec` is { root, elements } — a flat map keyed by element id, where nesting is a parent listing its children's keys. Three references tie them together — an element names a dataset by id, a dataset filter binds to state, a control writes state — and nothing else is wired. Data alone is not a page: a definition whose `spec.root` names no entry in `spec.elements` is refused rather than saved, so write the elements in the same call. Call describeObjectType for field keys, types and option values BEFORE writing an objects dataset; guessing keys is the main way a page comes back empty.",
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum([
        "get_catalog",
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
      // The page's own swatch in the hub, and it is a NARROWER palette than the
      // catalog's `@color` scale: hues only, no semantic token. Undescribed, the
      // agent read `@color` — which it has just been served — and wrote
      // "primary", earning a warning for following the documentation. A false
      // entry in the broken channel is worse than none: the skill's checklist
      // asks for `warnings` empty before handing a page over.
      color: z
        .string()
        .max(20)
        .optional()
        .describe(`Hub swatch — one of: ${OBJECT_COLOR_TOKENS.join(", ")}.`),
      scope: z.enum(["team", "private"]).optional(),
      definition: jsonTolerant(PageDraftDefinitionSchema)
        .optional()
        .describe(
          "The whole page. Replaces the previous definition wholesale on update — send `patch` to change only part of one.",
        ),
      patch: jsonTolerant(PageDefinitionPatchSchema)
        .optional()
        .describe(
          'update only: [{ op, path, value?, from? }], paths rooted at the definition — { op: "replace", path: "/spec/elements/kpi-total/props/label", value: "Revenue" }, { op: "add", path: "/spec/elements/trend", value: { type: "chart_line", props: {} } }, { op: "replace", path: "/datasets/0/filters/0/value", value: "won" }. Ignored when `definition` is sent too.',
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
          // Two halves, one document: `@fretik/render` owns the components (the
          // same catalog the renderer is built from), this package's schema owns
          // the data grammar. Served on demand — it is far too large to sit in
          // the cached system prompt.
          case "get_catalog":
            return {
              catalog: `${pagesCatalogPrompt()}\n${describePageDataContract()}`,
            };

          case "dry_run": {
            if (!input.definition) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "dry_run needs a definition. Pass the tree you are about to save — nothing is written.",
                '{ action: "dry_run", definition: { version: 2, variables: [], datasets: [...], spec: {...} } }',
              );
            }
            // A spec-less dry_run is the DATA probe: the datasets run, the
            // samples come back, and the layout is written against real rows
            // instead of guessed ones. A spec that was SENT and renders nothing
            // is still the mistake it always was.
            const probing = input.definition.spec === undefined;
            const blank = probing
              ? null
              : pageBlankError(
                  input.definition.spec ?? EMPTY_PAGE_DEFINITION.spec,
                );
            if (blank) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                blank,
                BLANK_PAGE_HINT,
              );
            }
            const dryRun = await dryRunPage({
              definition: {
                ...input.definition,
                spec: input.definition.spec ?? EMPTY_PAGE_DEFINITION.spec,
              },
              teamId: teamId,
              userId: userId ?? null,
            });
            return {
              samples: dryRun.samples,
              warnings: distinctWarnings(dryRun.warnings).slice(
                0,
                MAX_WARNINGS_RETURNED,
              ),
              polish: dryRun.polish.slice(0, MAX_POLISH_RETURNED),
            };
          }

          case "list": {
            const pages = await listPages({ teamId: teamId, requester });
            return {
              pages: pages.map((page) => ({
                pageId: page.id,
                name: page.name,
                description: truncateForListing(page.description),
                scope: scopeOf(page.userId),
                elementCount: page.elementCount,
                datasetCount: page.datasetCount,
                publicUrl: page.publicUrl,
              })),
            };
          }

          case "get": {
            if (!input.pageId) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "get needs a pageId.",
                '{ action: "list" } returns every page with its pageId; then { action: "get", pageId: "<id>" }.',
              );
            }
            const page = await getPage({
              pageId: input.pageId,
              teamId: teamId,
              requester,
            });
            return {
              pageId: page.id,
              name: page.name,
              description: page.description,
              icon: page.icon,
              color: page.color,
              scope: scopeOf(page.userId),
              definition: page.definition,
              publicUrl: page.publicUrl,
            };
          }

          case "create": {
            if (!input.name) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "create needs a name — it is what the team sees in the page list.",
                '{ action: "create", name: "Q3 pipeline", definition: {...} }',
              );
            }
            if (!input.definition) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "create needs a definition. Call get_catalog first if you have not already in this conversation.",
                '{ action: "create", name: "...", definition: { version: 2, variables: [], datasets: [...], spec: { root: "page", elements: {...} } } } — or omit `spec` to open the page on its datasets and add the elements by patch.',
              );
            }
            if (!userId) {
              return toolError(
                TOOL_ERROR_CODES.REQUIRES_USER,
                "Creating a page needs an authenticated user and this session has none. Tell the user page building is unavailable here, and continue with the rest of their request.",
              );
            }
            // An OMITTED spec opens the page from its datasets alone — a
            // declared two-pass build. A SUPPLIED spec that renders nothing is a
            // mistake, and still refused: the difference is intent, and it is the
            // difference between a plan and a blank screen reported as success.
            const drafting = input.definition.spec === undefined;
            const spec = input.definition.spec ?? EMPTY_PAGE_DEFINITION.spec;
            const blank = drafting ? null : pageBlankError(spec);
            if (blank) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                blank,
                BLANK_PAGE_HINT,
              );
            }
            const icon = sanitizeIcon(input.icon);
            const color = sanitizeColor(input.color);
            const { page, warnings, polish } = await createPage({
              organizationId: organizationId,
              teamId: teamId,
              createdByUserId: userId,
              input: {
                name: input.name,
                description: input.description ?? "",
                icon: icon.icon,
                color: color.color,
                userId: input.scope === "private" ? userId : null,
                definition: { ...input.definition, spec },
                sourceConversationId: ctx.conversationId ?? undefined,
              },
            });
            const dryRun = await dryRunPage({
              definition: page.definition,
              teamId: teamId,
              userId: userId ?? null,
              // `page.definition` is what the service STORED, i.e. already
              // sanitized — re-running the static pass here only produced a
              // second copy of every structural warning.
              assumeSanitized: true,
            });
            return {
              pageId: page.id,
              name: page.name,
              scope: scopeOf(page.userId),
              url: `/pages/${page.id}`,
              samples: dryRun.samples,
              warnings: distinctWarnings([
                ...icon.warnings,
                ...color.warnings,
                ...warnings,
                ...dryRun.warnings,
              ]).slice(0, MAX_WARNINGS_RETURNED),
              polish: mergePolish(polish, dryRun.polish),
              ...(drafting ? { next: DRAFT_NEXT_STEP(page.id) } : {}),
            };
          }

          case "update": {
            if (!input.pageId) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "update needs a pageId.",
                '{ action: "list" } returns every page with its pageId; then { action: "update", pageId: "<id>", patch: [...] }.',
              );
            }
            if (!userId) {
              return toolError(
                TOOL_ERROR_CODES.REQUIRES_USER,
                "Updating a page needs an authenticated user and this session has none. Tell the user page building is unavailable here, and continue with the rest of their request.",
              );
            }
            const icon = sanitizeIcon(input.icon);
            const color = sanitizeColor(input.color);

            // A spec-less `definition` is the CREATE shape: on update it would
            // silently erase the layout of a page that already renders. The
            // incremental path on an existing page is `patch`, so say that.
            if (input.definition && input.definition.spec === undefined) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "update needs the whole definition including its spec — a definition without one would erase the page's layout.",
                "To change part of the page, send `patch` instead: [{ op, path, value }] rooted at the definition.",
              );
            }
            const sent =
              input.definition?.spec === undefined
                ? undefined
                : { ...input.definition, spec: input.definition.spec };

            // A patch edits the STORED definition, so it is read here and applied
            // before the write. `definition` wins when both are sent: a whole
            // document and a patch against the old one describe two different
            // pages, and guessing which was meant is worse than ignoring one.
            let patched = sent;
            if (!patched && input.patch) {
              const current = await getPage({
                pageId: input.pageId,
                teamId: teamId,
                requester,
              });
              const result = applyPageDefinitionPatch(
                current.definition,
                input.patch,
              );
              if ("error" in result) {
                // The patch ran on a clone and nothing was written, so the two
                // facts that unblock the next call are: the page is unchanged,
                // and the model's picture of it may be stale. Deliberately NOT
                // a corrected op — the intent behind a failed op is unknowable,
                // and a plausible wrong example is worse than a procedure.
                return toolError(
                  TOOL_ERROR_CODES.INVALID_ARGS,
                  result.error,
                  `Nothing was saved. Call { action: "get", pageId: "${input.pageId}" } to re-read the current definition — element keys and array indexes may differ from what you remember — then resend corrected ops. Ops apply in order; the message names the one that failed.`,
                );
              }
              patched = result.definition;
            }

            // Only when this call rewrites the document — a rename must not be
            // blocked by a spec the model is not touching.
            const blank = patched ? pageBlankError(patched.spec) : null;
            if (blank) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                blank,
                BLANK_PAGE_HINT,
              );
            }

            const { page, warnings, polish } = await updatePage({
              pageId: input.pageId,
              teamId: teamId,
              actingUserId: userId,
              requester,
              input: {
                ...(input.name !== undefined ? { name: input.name } : {}),
                ...(input.description !== undefined
                  ? { description: input.description }
                  : {}),
                ...(icon.icon !== undefined ? { icon: icon.icon } : {}),
                ...(color.color !== undefined ? { color: color.color } : {}),
                ...(input.scope !== undefined
                  ? { userId: input.scope === "private" ? userId : null }
                  : {}),
                ...(patched !== undefined ? { definition: patched } : {}),
              },
            });
            const dryRun = await dryRunPage({
              definition: page.definition,
              teamId: teamId,
              userId: userId ?? null,
              // `page.definition` is what the service STORED, i.e. already
              // sanitized — re-running the static pass here only produced a
              // second copy of every structural warning.
              assumeSanitized: true,
            });
            return {
              pageId: page.id,
              name: page.name,
              scope: scopeOf(page.userId),
              url: `/pages/${page.id}`,
              samples: dryRun.samples,
              warnings: distinctWarnings([
                ...icon.warnings,
                ...color.warnings,
                ...warnings,
                ...dryRun.warnings,
              ]).slice(0, MAX_WARNINGS_RETURNED),
              polish: mergePolish(polish, dryRun.polish),
            };
          }

          case "publish": {
            if (!input.pageId) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "publish needs a pageId.",
                '{ action: "list" } returns every page with its pageId; then { action: "publish", pageId: "<id>" }.',
              );
            }
            if (!userId) {
              return toolError(
                TOOL_ERROR_CODES.REQUIRES_USER,
                "Publishing a page needs an authenticated user and this session has none. Tell the user the page cannot be published here; it stays available inside the workspace.",
              );
            }
            const page = await publishPage({
              pageId: input.pageId,
              teamId: teamId,
              publishedByUserId: userId,
              requester,
            });
            return {
              pageId: page.id,
              name: page.name,
              publicUrl: page.publicUrl,
              // Absent APP_URL leaves the token as the only handle; say so rather
              // than reporting a share that the user cannot actually send.
              ...(page.publicUrl
                ? {}
                : {
                    warnings: [
                      "Published, but the public base URL is not configured — no shareable link could be built.",
                    ],
                  }),
            };
          }

          case "unpublish": {
            if (!input.pageId) {
              return toolError(
                TOOL_ERROR_CODES.INVALID_ARGS,
                "unpublish needs a pageId.",
                '{ action: "list" } returns every page with its pageId; then { action: "unpublish", pageId: "<id>" }.',
              );
            }
            const page = await unpublishPage({
              pageId: input.pageId,
              teamId: teamId,
              requester,
            });
            return { pageId: page.id, name: page.name, publicUrl: null };
          }
        }
      } catch (err) {
        const lifted = liftPageError(err, {
          action: input.action,
          pageId: input.pageId,
        });
        if (lifted) return lifted;
        throw err;
      }
    },
  });
