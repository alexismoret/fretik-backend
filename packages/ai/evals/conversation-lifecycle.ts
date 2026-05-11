/**
 * Ephemeral conversation plumbing for the eval harness.
 *
 * Most sandbox-backed tools (bash, python, read, …) need
 * an active `conversationId` in their runtime context — without one
 * they short-circuit to a `NO_CONVERSATION` error. Running evals
 * statelessly therefore turns every sandbox call into a harmless
 * no-op and forces the agent to loop on failed retries, distorting
 * both the tool-routing signal and the latency numbers.
 *
 * To mirror production, every eval case now runs against a fresh
 * `ai_conversations` row. We create it here (bypassing the HTTP layer
 * via the shared DB connection), pass the id through to the chatbot
 * `/internal/invoke` endpoint, and cascade-delete it on cleanup. The
 * orchestrator's session for the same id is destroyed at the same
 * time so the pool recovers its capacity.
 *
 * Cases that declare a `fixtures: [...]` array have those files pushed
 * into the conversation sandbox at `/workspace/attachments/{filename}`
 * via the storage façade (with an S3 mirror so a sandbox recreated
 * after expiry sees them again), registered in `ai_chat_files`, and
 * appended as `file` parts on the seeded user message — mirroring
 * exactly what the production `/chatbot/stream` upload path produces.
 *
 * NO impact on production paths — this module is only imported by
 * `evals/run.ts`.
 */

import db from "@fretik/shared/db";
import {
  aiChatFiles,
  aiConversations,
  aiMessages,
} from "@fretik/shared/db/schema";
import { eq } from "drizzle-orm";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachUserFile,
  WORKSPACE_DIRS,
  WORKSPACE_ROOT,
  writeFile,
} from "../src/lib/conversation-storage";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = resolve(MODULE_DIR, "fixtures");

interface SeededChatFile {
  filename: string;
  mimeType: string;
  size: number;
  hasMarkdown: boolean;
}

/**
 * Lightweight MIME guess — keeps us free from node:mime dependencies.
 * Defaults to `application/octet-stream` so unknown formats still get
 * seeded; the agent receives the literal extension in the filename
 * and can route correctly.
 */
const guessMime = (filename: string): string => {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".xml":
      return "application/xml";
    case ".html":
    case ".htm":
      return "text/html";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    default:
      return "application/octet-stream";
  }
};

/**
 * Push a fixture file (and any sibling OCR sidecar) into the
 * conversation sandbox at `/workspace/attachments/{filename}` via the
 * storage façade. Returns the metadata the caller needs to register
 * the file in `ai_chat_files`.
 *
 * Missing fixtures emit a warning and resolve to `null` — the case
 * then runs with an empty workspace, which is how the suite used to
 * behave before fixtures existed. This keeps the harness usable on
 * fresh checkouts where the operator hasn't yet provisioned the
 * binary files.
 */
const pushFixtureIntoSandbox = async (
  conversationId: string,
  filename: string,
): Promise<SeededChatFile | null> => {
  const src = resolve(FIXTURES_DIR, filename);
  const srcFile = Bun.file(src);
  if (!(await srcFile.exists())) {
    console.warn(
      `[evals] fixture "${filename}" not found at ${src} — case will run without it. See evals/fixtures/README.md.`,
    );
    return null;
  }

  const bytes = new Uint8Array(await srcFile.arrayBuffer());
  await attachUserFile(conversationId, filename, bytes);

  // Optional OCR sidecar. The `read` tool resolves `{stem}.md` when
  // asked for a PDF / DOCX / PPTX / image. Mirror the same naming
  // convention the production chat-file preprocessor uses so the
  // agent's default code path is unchanged.
  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  const sidecarName = `${stem}.md`;
  const sidecarSrc = resolve(FIXTURES_DIR, sidecarName);
  const sidecarFile = Bun.file(sidecarSrc);
  let hasMarkdown = false;
  if (await sidecarFile.exists()) {
    const sidecarBytes = new Uint8Array(await sidecarFile.arrayBuffer());
    await writeFile(
      conversationId,
      `${WORKSPACE_DIRS.attachments}/${sidecarName}`,
      sidecarBytes,
    );
    hasMarkdown = true;
  }

  return {
    filename,
    mimeType: guessMime(filename),
    size: bytes.byteLength,
    hasMarkdown,
  };
};

