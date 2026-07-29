import db from "@fretik/shared/db";
import { aiChatFiles } from "@fretik/shared/db/schema";
import { getProvider } from "@fretik/shared/external-apps/registry";
import { renderSnapshot } from "@fretik/shared/lib/chat-file-snapshot";
import { signSandboxJwt } from "@fretik/shared/lib/external-apps/sandbox-jwt";
import { listConnections } from "@fretik/shared/services/external-apps/connections/list";
import { isMcpConnection } from "@fretik/shared/services/external-apps/mcp/connection-kind";
import { describeTeamSchema } from "@fretik/shared/services/object-types/describe-team-schema";
import { listEnabledSkillsForTeam } from "@fretik/shared/services/skills/list-enabled-for-team";
import { and, eq, inArray, ne } from "drizzle-orm";
import { writeSandboxAuthFile } from "../../lib/conversation-storage";
import { withSoftTimeout } from "../../lib/stream-errors";
import { buildChatbotContextManifest } from "../../services/chatbot-context/build-manifest";
import { formatTeamObjectsBlock } from "../chatbot/team-objects-block";
import type { ExternalAppConnectionLite } from "./runtime-context";

/**
 * Per-turn system-prompt fragment assembly shared by BOTH agent handlers
 * (chatbot + workflow). Extracted verbatim from `handlers/chatbot.ts` —
 * same soft-timeouts, same soft-fail semantics (a failing source never
 * blocks a turn), same log lines modulo the prefix. History-dependent
 * fragments (attached-files needs the message's filenames; recall needs the
 * conversation tail) take their inputs explicitly so each handler feeds its
 * own shape.
 */

export interface FragmentScope {
  organizationId: string;
  teamId: string;
  userId?: string;
  logPrefix: string;
}

export interface ContextFragments {
  chatbotContextManifest?: string;
  teamObjectsBlock?: string;
  enabledSkillsBlock?: string;
}

/**
 * The three purely scope-based fragments (persistent-context manifest, team
 * objects catalogue, enabled skills), built in parallel behind the same
 * soft-timeouts as the historical chatbot inline version. `undefined`
 * fields render as their prompt placeholders.
 */
export const assembleContextFragments = async (
  scope: FragmentScope,
): Promise<ContextFragments> => {
  const [chatbotContextManifest, teamObjectsBlock, enabledSkillsBlock] =
    await Promise.all([
      withSoftTimeout(
        buildChatbotContextManifest({
          userId: scope.userId,
          teamId: scope.teamId,
          organizationId: scope.organizationId,
        }).catch((error: unknown) => {
          // Never let a missing/corrupt manifest block a turn.
          console.warn(
            `${scope.logPrefix} buildChatbotContextManifest failed, continuing without persistent context:`,
            error,
          );
          return {
            manifest: "",
            totalChars: 0,
            fileCount: 0,
            inlinedFileCount: 0,
          };
        }),
        4000,
        { manifest: "", totalChars: 0, fileCount: 0, inlinedFileCount: 0 },
        "context-manifest",
      ),
      // Compact `- key (type)` catalogue for the dynamic suffix.
      // Redis-cached (30 min TTL) so the per-turn cost is one HGET.
      withSoftTimeout(
        describeTeamSchema({
          organizationId: scope.organizationId,
          teamId: scope.teamId,
        })
          .then((types) => formatTeamObjectsBlock(types))
          .catch((error: unknown) => {
            console.warn(
              `${scope.logPrefix} describeTeamSchema failed, continuing without team objects:`,
              error instanceof Error ? error.message : error,
            );
            return "";
          }),
        3000,
        "",
        "team-objects",
      ),
      // Team-filtered L1 skills listing — disabled skills never reach the
      // prompt (the agent has no path to invoke them).
      withSoftTimeout(
        listEnabledSkillsForTeam(scope.teamId)
          .then((skills) =>
            skills
              .map((skill) => `- **${skill.name}** — ${skill.description}`)
              .join("\n"),
          )
          .catch((error: unknown) => {
            console.warn(
              `${scope.logPrefix} listEnabledSkillsForTeam failed, continuing without skills catalogue:`,
              error instanceof Error ? error.message : error,
            );
            return "";
          }),
        3000,
        "",
        "enabled-skills",
      ),
    ]);

  return {
    chatbotContextManifest:
      chatbotContextManifest.manifest.length > 0
        ? chatbotContextManifest.manifest
        : undefined,
    teamObjectsBlock:
      teamObjectsBlock.length > 0 ? teamObjectsBlock : undefined,
    enabledSkillsBlock:
      enabledSkillsBlock.length > 0 ? enabledSkillsBlock : undefined,
  };
};

