/**
 * Routes AI SDK warnings through our own logger — and, as the deliberate side
 * effect, silences one provider line we cannot act on.
 *
 * `@openrouter/ai-sdk-provider@3.0.0` drops reasoning_details entries that
 * arrive without a thought signature (Gemini/Anthropic replay would be
 * rejected otherwise — its issues #423/#418) and warns about it on EVERY
 * affected step. On a page builder whose model reasons — `gemini-3.7-flash`
 * when this was measured on the 2026-08-22/23 eval runs, `zai-glm-5-3-flash`
 * since — that is a warning per builder step, dozens per page build, drowning
 * the console. The signatures are lost in the provider's own
 * stream handling; there is no released fix and nothing on our side to change.
 *
 * The provider skips its `console.warn` whenever `AI_SDK_LOG_WARNINGS` is a
 * function — it never calls the function. The AI SDK core DOES call it, so
 * forwarding to `console.warn` here keeps every core warning visible while
 * that one provider line goes quiet. Delete this module when the provider
 * ships signature-preserving streaming (watch its releases past 3.0.0).
 *
 * Checked against 3.1.0 (2026-09-20): still not shipped. That release is
 * additive — `decisionModel()`/`evaluationModel()` on the Decisions API, plus
 * `decisionsBaseURL` — and the two reasoning fixes worth knowing about landed
 * EARLIER and are already in 3.0.0: #477 stopped reasoning-delta frames from
 * each carrying a full accumulated `reasoning_details` snapshot (2.7.0, the
 * O(N²) payload), and #487 kept an empty `reasoning_details` array instead of
 * dropping it (2.8.1) — which is the one that matters here, since DeepSeek V4
 * in thinking mode serves our `chat` binding and 4xxs the follow-up turn when
 * that array goes missing.
 */
const forward = (warnings: unknown): void => {
  if (Array.isArray(warnings)) {
    for (const warning of warnings) {
      console.warn("[ai-sdk]", warning);
    }
    return;
  }
  console.warn("[ai-sdk]", warnings);
};

Reflect.set(globalThis, "AI_SDK_LOG_WARNINGS", forward);