/**
 * Insert a fresh conversation row scoped to the eval team and persist
 * the user message into `ai_messages` as the first turn's history.
 *
 * The `/internal/invoke` handler IGNORES the `messages` field in its
 * request body whenever a `conversationId` is provided — it loads
 * history straight from `ai_messages` via `loadConversationForAgent`.
 * So our eval harness must seed the conversation with the prompt
 * before invoking, otherwise the model sees an empty history and
 * emits nothing.
 *
 * When `fixtures` is provided, the matching files are pushed into the
 * conversation sandbox at `/workspace/attachments/...` via the
 * storage façade, registered in `ai_chat_files`, and appended as
 * `file` parts on the seeded user message so
 * `buildAttachedFilesBlock` picks them up into the system prompt's
 * `<file_attachments>` section.
 *
 * The title is prefixed with `[eval]` so any orphaned rows are easy
 * to spot in the dashboard. Cascade-delete via the FK on cleanup.
 */
export const createEphemeralConversation = async (args: {
  teamId: string;
  organizationId: string;
  userId?: string;
  label: string;
  prompt: string;
  fixtures?: string[];
}): Promise<string> => {
  const [convRow] = await db
    .insert(aiConversations)
    .values({
      organizationId: args.organizationId,
      teamId: args.teamId,
      userId: args.userId ?? null,
      agentType: "chatbot",
      title: `[eval] ${args.label}`.slice(0, 200),
    })
    .returning({ id: aiConversations.id });
  if (!convRow) {
    throw new Error("Failed to create ephemeral conversation");
  }
  const conversationId = convRow.id;

  // Seed fixtures first so we know which files actually landed before
  // shaping the user message's `parts`. A missing fixture is non-fatal.
  const seeded: SeededChatFile[] = [];
  for (const filename of args.fixtures ?? []) {
    // eslint-disable-next-line no-await-in-loop -- serial by design:
    // each push hits the sandbox + S3 backup queue, and keeping the
    // calls sequential simplifies error handling with minimal latency
    // cost (typical fixture set is < 10 files).
    const meta = await pushFixtureIntoSandbox(conversationId, filename);
    if (meta) seeded.push(meta);
  }

  // Build user-message parts: one text part + one `file` part per
  // successfully seeded fixture. Shape mirrors what `@ai-sdk/vue`
  // produces on the frontend for drag-and-dropped attachments:
  // `{ type: 'file', mediaType, filename, url }`. The chatbot handler
  // reads `filename` via `extractLastUserFileFilenames`.
  //
  // The AI SDK's `UIMessage['parts']` type is a strict discriminated
  // union we don't need to conform to here — Drizzle persists the
  // array as JSONB verbatim and the handler reads back via
  // `isFileUIPart` / `part.type === 'file'` duck-typing. We cast
  // through `never` to bypass the compile-time narrowing.
  const messageParts: Array<Record<string, unknown>> = [
    { type: "text", text: args.prompt },
  ];
  for (const f of seeded) {
    messageParts.push({
      type: "file",
      mediaType: f.mimeType,
      filename: f.filename,
      // Production uses an S3 presigned URL. The /invoke path never
      // re-downloads the file (it relies on the sandbox), so a stub
      // URL here is harmless.
      url: `${WORKSPACE_ROOT}/${WORKSPACE_DIRS.attachments}/${f.filename}`,
    });
  }

  const [userMessageRow] = await db
    .insert(aiMessages)
    .values({
      conversationId,
      role: "user",
      parts: messageParts as unknown as never,
      metadata: null,
    })
    .returning({ id: aiMessages.id });
  if (!userMessageRow) {
    throw new Error("Failed to persist seeded user message");
  }

  // Register the seeded fixtures in `ai_chat_files` so
  // `buildAttachedFilesBlock` can resolve them and emit the rich
  // `<file_attachments>` system-prompt section. `status='ready'`
  // because we bypass the normal upload/OCR pipeline — the sidecar
  // (if any) is already in the sandbox next to the main file.
  if (seeded.length > 0) {
    await db.insert(aiChatFiles).values(
      seeded.map((f) => ({
        conversationId,
        messageId: userMessageRow.id,
        filename: f.filename,
        mimeType: f.mimeType,
        size: f.size,
        hasMarkdown: f.hasMarkdown,
        status: "ready" as const,
      })),
    );
  }

  return conversationId;
};

