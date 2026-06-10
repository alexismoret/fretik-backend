/**
 * Shared in-memory sandbox + S3 mocks for tool unit tests.
 *
 * The sandbox-first conversation storage façade calls into
 * `@fretik/shared/services/e2b/files` for every read/write and
 * `@fretik/shared/lib/chatbot-session-storage` for S3 backup. Real
 * tests would require a live E2B sandbox + S3 bucket; instead, we
 * mock both layers with `bun:test`'s `mock.module()` and back them
 * by simple in-memory `Map`s.
 *
 * Usage (call ONCE at the top of a test file BEFORE any SUT import):
 *
 *     import { installSandboxMocks, sandboxFs } from "../lib/sandbox-fixture";
 *     installSandboxMocks();
 *     const { createReadTool } = await import("../../src/tools/read");
 *
 * Then seed files in tests via `sandboxFs.write(convId, "attachments/foo.md", "...")`.
 *
 * The fixture also stubs the S3 env vars + Redis URL so importing
 * the shared `lib/s3` and `lib/redis` modules doesn't throw at load.
 */

import { mock } from "bun:test";

// --------------------------------------------------------------- //
// Env stubs (must run BEFORE any shared module is loaded)         //
// --------------------------------------------------------------- //

process.env.SCW_ACCESS_KEY ??= "test-access";
process.env.SCW_SECRET_KEY ??= "test-secret";
process.env.S3_BUCKET ??= "test-bucket";
process.env.S3_URL ??= "http://127.0.0.1:1";
process.env.S3_REGION ??= "fr-par";
process.env.REDIS_URL ??= "redis://127.0.0.1:1";
process.env.E2B_API_KEY ??= "test-e2b";
process.env.OPENROUTER_VISION_FALLBACK_MODEL ??= "openai/gpt-4o-mini";

// --------------------------------------------------------------- //
// In-memory stores                                                 //
// --------------------------------------------------------------- //

const sandboxStore = new Map<string, Uint8Array>();
const s3Store = new Map<string, Uint8Array>();

const buildKey = (conversationId: string, path: string): string =>
  `${conversationId}::${path.replace(/^\/+workspace\/+/, "").replace(/^\/+/, "")}`;

const buildS3Key = (conversationId: string, path: string): string =>
  `${conversationId}::${path.replace(/^\/+/, "")}`;

/**
 * Test-side handle to the in-memory stores. Use this to seed files
 * before invoking a tool, or to assert what landed in S3 after.
 */
export const sandboxFs = {
  /** Reset both stores. Call from `beforeEach` for isolation. */
  reset(): void {
    sandboxStore.clear();
    s3Store.clear();
  },
  /** Write a file into the in-memory sandbox at `path` (workspace-relative). */
  write(
    conversationId: string,
    path: string,
    content: string | Uint8Array,
  ): void {
    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : content;
    sandboxStore.set(buildKey(conversationId, path), bytes);
  },
  /** True iff a file exists in the sandbox at `path`. */
  exists(conversationId: string, path: string): boolean {
    return sandboxStore.has(buildKey(conversationId, path));
  },
  /** Read the bytes at `path`. Returns null if absent. */
  read(conversationId: string, path: string): Uint8Array | null {
    return sandboxStore.get(buildKey(conversationId, path)) ?? null;
  },
  /** List sandbox-relative paths under a subdir. */
  list(conversationId: string, prefix?: string): string[] {
    const cprefix = `${conversationId}::${prefix ?? ""}`;
    return [...sandboxStore.keys()]
      .filter((k) => k.startsWith(cprefix))
      .map((k) => k.slice(`${conversationId}::`.length));
  },
  /** Seed an S3 backup directly (simulates content already in storage). */
  seedS3(
    conversationId: string,
    path: string,
    content: string | Uint8Array,
  ): void {
    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : content;
    s3Store.set(buildS3Key(conversationId, path), bytes);
  },
  /** Read the S3 mirror at `path` for a conversation. */
  readS3(conversationId: string, path: string): Uint8Array | null {
    return s3Store.get(buildS3Key(conversationId, path)) ?? null;
  },
  /** True iff a file is mirrored to S3. */
  existsS3(conversationId: string, path: string): boolean {
    return s3Store.has(buildS3Key(conversationId, path));
  },
};