/**
 * Per-turn external-app setup — moved verbatim from `handlers/chatbot.ts`.
 * Two things happen, both soft-failing so a failure never blocks the turn:
 *
 *  (1) Load the active external-app connections the caller can see —
 *      surfaced via the `{{externalAppsBlock}}` prompt line + runtime ctx.
 *  (2) Mint a fresh sandbox JWT (HS256, 1 h TTL) and write it to
 *      `/workspace/.fretik/auth.json` so `fretik_apps` calls authenticate
 *      this turn. Skipped when `SANDBOX_JWT_SECRET` is unset.
 *
 * No-op (returns empty) without a conversationId / userId.
 */
export const loadExternalApps = async (params: {
  conversationId: string | undefined;
  organizationId: string;
  teamId: string;
  userId: string | undefined;
  turnId: string | undefined;
  logPrefix: string;
}): Promise<{
  externalAppConnections: ExternalAppConnectionLite[] | undefined;
  externalAppsBlock: string | undefined;
}> => {
  let externalAppConnections: ExternalAppConnectionLite[] | undefined;
  let externalAppsBlock: string | undefined;
  if (params.conversationId !== undefined && params.userId !== undefined) {
    try {
      const rows = await listConnections(params.teamId, params.userId);
      const active = rows.filter((r) => r.status === "active");
      externalAppConnections = active.map((r) => {
        const provider = getProvider(r.providerKey);
        // MCP connections have no manifest provider — take their categories from
        // the persisted discovery metadata (`catalogMeta`) when present; a
        // custom server has none and its SKILL carries the detail.
        return {
          id: r.id,
          providerKey: r.providerKey,
          displayName: r.displayName,
          scope: r.userId === null ? ("team" as const) : ("user" as const),
          categories:
            provider?.manifest.categories ?? r.catalogMeta?.categories ?? [],
          options: r.options,
        };
      });
      externalAppsBlock =
        active.length === 0
          ? undefined
          : active
              .map((r) => {
                // An MCP connection whose snapshot hasn't been introspected has
                // NO stub/SKILL in the sandbox — presenting it as usable makes
                // the agent chase a tool that isn't there. Flag it instead, so
                // the agent tells the user rather than failing silently.
                if (isMcpConnection(r) && r.toolFingerprint === null) {
                  const reason =
                    r.lastErrorMessage !== null
                      ? `failed to load (${r.lastErrorMessage})`
                      : "still loading — retry later";
                  return `- ${r.providerKey} (display_name: "${r.displayName}", id: ${r.id}) — UNAVAILABLE this turn: its tools ${reason}. Do NOT use it; tell the user it is still setting up${r.lastErrorMessage !== null ? " (or failed and may need reconnecting)" : ""}.`;
                }

                // Surface only the options the provider opted to expose to
                // the agent (e.g. `persona` on communication providers).
                // Other options stay server-side.
                const provider = getProvider(r.providerKey);
                const categories =
                  provider?.manifest.categories ??
                  r.catalogMeta?.categories ??
                  [];
                const formatOptionValue = (v: unknown): string | null => {
                  if (v === undefined || v === null) return null;
                  if (
                    typeof v === "string" ||
                    typeof v === "number" ||
                    typeof v === "boolean"
                  ) {
                    return String(v);
                  }
                  // Complex shapes (object / array) — drop from the system
                  // prompt rather than spilling JSON the agent doesn't need.
                  return null;
                };
                const exposed =
                  provider?.manifest.connectionOptions?.fields
                    .filter((f) => f.exposeToAgent)
                    .map((f) => {
                      const formatted = formatOptionValue(r.options?.[f.key]);
                      return formatted === null
                        ? null
                        : `${f.key}: ${formatted}`;
                    })
                    .filter((s): s is string => s !== null) ?? [];
                // The manifest description is the "what is this app + when to
                // use it" signal at decision time — load-bearing for apps the
                // base model doesn't know (industry / template providers),
                // cheap-but-redundant for well-known ones.
                const description = provider?.manifest.description;
                const parts = [
                  `display_name: "${r.displayName}"`,
                  ...(description !== undefined
                    ? [`description: "${description}"`]
                    : []),
                  `id: ${r.id}`,
                  `categories: [${categories.join(", ")}]`,
                  ...exposed,
                ];
                return `- ${r.providerKey} (${parts.join(", ")})`;
              })
              .join("\n");
    } catch (error) {
      console.warn(
        `${params.logPrefix} listConnections failed, proceeding without external apps:`,
        error instanceof Error ? error.message : error,
      );
    }

    const sandboxJwtSecret = Bun.env.SANDBOX_JWT_SECRET;
    const backendUrl = Bun.env.FRETIK_BACKEND_INTERNAL_URL;
    if (
      sandboxJwtSecret !== undefined &&
      sandboxJwtSecret !== "" &&
      backendUrl !== undefined &&
      backendUrl !== ""
    ) {
      try {
        const jwt = await signSandboxJwt({
          conversationId: params.conversationId,
          teamId: params.teamId,
          userId: params.userId,
          organizationId: params.organizationId,
          turnId: params.turnId ?? params.conversationId,
        });
        await writeSandboxAuthFile(params.conversationId, {
          jwt,
          backendUrl,
          turnId: params.turnId ?? params.conversationId,
        });
      } catch (error) {
        console.warn(
          `${params.logPrefix} writeSandboxAuthFile failed — fretik_apps calls will fail until next turn:`,
          error instanceof Error ? error.message : error,
        );
      }
    } else if (externalAppConnections && externalAppConnections.length > 0) {
      console.warn(
        `${params.logPrefix} external-app connections exist but SANDBOX_JWT_SECRET/FRETIK_BACKEND_INTERNAL_URL is missing — fretik_apps calls will fail`,
      );
    }
  }
  return { externalAppConnections, externalAppsBlock };
};