/**
 * Pre-seed a long, realistic-looking fake conversation history into
 * `ai_messages` for the given conversation, BEFORE the eval's user
 * prompt is sent. Use case: compaction evals must cross the
 * threshold (~163K tokens at default config) which a single-turn
 * stateless eval cannot reach on its own.
 *
 * The seeded history is inserted with `created_at` timestamps a few
 * minutes in the past so `loadConversationForAgent` returns them
 * BEFORE the real user prompt that
 * `createEphemeralConversation` already inserted. We do this by
 * timestamping each row deterministically backwards from now.
 *
 * Content is plausible French transport/logistics Q&A so the
 * summariser sees realistic input (and the verbatim-preservation
 * rules have something to grip onto). 20 messages × ~35K chars ≈
 * 700K chars ≈ 175K tokens — comfortably above the 163K default
 * threshold.
 *
 * @param conversationId  Target conversation row (typically the one
 *                         `createEphemeralConversation` returned).
 * @param opts.includeSearchTools  When true, weave a few synthetic
 *                                  `tool-searchTools` results into the
 *                                  history so post-compact tests can
 *                                  assert that activated tools survive.
 * @param opts.includeManageTasks  When true, append a `tool-manageTasks`
 *                                  result with a pending checklist so
 *                                  the runtime-state extraction has
 *                                  something to surface in the summary.
 */
export const seedLargeFakeHistory = async (
  conversationId: string,
  opts: { includeSearchTools?: boolean; includeManageTasks?: boolean } = {},
): Promise<void> => {
  // Use UIMessage-shaped objects but persist as JSONB; the schema's
  // `$type<UIMessage["parts"]>()` is loose enough that Drizzle accepts
  // the runtime shape directly.
  const baseExchanges: Array<{ user: string; assistant: string }> = [
    {
      user: "Peux-tu me retrouver le BL associé au conteneur MSKU-3847291 livré la semaine dernière ?",
      assistant:
        "BL retrouvé : MAEU-2024-BL-09821 émis par Maersk le 14 mars 2026 (Rotterdam → Le Havre). Facture associée : INV-2026-0341.",
    },
    {
      user: "Combien de shipments retardés de plus de 48h ce trimestre, et quel est le client le plus impacté ?",
      assistant:
        "T1 2026 : 17 expéditions retardées >48h. Client le plus impacté : Lumière Logistics avec 6 retards cumulés sur la ligne Shanghai → Marseille en février.",
    },
    {
      user: "Charge invoice-tradex-2026-04.pdf et extrais le total HT, le total TTC et la liste des articles.",
      assistant:
        "OCR Mistral terminée. Total HT : 48 320,00 EUR. Total TTC : 57 984,00 EUR. Articles : 14 palettes europe (2 850 kg net), 32 cartons ventilés (1 120 kg), 8 conteneurs IBC 1000L (7 840 kg).",
    },
    {
      user: "Compare les coûts Rotterdam-Le Havre vs Anvers-Le Havre sur les 6 derniers mois.",
      assistant:
        "Rotterdam-Le Havre : 1 245 EUR/TEU (+8% vs Anvers). Transit time meilleur via Rotterdam (2,1j vs 2,7j), on-time 96% vs 91%. Manutention : 240 EUR vs 198 EUR/mouvement.",
    },
    {
      user: "Quel est le statut de l'extraction customs-2026-Q1-batch-02 ?",
      assistant:
        "Status 'ready' depuis 04:12 ce matin. 347 déclarations en douane (jan-mars 2026), accuracyScore 0,94. 3 documents flagués : cnd-2026-0114-msk.pdf, cnd-2026-0207-cma.pdf, cnd-2026-0301-one.pdf.",
    },
  ];

  // Pad each base exchange to ~35K chars by appending repeating
  // domain-flavoured filler. Keeps the summariser input
  // representative without paying for hand-written 35K-char text.
  const FILLER =
    "Note logistique : la rotation moyenne des conteneurs 40HC sur le hub de Fos-sur-Mer est passée de 9,2 à 7,8 jours au T1 2026. Les frais portuaires TCPF ont augmenté de 4,2% depuis le 1er avril 2026 (arrêté préfectoral n°26-LH-044). Toute déclaration DELTA-G doit être soumise au plus tard 24h avant l'arrivée du navire selon l'article 145 du CDU. Depuis mars 2026, les connaissements CMA-CGM intègrent un QR code permettant la traçabilité Track & Trace en temps réel. La nouvelle réglementation UE 2026/214 impose une fiche de données de sécurité mise à jour pour chaque expédition de produits chimiques. ";
  const padTo = (base: string, target: number): string => {
    let out = base;
    while (out.length < target) out += " " + FILLER;
    return out.slice(0, target);
  };
  const TARGET_CHARS_PER_MESSAGE = 35_000;

  // Build 20 messages alternating user/assistant.
  const rows: Array<{
    conversationId: string;
    role: "user" | "assistant";
    parts: unknown;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
  }> = [];

  // Anchor timestamps a couple of hours back so the seeded turns
  // sort BEFORE whatever timestamps the live AI service writes for
  // the real user prompt. Step 1 second per row → preserves order.
  const baseTime = Date.now() - 2 * 60 * 60 * 1000;

  for (let i = 0; i < 20; i++) {
    const exchange = baseExchanges[i % baseExchanges.length];
    if (!exchange) continue;
    const isUser = i % 2 === 0;
    const text = padTo(
      isUser ? exchange.user : exchange.assistant,
      TARGET_CHARS_PER_MESSAGE,
    );
    rows.push({
      conversationId,
      role: isUser ? "user" : "assistant",
      parts: [{ type: "text", text }],
      metadata: null,
      createdAt: new Date(baseTime + i * 1000),
    });
  }

  // Optional: stitch a `tool-searchTools` result into the assistant
  // turn at index 1 so the post-compact runtime-state extraction has
  // something to surface. We weave the part alongside the existing
  // text part on the same message — this matches what the production
  // chatbot persists when the model issues a tool call mid-turn.
  if (opts.includeSearchTools && rows.length > 1) {
    const target = rows[1];
    if (target && Array.isArray(target.parts)) {
      target.parts = [
        ...target.parts,
        {
          type: "tool-searchTools",
          toolCallId: "eval-seed-search-tools",
          state: "output-available",
          input: { query: "select:listDocuments,querySql" },
          output: {
            matches: ["listDocuments", "querySql"],
            query: "select:listDocuments,querySql",
            total_deferred_tools: 7,
          },
        },
      ];
    }
  }

  // Optional: append a `tool-manageTasks` result with a pending list
  // so the runtime-state attachment block in the summary has tasks
  // to mention.
  if (opts.includeManageTasks && rows.length > 3) {
    const target = rows[3];
    if (target && Array.isArray(target.parts)) {
      target.parts = [
        ...target.parts,
        {
          type: "tool-manageTasks",
          toolCallId: "eval-seed-manage-tasks",
          state: "output-available",
          input: {
            tasks: [
              {
                content: "Récupérer le BL du shipment MSKU-3847291",
                activeForm: "Récupération du BL",
                status: "in_progress",
              },
              {
                content: "Croiser avec la facture INV-2026-0341",
                activeForm: "Croisement avec la facture",
                status: "pending",
              },
            ],
          },
          output: {
            tasks: [
              {
                content: "Récupérer le BL du shipment MSKU-3847291",
                activeForm: "Récupération du BL",
                status: "in_progress",
              },
              {
                content: "Croiser avec la facture INV-2026-0341",
                activeForm: "Croisement avec la facture",
                status: "pending",
              },
            ],
          },
        },
      ];
    }
  }

  // Insert in a single batch — chunks of 50 are well under the
  // pg_stmt_max_parameters limit (each row has ~5 columns × 20 rows
  // ≈ 100 params).
  await db.insert(aiMessages).values(
    rows.map((r) => ({
      conversationId: r.conversationId,
      role: r.role,
      parts: r.parts as never,
      metadata: r.metadata,
      createdAt: r.createdAt,
    })),
  );
};

