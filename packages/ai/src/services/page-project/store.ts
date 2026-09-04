import { redis } from "@fretik/shared/lib/redis";
import {
  eachPageFile,
  PAGE_ENTRY_FILE,
  type PageDefinition,
} from "@fretik/shared/schemas/pages";
import { PAGE_JSON_FILE } from "./page-json";

/**
 * The builder's WORKING COPY of one page's files.
 *
 * A page's stored definition is what viewers get, and it only ever holds a
 * build that compiled. The files an agent is in the middle of writing are
 * neither: half a project does not compile, and refusing to hold it is what
 * made the old write path so expensive — a compile error after a 25 000-token
 * emission left nothing behind but the error, and the fix was another 25 000
 * tokens (measured 2026-08-23, roughly half the builder's answer tokens).
 *
 * So writes land here, builds promote from here, and nothing in between is
 * lost. Redis rather than the page row for the same reason the review budget
 * lives here: it belongs to ONE run, not to the page. Keyed by the run's trace
 * id, so two builds in one turn cannot write over each other, and 24 hours is
 * long enough that a run which died mid-way can still be finished by hand.
 */

const TTL_SECONDS = 24 * 60 * 60;

const key = (scope: string): string => `pages:project:${scope}`;

/** How many times an edit may miss on one file before rewriting it is the advice. */
export const MAX_EDIT_FAILURES = 3;

export interface PageProjectFileState {
  /** Epoch ms of the last `pageRead` covering the whole file. */
  readAt?: number;
  /**
   * Content hash at that read. A second read of an unchanged file returns the
   * fact rather than the bytes: they are already in the context that asked.
   *
   * `CryptoHasher`, not `Bun.hash`: this state lives in Redis and is compared
   * across processes, and `Bun.hash`'s seed is per-process — the comparison
   * would silently start failing after a restart.
   */
  readHash?: string;
  /** Epoch ms of the last write. */
  wroteAt?: number;
  /** Consecutive failed edits, reset by any successful write. */
  editFailures?: number;
}

export interface PageProjectState {
  /** Every file, entry included under `Page.vue`. */
  files: Record<string, string>;
  /** What the agent has read and written, per path. */
  seen: Record<string, PageProjectFileState>;
  /** The page these files belong to, once one exists. */
  pageId?: string;
  /** Hash of the files as they were last PROMOTED — the copy is dirty when it differs. */
  builtHash?: string;
  /**
   * What each write of this run cost, oldest first, capped at
   * `MAX_TRACKED_WRITES`.
   *
   * It lives here rather than only in a Langfuse event because of what the
   * events turned out to be worth: on a v4 `events_only` deployment the
   * observations API strips `metadata` AND usage, so the nineteen `page-write`
   * events of the 2026-09-04 build came back with their names and nothing else.
   * `pages:measure-writes` reads `metadata.mode` and `rewriteRatio` and would
   * have measured `undefined` forever. A build folds this into
   * `page_versions.meta.writes`, where it is ours and stays readable.
   */
  writes?: PageWriteRecord[];
}

/** One write, as `page_versions.meta.writes` keeps it. */
export interface PageWriteRecord {
  mode: "write" | "edit";
  path: string;
  linesChanged: number;
  linesTotal: number;
  charsEmitted: number;
  ratio: number;
}

/** Past this the record stops being a measurement and becomes a payload. */
export const MAX_TRACKED_WRITES = 80;

export const emptyProjectState = (): PageProjectState => ({
  files: {},
  seen: {},
});

export const readPageProject = async (
  scope: string,
): Promise<PageProjectState | null> => {
  const raw = await redis.get(key(scope));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "files" in parsed) {
      return parsed as PageProjectState;
    }
  } catch {
    // A malformed copy is a cold start, not a failed build.
  }
  return null;
};

export const writePageProject = async (
  scope: string,
  state: PageProjectState,
): Promise<void> => {
  await redis.setex(key(scope), TTL_SECONDS, JSON.stringify(state));
};

export const clearPageProject = async (scope: string): Promise<void> => {
  await redis.del(key(scope));
};

/**
 * The stored page, as a working copy — what a repair starts from.
 *
 * `page.json` is rebuilt from the definition's own sections, so a page written
 * by an earlier build (or by hand) opens with the same file the agent would
 * have written itself.
 */
export const projectFromDefinition = (
  definition: PageDefinition,
  page: { id: string; name: string; description?: string },
): PageProjectState => ({
  files: {
    ...Object.fromEntries(eachPageFile(definition.code)),
    [PAGE_JSON_FILE]: JSON.stringify(
      {
        name: page.name,
        ...(page.description !== undefined && page.description !== ""
          ? { description: page.description }
          : {}),
        ...(definition.brief !== undefined ? { brief: definition.brief } : {}),
        variables: definition.variables,
        datasets: definition.datasets,
        operations: definition.operations,
        ...(definition.theme !== undefined ? { theme: definition.theme } : {}),
      },
      null,
      2,
    ),
  },
  seen: {},
  pageId: page.id,
});

/**
 * The working copy, as the `code` a compile and a write take.
 *
 * `page.json` is not code and never reaches the compiler: it is the same
 * information as the definition's sections, in the shape the agent edits.
 */
export const codeFromProject = (
  state: PageProjectState,
): { source: string; files?: Record<string, string> } => {
  const {
    [PAGE_ENTRY_FILE]: source,
    [PAGE_JSON_FILE]: _manifest,
    ...files
  } = state.files;
  return {
    source: source ?? "",
    ...(Object.keys(files).length > 0 ? { files } : {}),
  };
};

/**
 * Every file's path and content, entry first — the same order everything else
 * walks a page in, so a hash taken here matches one taken from a definition.
 */
export const projectFiles = (state: PageProjectState): [string, string][] =>
  eachPageFile(codeFromProject(state));

/**
 * `Bun.hash` is out for anything persisted (its seed is per-process). This
 * outlives the process in Redis and is compared against a stored build.
 */
export const hashFileContent = (content: string): string =>
  new Bun.CryptoHasher("sha256").update(content).digest("hex").slice(0, 16);

export const hashProjectFiles = (files: [string, string][]): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const [path, content] of files) hasher.update(`${path}\0${content}\0`);
  return hasher.digest("hex");
};