/**
 * Fallback when the attachment listing times out. An empty string renders as
 * "no files attached", which the agent reads as fact and reports to the user —
 * so a slow DB must say "unknown", never "none".
 */
export const ATTACHED_FILES_UNAVAILABLE =
  "_The attachment list could not be loaded for this turn. Files may still be present — check with `bash: ls attachments` before telling the user there are none._";

/**
 * Build the `{{attachedFilesBlock}}` fragment — moved verbatim from
 * `handlers/chatbot.ts`. JOINs the filenames against `ai_chat_files` so
 * every entry carries the authoritative metadata (MIME type, size, sidecar
 * availability). Empty string when nothing is attached.
 */
export const buildAttachedFilesBlock = async (
  conversationId: string | undefined,
  filenames: string[],
): Promise<string> => {
  if (!conversationId || filenames.length === 0) return "";

  const rows = await db
    .select({
      filename: aiChatFiles.filename,
      mimeType: aiChatFiles.mimeType,
      size: aiChatFiles.size,
      hasMarkdown: aiChatFiles.hasMarkdown,
      status: aiChatFiles.status,
      snapshot: aiChatFiles.snapshot,
    })
    .from(aiChatFiles)
    .where(
      and(
        eq(aiChatFiles.conversationId, conversationId),
        inArray(aiChatFiles.filename, filenames),
      ),
    );

  if (rows.length === 0) return "";

  const byFilename = new Map(rows.map((r) => [r.filename, r]));
  const blocks: string[] = [];
  for (const filename of filenames) {
    const row = byFilename.get(filename);
    if (!row) continue;
    const sizeKb = (row.size / 1024).toFixed(1);
    // The filename is the on-disk basename (sanitized at upload time — see
    // services/chat-files/upload.ts). Every attachment lives at
    // `/workspace/attachments/{filename}` inside the sandbox. Emit a
    // workspace-relative path the agent can copy-paste verbatim.
    const relativePath = `attachments/${filename}`;

    // <attached_file> XML-style block per file. Pattern verbatim from
    // Claude.ai's `<notes_on_user_uploaded_files>` (model is trained on
    // this delimiter). Snapshot inside is a net-new affordance sized to our
    // tool surface — see `lib/chat-file-snapshot.ts`.
    const headerLine = `<attached_file path="${relativePath}" mime="${row.mimeType}" size_kb="${sizeKb}" status="${row.status}">`;
    const body: string[] = [headerLine];
    if (row.snapshot) {
      body.push(renderSnapshot(row.snapshot));
    }
    // `extract` reads PDFs and images natively; DOCX/PPTX are text, so they
    // keep the read-first line. Naming `extract` HERE is load-bearing: this
    // is the most file-adjacent instruction the model gets, and while it
    // listed only read/vision/python the model routed document data through
    // an ad-hoc python parser even with the hint in its playbook.
    const extractsNatively =
      row.mimeType === "application/pdf" || row.mimeType.startsWith("image/");
    if (row.hasMarkdown) {
      const extractLead = extractsNatively
        ? `\`extract\` for structured data (line items, table rows, named fields). `
        : "";
      body.push(
        `${extractLead}\`read({ file_path: '${relativePath}' })\` returns its text; figure refs in it are vision-targetable. For layout / signature questions use \`vision\`; to modify the file use \`python\` on '${relativePath}'.`,
      );
    } else if (row.mimeType.startsWith("image/")) {
      body.push(
        `\`extract\` for structured data. Call \`vision({ file_path: '${relativePath}', question: '...' })\` for visual questions (\`read\` has no text for this image).`,
      );
    } else if (
      row.mimeType.includes("spreadsheet") ||
      row.mimeType.includes("excel")
    ) {
      body.push(
        `Spreadsheet — open in \`python\` with \`pandas.read_excel('${relativePath}')\` / \`openpyxl\`.`,
      );
    } else {
      body.push(
        `\`read({ file_path: '${relativePath}' })\` for the full content.`,
      );
    }
    body.push(`</attached_file>`);
    blocks.push(body.join("\n"));
  }
  return blocks.join("\n\n");
};