/**
 * Destroy the ephemeral conversation + its sandbox session. Cascade
 * deletes all `ai_messages` + `ai_chat_files` rows via the FK. The
 * conversation's E2B sandbox is left to expire under E2B's TTL — its
 * S3 mirror under `chatbot-sessions/{convId}/` is governed by S3
 * lifecycle policies. Errors are swallowed (and logged) so a bad
 * cleanup can't abort a whole eval run.
 */
export const destroyEphemeralConversation = async (
  conversationId: string,
): Promise<void> => {
  // 1. Tear down the orchestrator session, if any. Best-effort —
  //    orchestrator being unreachable is not a fatal condition here.
  const orchestratorUrl = process.env.ORCHESTRATOR_URL;
  const internalKey = process.env.INTERNAL_KEY;
  if (orchestratorUrl && internalKey) {
    try {
      await fetch(
        `${orchestratorUrl.replace(/\/+$/, "")}/api/v1/sessions/${encodeURIComponent(conversationId)}`,
        {
          method: "DELETE",
          headers: { "X-Internal-Key": internalKey },
        },
      );
    } catch (err) {
      console.warn(
        `[evals] orchestrator session teardown failed for ${conversationId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 2. Delete the conversation row. FK cascade cleans up ai_messages
  //    AND ai_chat_files via their FK constraints.
  try {
    await db
      .delete(aiConversations)
      .where(eq(aiConversations.id, conversationId));
  } catch (err) {
    console.warn(
      `[evals] conversation row teardown failed for ${conversationId}:`,
      err instanceof Error ? err.message : err,
    );
  }
};
