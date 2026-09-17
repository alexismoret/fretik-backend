import db from "@fretik/shared/db";
import { aiContextFiles } from "@fretik/shared/db/schema";
import { shouldWriteSidecar } from "@fretik/shared/file-types";
import {
  buildContextOriginalKey,
  readContextOriginal,
  readContextSidecar,
  uploadContextSidecar,
} from "@fretik/shared/lib/ai-context-storage";
import { sanitizeSessionPath } from "@fretik/shared/lib/chatbot-session-storage";
import {
  canBrokerSandboxJwt,
  signSandboxJwt,
} from "@fretik/shared/lib/external-apps/sandbox-jwt";
import { applySandboxEgress } from "@fretik/shared/services/e2b/apply-egress";
import {
  buildSandboxNetworkPolicy,
  detectBackendHost,
} from "@fretik/shared/services/e2b/network-policy";
import { collectProviderEgressHosts } from "@fretik/shared/services/e2b/provider-egress";
import type { SandboxLease } from "@fretik/shared/services/e2b/types";
import { getOrganizationSandboxPolicy } from "@fretik/shared/services/organization/sandbox-policy";
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
  writeSandboxTurnFiles,
} from "./conversation-storage";
import { hydrateMemoryTree } from "./memory-hydration";

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

/**
 * Last turn for which a given sandbox had its egress policy applied and its
 * credential set up, by `sandboxId`. Same shape and same reason as
 * `lastHydratedTurnBySandbox`: several `python` / `bash` calls in one turn
 * must not re-mint the JWT or re-send the policy, and the next turn must —
 * the credential is per turn, and the policy may have changed since.
 */
const lastTurnSetupBySandbox = new Map<string, string>();

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
 * Everything the sandbox needs to be told before this turn's code runs: which
 * hosts it may reach, and how it authenticates back to us.
 *
 * Both used to be settled elsewhere and once. The egress policy was baked at
 * `Sandbox.create`, so a sandbox kept whatever was true the first time its
 * conversation ran code. The credential was written into the workspace, where
 * the agent — which runs as root — could read it and, with one allowed host,
 * send it anywhere.
 *
 * Now both are recomputed per turn and applied together:
 *
 *  - the policy composes the org's mode, the team's ACTIVE connections and
 *    the package tiers, and goes out through `updateNetwork` (~180 ms), which
 *    replaces allow/deny/rules atomically on a running or just-resumed
 *    sandbox;
 *  - under the `proxy` transport the JWT rides IN that policy as a per-host
 *    header rule, so E2B's egress proxy adds it on the way out and the guest
 *    never holds it. Dropping the rule is what revokes it.
 *
 * Best-effort and memoised per (sandbox, turn), as the credential write always
 * was: a failure warns and lets execution proceed rather than killing a turn
 * over a settings read. The one failure that is NOT tolerable is a policy that
 * did not apply while the credential was supposed to be inside it — that would
 * leave the SDK unauthenticated with no way to say so, hence the fallback to
 * writing the token for that turn.
 */
