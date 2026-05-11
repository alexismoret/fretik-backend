import db from "@fretik/shared/db";
import { aiContextFiles } from "@fretik/shared/db/schema";
import {
  buildContextOriginalKey,
  readContextOriginal,
  readContextSidecar,
  uploadContextSidecar,
} from "@fretik/shared/lib/ai-context-storage";
import { sanitizeSessionPath } from "@fretik/shared/lib/chatbot-session-storage";
import { shouldWriteSidecar } from "@fretik/shared/services/ai-context/upload";
import { eq } from "drizzle-orm";
import { extname } from "node:path";
import {
  loadAccessibleContext,
  type AccessibleContextFile,
} from "../services/chatbot-context/load-context";
import { fileExists, WORKSPACE_DIRS, writeFile } from "./conversation-storage";

/**
 * Hydrate the persistent chatbot-context files (`aiContextFiles`)
 * into the conversation sandbox so the standard `read` tool — and
 * `python` / `bash` — can serve them just like any other file.
 *
 * Layout: every accessible context file lands at
 *
 *   /workspace/context/{filename}
 *
 * and, when the row carries a `.md` sidecar, also at
 *
 *   /workspace/context/{stem}.md
 *
 * Cache hit fast path: a `fileExists` check on the sandbox; we only
 * write when the file is missing. The `context/` namespace is
 * read-only by the agent's contract, so a single hydration per
 * sandbox is enough — we don't need to re-push on every turn.
 *
 * Lazy backfill: rows with `hasMarkdown = false` whose MIME type is
 * sidecar-eligible and whose DB `content` is populated have the
 * sidecar written on the fly to S3 + sandbox; `hasMarkdown` is then
 * flipped in DB. Idempotent.
 *
 * Best-effort: every per-file step is wrapped in try/catch + warn.
 * A partial hydration must never block a turn.
 */

interface HydrationContext {
  conversationId: string;
  userId: string | undefined;
  teamId: string;
  organizationId: string;
}

const sidecarBasenameFor = (filename: string): string => {
  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  return `${stem}.md`;
};

/**
 * Materialise one row's sidecar bytes into the sandbox. Resolves
 * the lazy-backfill case in a single place so the rest of the
 * hydration loop reads cleanly.
 */
const ensureSidecarInSandbox = async (args: {
  conversationId: string;
  file: AccessibleContextFile;
  sandboxPath: string;
}): Promise<void> => {
  const { conversationId, file, sandboxPath } = args;

  if (await fileExists(conversationId, sandboxPath)) return;

  const fromS3 = await readContextSidecar(file.profileId, file.id);
  if (fromS3) {
    await writeFile(conversationId, sandboxPath, fromS3);
    return;
  }

  // Lazy backfill: the sidecar isn't on S3 yet but the row has the
  // extracted markdown in DB. Upload to S3 first so future
  // hydrations are fast, then write to the sandbox. Flip
  // `hasMarkdown` in DB so the manifest builder and other consumers
  // see a consistent state.
  if (file.content !== null && file.content.length > 0) {
    try {
      await uploadContextSidecar(file.profileId, file.id, file.content);
      await writeFile(conversationId, sandboxPath, file.content);
      if (!file.hasMarkdown) {
        await db
          .update(aiContextFiles)
          .set({ hasMarkdown: true })
          .where(eq(aiContextFiles.id, file.id));
      }
    } catch (err) {
      console.warn(
        `[context-hydration] sidecar backfill failed for ${file.id} (${file.filename}):`,
        err instanceof Error ? err.message : err,
      );
    }
    return;
  }

  console.warn(
    `[context-hydration] sidecar missing on S3 with no DB content fallback for ${file.id} (${file.filename}); read("${sandboxPath}") will fail.`,
  );
};

const ensureOriginalInSandbox = async (args: {
  conversationId: string;
  file: AccessibleContextFile;
  sandboxPath: string;
}): Promise<void> => {
  const { conversationId, file, sandboxPath } = args;

  if (await fileExists(conversationId, sandboxPath)) return;

  const ext = extname(file.filename).toLowerCase();
  const bytes = await readContextOriginal(file.profileId, file.id, ext);
  if (!bytes) {
    console.warn(
      `[context-hydration] original missing on S3 for ${file.id} (key=${buildContextOriginalKey(file.profileId, file.id, ext)}); skipping.`,
    );
    return;
  }
  await writeFile(conversationId, sandboxPath, bytes);
};

export const hydrateContextFiles = async (
  ctx: HydrationContext,
): Promise<void> => {
  const accessible = await loadAccessibleContext({
    userId: ctx.userId,
    teamId: ctx.teamId,
    organizationId: ctx.organizationId,
  });

  const usable = accessible.files.filter(
    (f) => f.enabled && f.status === "ready",
  );
  if (usable.length === 0) return;

  // Pull every accessible file (and sidecar) into the sandbox in
  // parallel. Each step is independent — one S3 miss never blocks
  // the rest of the hydration. No stale-cleanup pass: when an
  // accessible file disappears, the corresponding sandbox file is
  // simply not refreshed; the system-prompt manifest reflects the
  // authoritative DB state, and the agent reads via the manifest's
  // declared paths.
  await Promise.all(
    usable.map(async (file) => {
      const originalBasename = sanitizeSessionPath(file.filename);
      const originalPath = `${WORKSPACE_DIRS.context}/${originalBasename}`;
      try {
        await ensureOriginalInSandbox({
          conversationId: ctx.conversationId,
          file,
          sandboxPath: originalPath,
        });
      } catch (err) {
        console.warn(
          `[context-hydration] original hydration failed for ${file.id}:`,
          err instanceof Error ? err.message : err,
        );
      }

      const wantsSidecar =
        file.hasMarkdown ||
        shouldWriteSidecar(file.mimeType, file.content ?? "");
      if (!wantsSidecar) return;

      const sidecarPath = `${WORKSPACE_DIRS.context}/${sanitizeSessionPath(sidecarBasenameFor(file.filename))}`;
      try {
        await ensureSidecarInSandbox({
          conversationId: ctx.conversationId,
          file,
          sandboxPath: sidecarPath,
        });
      } catch (err) {
        console.warn(
          `[context-hydration] sidecar hydration failed for ${file.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );
};
