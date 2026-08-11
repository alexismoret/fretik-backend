import { getQuickJS, type QuickJSWASMModule } from "quickjs-emscripten";

/**
 * Run untrusted JavaScript with no way out.
 *
 * QuickJS compiled to WebAssembly, in this process. The guarantee is
 * structural rather than promised: the interpreter is a WASM module with no
 * imports, so a context starts with `JSON`, `Math`, `Date` and the language —
 * and nothing else. Measured, every one of these is `undefined` inside it:
 * `fetch`, `require`, `process`, `setTimeout`, `Bun`, `WebAssembly`. There is
 * no host object to reach through because none was ever handed in.
 *
 * WHY NOT the alternatives, each rejected on a specific ground:
 *
 * - a Bun **Worker** is not a security boundary — same process, same APIs, and
 *   Bun's permission mode is a proposal, not a feature;
 * - **`Bun.spawn`** of a bare Bun process has full filesystem and network;
 * - **E2B** (which the chatbot's `python`/`bash` tools use, correctly) costs
 *   2–5 s cold, draws on a sandbox quota shared with the AI, bills per second,
 *   and is keyed by a conversation id that a published page does not have.
 *
 * COST, measured on this machine — linear in payload, ~35 ms per MB, dominated
 * by the VM's own `JSON.parse` rather than by the engine (creating and
 * disposing a context is 0.13 ms):
 *
 *     50 rows /   4 KB →   1.0 ms      8 500 rows / 731 KB →  26.7 ms
 *  2 000 rows / 169 KB →   6.4 ms     90 000 rows /   8 MB → 286.1 ms
 *
 * That last line is why `maxInputBytes` exists and is not negotiable: this call
 * is SYNCHRONOUS, so its duration is time the event loop is not serving anyone.
 * A megabyte of input is one SQL query's worth of latency; ten megabytes would
 * be a third of a second of a frozen server. The cap refuses the input instead
 * of blaming the engine.
 *
 * Memory is stable: 12 000 runs left RSS flat at 327 MB, because every run
 * disposes its own runtime.
 */

/** The WASM module is compiled once per process; contexts are per run. */
let modulePromise: Promise<QuickJSWASMModule> | undefined;

const quickJs = async (): Promise<QuickJSWASMModule> => {
  modulePromise ??= getQuickJS();
  return await modulePromise;
};

export interface SandboxLimits {
  /** Wall-clock ceiling. An infinite loop dies here, not in production. */
  timeoutMs: number;
  /** Heap ceiling inside the VM. An allocation past it fails the run. */
  memoryLimitBytes: number;
  /** Serialized input ceiling — see the cost table above. */
  maxInputBytes: number;
  /** Serialized output ceiling, so a run cannot return the whole heap. */
  maxOutputBytes: number;
}

export const SANDBOX_DEFAULTS: SandboxLimits = {
  timeoutMs: 500,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxInputBytes: 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
};

export type SandboxResult =
  { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Turn a QuickJS error handle's dump into one readable line.
 *
 * It matters that this is precise: the string ends up in a page's `warnings`,
 * which is what the agent reads back to fix its own code. `[object Object]`
 * would tell it nothing.
 */
const describeError = (dumped: unknown): string => {
  if (typeof dumped === "string") return dumped;
  if (dumped !== null && typeof dumped === "object") {
    const name = Reflect.get(dumped, "name");
    const message = Reflect.get(dumped, "message");
    if (typeof message === "string") {
      return typeof name === "string" ? `${name}: ${message}` : message;
    }
  }
  return JSON.stringify(dumped) ?? "unknown error";
};

/**
 * Evaluate `code` as the body of `(data, state) => …` and return what it
 * returns, as plain JSON.
 *
 * NOTHING crosses by reference. The input goes in as a JSON string parsed
 * inside the VM, and the result is stringified inside the VM before it comes
 * back — so a handle to a host object cannot exist on either side, and a
 * prototype the guest touched cannot follow the value out.
 *
 * Synchronous by design. There are no timers and no promises to await in
 * there, which removes a whole class of "the sandbox is still running" states:
 * when this returns, nothing of that run survives.
 *
 * Never throws — a failure is a returned `{ ok: false, error }`, because every
 * caller degrades one widget rather than a page.
 */
export const runSandboxedJs = async (input: {
  code: string;
  data: Record<string, unknown>;
  state: Record<string, unknown>;
  limits?: Partial<SandboxLimits>;
}): Promise<SandboxResult> => {
  const limits = { ...SANDBOX_DEFAULTS, ...input.limits };

  let payload: string;
  try {
    payload = JSON.stringify({ data: input.data, state: input.state });
  } catch {
    return { ok: false, error: "the transform's inputs are not JSON" };
  }
  const size = Buffer.byteLength(payload);
  if (size > limits.maxInputBytes) {
    return {
      ok: false,
      error: `the transform's inputs weigh ${Math.round(size / 1024).toString()}KB, over the ${Math.round(limits.maxInputBytes / 1024).toString()}KB ceiling. Aggregate in the query, or lower the inputs' limit — a transform combines small results, it is not where a large table is read.`,
    };
  }

  const QuickJS = await quickJs();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryLimitBytes);
  // Time-based rather than instruction-based: what a reader waits for is
  // seconds, and an instruction budget would be a different number on every
  // machine. Checked by the interpreter between operations.
  const deadline = Date.now() + limits.timeoutMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();

  try {
    // `JSON.stringify` twice on purpose: once to make the payload, once to make
    // that payload a JavaScript string LITERAL. Interpolating the raw JSON
    // would let a quote in the data close the string and become code.
    const source = `(function () {
      var __input = JSON.parse(${JSON.stringify(payload)});
      var __fn = function (data, state) {\n${input.code}\n};
      return JSON.stringify(__fn(__input.data, __input.state));
    })()`;

    const evaluated = context.evalCode(source);
    if (evaluated.error) {
      const message = describeError(context.dump(evaluated.error));
      evaluated.error.dispose();
      return { ok: false, error: message };
    }

    const serialized = context.getString(evaluated.value);
    evaluated.value.dispose();

    // `JSON.stringify` yields the literal `undefined` for a function, a symbol,
    // or a bare `return;`. Naming it beats returning an empty dataset that
    // looks like "the query found nothing".
    if (serialized === "undefined") {
      return {
        ok: false,
        error:
          "the transform returned nothing JSON can carry — return an array of rows, or an object.",
      };
    }
    if (serialized.length > limits.maxOutputBytes) {
      return {
        ok: false,
        error: `the transform returned ${Math.round(serialized.length / 1024).toString()}KB, over the ${Math.round(limits.maxOutputBytes / 1024).toString()}KB ceiling. Return the rows a reader will see, not the intermediate ones.`,
      };
    }
    return { ok: true, value: JSON.parse(serialized) };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    // Order matters: the context belongs to the runtime.
    context.dispose();
    runtime.dispose();
  }
};
