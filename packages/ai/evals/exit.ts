/**
 * Exit a runner without throwing its report away.
 *
 * `process.exit()` does not drain stdout. When stdout is a TTY that is
 * invisible — writes land synchronously — but every *captured* run redirects it
 * to a pipe or a file, where writes are buffered, and the exit discards
 * whatever has not been flushed. Measured 2026-09-10 on `evals:recall`: a
 * 23-case × 10-repeat run piped to a file kept 82 lines and lost the whole
 * tail, `TOTAL:` and `BIMODAL:` included — the two lines the RUNBOOK says to
 * read. The suite had passed; nothing in the capture said so.
 *
 * An empty write's callback fires only once the writes queued before it have
 * drained, so awaiting it is enough.
 */
export const exitAfterFlush = async (code: number): Promise<never> => {
  await new Promise<void>((resolve) => {
    process.stdout.write("", () => {
      resolve();
    });
  });
  process.exit(code);
};
