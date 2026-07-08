import db from "@fretik/shared/db";
import { aiChatFiles } from "@fretik/shared/db/schema";
import { getProvider } from "@fretik/shared/external-apps/registry";
import { renderSnapshot } from "@fretik/shared/lib/chat-file-snapshot";
import { signSandboxJwt } from "@fretik/shared/lib/external-apps/sandbox-jwt";
import { listConnections } from "@fretik/shared/services/external-apps/connections/list";
import { describeTeamSchema } from "@fretik/shared/services/object-types/describe-team-schema";
import { listEnabledSkillsForTeam } from "@fretik/shared/services/skills/list-enabled-for-team";
import { and, eq, inArray } from "drizzle-orm";
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
        return {
          id: r.id,
          providerKey: r.providerKey,
          displayName: r.displayName,
          scope: r.userId === null ? ("team" as const) : ("user" as const),
          categories: provider?.manifest.categories ?? [],
          options: r.options,
        };
      });
      externalAppsBlock =
        externalAppConnections.length === 0
          ? undefined
          : externalAppConnections
              .map((c) => {
                // Surface only the options the provider opted to expose to
                // the agent (e.g. `persona` on communication providers).
                // Other options stay server-side.
                const provider = getProvider(c.providerKey);
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
                      const formatted = formatOptionValue(c.options?.[f.key]);
                      return formatted === null
                        ? null
                        : `${f.key}: ${formatted}`;
                    })
                    .filter((s): s is string => s !== null) ?? [];
                const parts = [
                  `display_name: "${c.displayName}"`,
                  `id: ${c.id}`,
                  `categories: [${c.categories.join(", ")}]`,
                  ...exposed,
                ];
                return `- ${c.providerKey} (${parts.join(", ")})`;
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
    if (row.hasMarkdown) {
      body.push(
        `\`read({ file_path: '${relativePath}' })\` returns its text. For visual layout / signatures / diagrams use \`vision({ file_path: '${relativePath}', question: '...' })\`.`,
      );
    } else if (row.mimeType.startsWith("image/")) {
      body.push(
        `Call \`vision({ file_path: '${relativePath}', question: '...' })\` for visual questions (\`read\` has no text for this image).`,
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
