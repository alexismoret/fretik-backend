/**
 * The workers' env knobs, re-exported from where they now live.
 *
 * They moved to `@fretik/shared/lib/env` when the outgoing-call governor
 * started reading the same kind of knob from the API and the AI service. Kept
 * as a re-export because every worker in this package imports `./env`, and a
 * rename across them would be churn with no reader.
 */
export { boolFromEnv, intFromEnv } from "@fretik/shared/lib/env";