const ensureSandboxTurnSetup = async (ctx: {
  conversationId: string;
  organizationId: string;
  teamId: string;
  userId: string;
  turnId: string;
  lease: SandboxLease;
  providerKeys: readonly string[];
}): Promise<void> => {
  const { sandboxId } = ctx.lease;
  if (lastTurnSetupBySandbox.get(sandboxId) === ctx.turnId) return;

  const sandboxJwtSecret = Bun.env.SANDBOX_JWT_SECRET;
  const backendUrl = Bun.env.FRETIK_BACKEND_INTERNAL_URL;
  if (
    sandboxJwtSecret === undefined ||
    sandboxJwtSecret === "" ||
    backendUrl === undefined ||
    backendUrl === ""
  ) {
    console.warn(
      "[sandbox-turn] SANDBOX_JWT_SECRET/FRETIK_BACKEND_INTERNAL_URL missing — fretik_apps calls will fail",
    );
    return;
  }

  try {
    const orgPolicy = await getOrganizationSandboxPolicy(ctx.organizationId);
    const providerHosts = collectProviderEgressHosts(ctx.providerKeys);
    const { token, jti } = await signSandboxJwt({
      conversationId: ctx.conversationId,
      teamId: ctx.teamId,
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      turnId: ctx.turnId,
      sandboxId,
    });

    // The credential rides in the policy, so the guest never holds it. The
    // only reason not to is that the proxy has no TLS to terminate.
    const backendHost = detectBackendHost();
    const brokerable = canBrokerSandboxJwt() && backendHost !== null;
    const policy = buildSandboxNetworkPolicy({
      backendHost,
      orgPolicy,
      providerHosts,
      brokeredJwt: brokerable ? token : undefined,
    });

    if (!brokerable) {
      console.error(
        "[sandbox-turn] cannot broker the sandbox credential (FRETIK_BACKEND_INTERNAL_URL must be https) — writing it into the workspace, where agent code can read it",
      );
    }
    let jwtForWorkspace = brokerable ? "" : token;

    try {
      const applied = await applySandboxEgress(
        ctx.lease.sandbox,
        sandboxId,
        policy,
      );
      if (applied.applied && applied.durationMs > 1_000) {
        console.warn(
          `[sandbox-turn] updateNetwork took ${applied.durationMs.toString()} ms for ${sandboxId}`,
        );
      }
    } catch (error) {
      // The policy carries the credential, so a failed update means the SDK
      // has no way to authenticate. Degrading beats failing the turn: the
      // token is still bound to this sandbox and dies with it. Logged as an
      // error because it is the one path that puts a credential in the guest.
      console.error(
        "[sandbox-turn] updateNetwork failed — writing the credential into the workspace for this turn:",
        error instanceof Error ? error.message : error,
      );
      jwtForWorkspace = token;
    }

    await writeSandboxTurnFiles(ctx.conversationId, {
      jwt: jwtForWorkspace,
      backendUrl,
      turnId: ctx.turnId,
      allowedHosts: policy.allowOut,
      egressMode: orgPolicy.egressMode,
    });
    console.info(
      `[sandbox-turn] sandbox=${sandboxId} jti=${jti} mode=${orgPolicy.egressMode} hosts=${policy.allowOut.length.toString()} credential=${jwtForWorkspace === "" ? "brokered" : "in-workspace"}`,
    );
    lastTurnSetupBySandbox.set(sandboxId, ctx.turnId);
  } catch (error) {
    console.warn(
      "[sandbox-turn] turn setup failed — fretik_apps calls will fail this turn:",
      error instanceof Error ? error.message : error,
    );
  }
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
  /** Provider keys of the team's active connections, for the egress tier. */
  providerKeys?: readonly string[];
}): Promise<SandboxLease> => {
  const lease = await prepareSandbox(ctx.conversationId);

  // This turn's egress policy and `fretik_apps` credential. Runs before
  // hydration so a slow context pull can't leave the SDK unauthenticated, or
  // the sandbox on a stale allowlist, for a code call that only needs the API.
  // `traceId` IS the turn id — the same value the turn-start version passed as
  // `turnId` (`callOptions.traceId`).
  if (ctx.userId !== undefined && ctx.traceId !== undefined) {
    await ensureSandboxTurnSetup({
      conversationId: ctx.conversationId,
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      userId: ctx.userId,
      turnId: ctx.traceId,
      lease,
      providerKeys: ctx.providerKeys ?? [],
    });
  }

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

  // Memories are NOT behind the per-turn memo above: the agent rewrites them
  // mid-turn through the `memory` tool, so "already hydrated this turn" would
  // serve a stale tree for exactly the case that matters — write a memory,
  // then grep for it. Its own fingerprint gate makes the check cheap enough to
  // run on every code call (one indexed SELECT, no sandbox traffic when the
  // tree has not moved).
  if (ctx.userId !== undefined) {
    try {
      await hydrateMemoryTree({
        conversationId: ctx.conversationId,
        sandboxId: lease.sandboxId,
        scopeKey: {
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          userId: ctx.userId,
        },
      });
    } catch (err) {
      console.warn(
        "[memory-hydration] failed, proceeding with whatever is in the sandbox:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return lease;
};
