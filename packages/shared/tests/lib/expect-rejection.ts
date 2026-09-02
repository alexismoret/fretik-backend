/**
 * The rejection, as a value.
 *
 * `expect(...).rejects.toThrow()` is typed as returning `void` in bun:test, so
 * awaiting it is a lint error (`await-thenable`) and not awaiting it lets the
 * test end before the promise settles — a refusal that never arrives is a green
 * test. Catching the rejection avoids both and hands the caller an `Error` to
 * assert on, which is itself part of several contracts here: these paths used
 * to `throw "a string"`.
 */
export const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error(`Expected an Error, got ${typeof err}: ${String(err)}`, {
      cause: err,
    });
  }
  throw new Error("Expected the call to be refused, but it resolved");
};