/**
 * Conversation-scoped `{{attachedFilesBlock}}` — used by BOTH agents.
 *
 * Workflow runs need it because their files never rode a user message (a
 * form/email trigger's uploads go straight onto the run's conversation via
 * `attachRunFiles`). Chat needs it because a file part survives in the
 * history only while the active profile ingests it natively AND it stays
 * inside the recency cap — `prepareModelMessages` drops the rest silently.
 * Scoped to the last user message, this block made every earlier attachment
 * disappear on the next turn, so the agent concluded it had no files while
 * they sat readable in `attachments/`.
 *
 * Enumerates every non-error attachment on the conversation, then renders
 * them through `buildAttachedFilesBlock`.
 */
export const buildConversationAttachedFilesBlock = async (
  conversationId: string | undefined,
): Promise<string> => {
  if (!conversationId) return "";
  const rows = await listConversationFiles(conversationId);
  return buildAttachedFilesBlock(
    conversationId,
    rows.map((r) => r.filename),
  );
};

/**
 * Every readable attachment of a conversation, oldest first. Backs the block
 * above, and lets the workflow handler turn a run's input files into real
 * message parts (a run's files never rode a user message).
 */
export const listConversationFiles = async (
  conversationId: string,
): Promise<{ filename: string; mimeType: string }[]> =>
  db
    .select({
      filename: aiChatFiles.filename,
      mimeType: aiChatFiles.mimeType,
    })
    .from(aiChatFiles)
    .where(
      and(
        eq(aiChatFiles.conversationId, conversationId),
        ne(aiChatFiles.status, "error"),
      ),
    )
    // Upload order, so the listing reads as a timeline the agent can map onto
    // the conversation ("the file from my first message").
    .orderBy(aiChatFiles.createdAt);