// --------------------------------------------------------------- //
// Module mocks                                                     //
// --------------------------------------------------------------- //

let installed = false;

/**
 * Replace the E2B sandbox + S3 modules with in-memory implementations.
 * Idempotent — safe to call multiple times.
 *
 * Must be called BEFORE any dynamic `import("../../src/...")` of the
 * SUT, since `mock.module` only intercepts imports that resolve after
 * the call.
 */
export const installSandboxMocks = (): void => {
  if (installed) return;
  installed = true;

  // E2B sandbox files — every helper is now an in-memory map operation.
  void mock.module("@fretik/shared/services/e2b/files", () => ({
    writeSandboxFile: async (
      conversationId: string,
      path: string,
      bytes: Uint8Array,
    ): Promise<void> => {
      sandboxStore.set(buildKey(conversationId, path), bytes);
    },
    readSandboxFile: async (
      conversationId: string,
      path: string,
    ): Promise<Uint8Array> => {
      const bytes = sandboxStore.get(buildKey(conversationId, path));
      if (!bytes) throw new Error(`Sandbox file not found: ${path}`);
      return bytes;
    },
    listSandboxFiles: async (
      conversationId: string,
      prefix?: string,
    ): Promise<{ path: string; size: number; mtimeMs: number }[]> => {
      const cprefix = `${conversationId}::${prefix ? `${prefix.replace(/\/+$/, "")}/` : ""}`;
      return [...sandboxStore.entries()]
        .filter(([k]) => k.startsWith(cprefix))
        .map(([k, v]) => ({
          path: k.slice(`${conversationId}::`.length),
          size: v.byteLength,
          mtimeMs: 0,
        }));
    },
    removeSandboxFile: async (
      conversationId: string,
      path: string,
    ): Promise<void> => {
      sandboxStore.delete(buildKey(conversationId, path));
    },
    sandboxFileExists: async (
      conversationId: string,
      path: string,
    ): Promise<boolean> => {
      return sandboxStore.has(buildKey(conversationId, path));
    },
    makeSandboxDir: async (
      _conversationId: string,
      _path: string,
    ): Promise<void> => {
      // No-op: in-memory store has no directory concept; writes
      // implicitly create the path.
    },
    execSandboxCommand: async (
      _conversationId: string,
      _command: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      // No-op stub: the conversation-storage tarball bootstrap calls
      // `tar -xzf …` via this helper. The in-memory sandbox has no
      // real filesystem so we simply pretend the extract succeeded —
      // tests that need actual skill files in the sandbox seed them
      // through `sandboxFs.write(...)` directly.
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  }));

  // Acquire/release sandbox — return a stable mock id so the
  // bootstrap path's "sandbox already initialised" Set hit works.
  void mock.module("@fretik/shared/services/e2b/acquire-sandbox", () => ({
    acquireSandbox: async (conversationId: string) => ({
      sandboxId: `mock-${conversationId}`,
      conversationId,
    }),
  }));

  // Bootstrap lock — always grant immediately.
  void mock.module("@fretik/shared/services/e2b/registry", () => ({
    acquireSandboxBootstrapLock: async () => true,
    releaseSandboxBootstrapLock: async () => {
      /* no-op */
    },
    // Unused by tests but keep the surface intact for completeness.
    acquireSandboxLock: async () => true,
    releaseSandboxLock: async () => {
      /* no-op */
    },
    getSandboxIdFromRegistry: async () => null,
    setSandboxIdInRegistry: async () => {
      /* no-op */
    },
    clearSandboxFromRegistry: async () => {
      /* no-op */
    },
    // Lazy-attachment generation counter (Redis-backed in prod). Tests
    // never restore from S3, so a stable 0 keeps `reconcileAttachments`
    // a no-op (currentGen <= restoredGen). Without these two stubs the
    // real ioredis client runs and hangs the test against the unreachable
    // stub REDIS_URL — see the `connect ECONNREFUSED 127.0.0.1:1` flood.
    getAttachmentGeneration: async () => 0,
    bumpAttachmentGeneration: async () => 1,
  }));

  // Team-uploaded skills + active external-app providers are resolved
  // from Postgres in prod (`select team_id from ai_conversations`).
  // Unit tests have no DB — stub both list services to empty so the
  // bootstrap's `pushTeamSkills` / `pushExternalAppProviderSkills`
  // early-return instead of issuing (failing) queries.
  void mock.module(
    "@fretik/shared/services/skills/list-enabled-team-uploaded-with-body",
    () => ({
      listEnabledTeamUploadedSkillsWithBodyForConversation: async () => [],
    }),
  );
  void mock.module(
    "@fretik/shared/services/external-apps/connections/list-active-providers-for-conversation",
    () => ({
      listActiveProviderKeysForConversation: async () => [],
    }),
  );

  // S3 session storage — back the helpers by the in-memory `s3Store`.
  void mock.module("@fretik/shared/lib/chatbot-session-storage", () => {
    const sanitizeSessionSegment = (value: string): string =>
      value.replace(/[^a-zA-Z0-9._-]/g, "_");
    const sanitizeSessionPath = (path: string): string =>
      path
        .split("/")
        .filter(
          (segment) =>
            segment.length > 0 && segment !== "." && segment !== "..",
        )
        .map(sanitizeSessionSegment)
        .join("/");
    const buildSessionKey = (
      conversationId: string,
      pathOrBasename: string,
    ): string =>
      `chatbot-sessions/${sanitizeSessionSegment(conversationId)}/${sanitizeSessionPath(pathOrBasename)}`;
    const buildSessionPrefix = (conversationId: string): string =>
      `chatbot-sessions/${sanitizeSessionSegment(conversationId)}/`;

    return {
      sanitizeSessionSegment,
      sanitizeSessionPath,
      buildSessionKey,
      buildSessionPrefix,
      uploadSessionFile: async (
        conversationId: string,
        pathOrBasename: string,
        content: string | Uint8Array,
        _contentType?: string,
      ): Promise<void> => {
        const bytes =
          typeof content === "string"
            ? new TextEncoder().encode(content)
            : content;
        s3Store.set(buildS3Key(conversationId, pathOrBasename), bytes);
      },
      readSessionFile: async (
        conversationId: string,
        pathOrBasename: string,
      ): Promise<Uint8Array | null> => {
        return s3Store.get(buildS3Key(conversationId, pathOrBasename)) ?? null;
      },
      listSessionFiles: async (conversationId: string): Promise<string[]> => {
        const prefix = `${conversationId}::`;
        return [...s3Store.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length))
          .filter((p) => !p.includes("/"));
      },
      listSessionPaths: async (
        conversationId: string,
        subdirPrefix?: string,
      ): Promise<string[]> => {
        const prefix = `${conversationId}::${subdirPrefix ? `${subdirPrefix.replace(/\/+$/, "")}/` : ""}`;
        return [...s3Store.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(`${conversationId}::`.length));
      },
      deleteSessionFile: async (
        conversationId: string,
        pathOrBasename: string,
      ): Promise<void> => {
        s3Store.delete(buildS3Key(conversationId, pathOrBasename));
      },
      deleteSessionFolder: async (conversationId: string): Promise<void> => {
        const prefix = `${conversationId}::`;
        for (const key of [...s3Store.keys()]) {
          if (key.startsWith(prefix)) s3Store.delete(key);
        }
      },
      getSessionFilePresignedUrl: async (
        conversationId: string,
        pathOrBasename: string,
      ): Promise<string> =>
        `https://mock.s3/${buildSessionKey(conversationId, pathOrBasename)}`,
    };
  });
};
