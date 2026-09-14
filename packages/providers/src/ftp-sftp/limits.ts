/**
 * Ceilings on what one call may move. Shared by the manifest (so the agent
 * reads them in the SKILL and plans inside them) and the handlers (so a
 * plan that ignores them is refused with the same numbers).
 *
 * Every transfer crosses the sandbox boundary as base64 inside a JSON body,
 * which is what the numbers are calibrated on — not on what the file server
 * can serve. A download travels backend → `/sandbox/exec` response → Python
 * `json.loads`; an upload travels the other way AND is stored verbatim in
 * the approval row until the user decides. base64 costs a third on top, so
 * 25 MB of files is ~34 MB on the wire.
 *
 * They are generous for the traffic this provider actually sees — EDI
 * payloads, CSV feeds, invoices and label PDFs are kilobytes to a few
 * megabytes. A genuinely large transfer is a job for a scheduled workflow
 * moving one file at a time, not for a chat turn.
 */

export const MAX_DOWNLOAD_FILES = 20;
export const MAX_DOWNLOAD_TOTAL_MB = 25;
export const MAX_DOWNLOAD_TOTAL_BYTES = MAX_DOWNLOAD_TOTAL_MB * 1024 * 1024;

/**
 * Uploads are capped tighter than downloads: their bytes are persisted in
 * `tool_approval_requests.payload` while the plan waits for a human, so the
 * cost is a database row rather than a transient response body.
 */
export const MAX_UPLOAD_FILES = 20;
export const MAX_UPLOAD_TOTAL_MB = 20;
export const MAX_UPLOAD_TOTAL_BYTES = MAX_UPLOAD_TOTAL_MB * 1024 * 1024;

/** Entries a single `get_entries` / `move_entries` / `delete_files` call takes. */
export const MAX_BATCH_PATHS = 200;

/**
 * Hard stop on a recursive walk, independent of the caller's `limit`. A
 * tree the agent cannot see the size of is exactly the one that turns a
 * `find_files` into thousands of round-trips.
 */
export const MAX_WALK_RESULTS = 1000;
export const MAX_WALK_DIRECTORIES = 500;
