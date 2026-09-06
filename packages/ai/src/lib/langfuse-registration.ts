/**
 * Register the Langfuse tracing plumbing once per PROCESS, not once per module
 * evaluation.
 *
 * `bun run --hot` — how this service runs in dev — does not restart the
 * process. It re-evaluates the changed module and everything that imports it,
 * and Bun's own documentation is explicit about what survives: "Bun
 * re-evaluates all files, but global state (notably, the `globalThis` object)
 * persists". Both registrations this module guards write to exactly that
 * global state, and neither is idempotent:
 *
 *   - `registerTelemetry()` PUSHES onto `globalThis.AI_SDK_TELEMETRY_INTEGRATIONS`.
 *     A second integration does not replace the first; it exports every AI SDK
 *     model call a second time, under a second span id. Langfuse v4 ingests
 *     both — "v4 does not reliably deduplicate repeated records on the read
 *     path" — so N reloads make every generation, every tool call and every
 *     step appear N times, and every cost summed from them N times too high.
 *   - `NodeTracerProvider.register()` refuses a SECOND global provider. The
 *     new `LangfuseSpanProcessor` is then attached to nothing, while the
 *     module's exported handle points at it: the first processor keeps
 *     exporting, and `flushLangfuse()` flushes an orphan. Turn-end flushes
 *     stop working after the first reload, silently.
 *
 * Measured 2026-09-05: an eval run against a dev process that had hot-reloaded
 * 21 times reported 129.50 $ over 13 turns. The real figure was 5.89 $. Every
 * child observation was exactly ×22; the root (`startActiveObservation`) and
 * the `page-write` events (Langfuse client, not OTel) were ×1, which is how
 * the fan-out was noticed at all. Two code changes and two days of diagnosis
 * had been argued from the inflated numbers.
 *
 * The guard is a slot on `globalThis`, because that is the only thing at the
 * same lifetime as the registrations it protects.
 */

/**
 * The handle a registration keeps: the span processor actually attached to the
 * live tracer provider, and therefore the only one whose `forceFlush` reaches
 * Langfuse.
 *
 * Structural on purpose. `LangfuseSpanProcessor` satisfies it and so does a
 * plain object, so the guard is testable without a Langfuse credential — and
 * flushing is the whole of what the rest of the process needs from it.
 */
export interface LangfuseFlushHandle {
  forceFlush: () => Promise<void>;
}

/** What survives a hot reload. */
export interface LangfuseRegistration {
  processor: LangfuseFlushHandle;
}

declare global {
  var fretikLangfuseRegistration: LangfuseRegistration | undefined;
}

/**
 * The slice of `globalThis` this guard reads and writes.
 *
 * `AI_SDK_TELEMETRY_INTEGRATIONS` is declared by the AI SDK as
 * `Telemetry[] | undefined`; only its LENGTH is read here, and typing it that
 * way keeps this module free of an SDK import and lets a test pass a count.
 */
export interface TelemetryGlobals {
  AI_SDK_TELEMETRY_INTEGRATIONS?: { length: number } | undefined;
  fretikLangfuseRegistration?: LangfuseRegistration | undefined;
}

/** What the caller builds, and what installing it does. Run at most once. */
export interface LangfuseWiring {
  registration: LangfuseRegistration;
  install: () => void;
}

export interface RegistrationOutcome {
  registration: LangfuseRegistration;
  /** True when a previous evaluation of the caller had already installed. */
  reused: boolean;
  /**
   * How many AI SDK telemetry integrations are registered process-wide, read
   * AFTER installing. Anything but 1 means every model call is exported that
   * many times — the boot line prints it so the number is visible before a
   * cost is read from it.
   */
  integrations: number;
}

/**
 * Install `wire()` unless a previous module evaluation already did.
 *
 * `wire` is a factory rather than a value so that a reload constructs nothing:
 * a second `LangfuseSpanProcessor` is not just wasted, it is the orphan
 * described above.
 */
export const registerLangfuseOnce = (
  globals: TelemetryGlobals,
  wire: () => LangfuseWiring,
): RegistrationOutcome => {
  const existing = globals.fretikLangfuseRegistration;
  if (existing !== undefined) {
    return {
      registration: existing,
      reused: true,
      integrations: globals.AI_SDK_TELEMETRY_INTEGRATIONS?.length ?? 0,
    };
  }
  const wiring = wire();
  wiring.install();
  globals.fretikLangfuseRegistration = wiring.registration;
  return {
    registration: wiring.registration,
    reused: false,
    integrations: globals.AI_SDK_TELEMETRY_INTEGRATIONS?.length ?? 0,
  };
};
