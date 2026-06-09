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
import type { SandboxLease } from "@fretik/shared/services/e2b/types";
import { eq } from "drizzle-orm";
import { extname } from "node:path";
import {
  loadAccessibleContext,
  type AccessibleContextFile,
} from "../services/chatbot-context/load-context";
import {
  fileExists,
  prepareSandbox,
  WORKSPACE_DIRS,
  writeFile,
} from "./conversation-storage";

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

/**
 * Last turn for which a given sandbox was hydrated, by `sandboxId`.
 * Lets `prepareSandboxForCode` skip redundant hydration when several
 * `python` / `bash` calls fire within the same turn, while still
 * re-hydrating on the next turn so context files added between turns
 * are picked up — the same per-turn freshness the old turn-start
 * hydration gave, now paid only when code actually runs.
 */
const lastHydratedTurnBySandbox = new Map<string, string>();

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

/**
 * Prepare the sandbox for code execution: bootstrap it (dirs, skills,
 * S3 restore) AND hydrate the persistent context files into
 * `/workspace/context/` so `python` / `bash` can read them directly
 * (e.g. `pandas.read_excel("context/grid.xlsx")`).
 *
 * Replaces a bare `prepareSandbox` call in the `python` / `bash` tools.
 * Context hydration is what used to run eagerly at the start of every
 * turn; moving it here means a turn that never executes code (pure
 * chat, or `read`-only — `read` serves `context/` Bun-side) no longer
 * pays for sandbox acquisition + per-file existence checks.
 *
 * Hydration is memoised per sandbox per turn (`traceId`): the first
 * code call in a turn hydrates, later calls in the same turn skip,
 * and the next turn re-hydrates so files added between turns surface.
 * Best-effort — a hydration failure never blocks code execution.
 */
export const prepareSandboxForCode = async (ctx: {
  conversationId: string;
  organizationId: string;
  teamId: string;
  userId: string | undefined;
  traceId: string | undefined;
}): Promise<SandboxLease> => {
  const lease = await prepareSandbox(ctx.conversationId);

  const alreadyHydrated =
    ctx.traceId !== undefined &&
    lastHydratedTurnBySandbox.get(lease.sandboxId) === ctx.traceId;
  if (!alreadyHydrated) {
    try {
      await hydrateContextFiles({
        conversationId: ctx.conversationId,
        userId: ctx.userId,
        teamId: ctx.teamId,
        organizationId: ctx.organizationId,
      });
      if (ctx.traceId !== undefined) {
        lastHydratedTurnBySandbox.set(lease.sandboxId, ctx.traceId);
      }
    } catch (err) {
      console.warn(
        "[context-hydration] prepareSandboxForCode hydration failed, proceeding with whatever is in the sandbox:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return lease;
};
