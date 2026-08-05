/**
 * Hard per-repeat deadline for the eval runners — turns a wedged repeat into a
 * measured `hung:` failure instead of a silently frozen run.
 *
 * Why it exists: run `bakeoff-deepseek-v2` (2026-08-03) froze for ~2.5 h at
 * 0 % CPU between two cases. The pending call was a `generateText` carrying an
 * ARMED `AbortSignal.timeout(120_000)` that never fired. Whatever the exact
 * mechanism, a deadline whose timer lives in a local the runner holds until
 * settlement cannot be skipped the same way.
 *
 * The losing promise is orphaned, not cancelled — its side effects (an episode
 * row, a vector) may still land later. Acceptable in a harness: fixtures are
 * rebuilt per case and stray writes are what `--cleanup` sweeps.
 */
export const raceDeadline = async <T>(
  run: () => Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `hung: ${label} still pending after ${(ms / 1000).toString()}s — killed by the eval watchdog`,
            ),
          );
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
