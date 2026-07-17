# Per-family system-prompt overlays

`<promptOverlayKey>.md` files here are spliced at the END of the chatbot
system prompt's static prefix (above the DYNAMIC SUFFIX marker) when the
serving profile declares `assessment.promptOverlayKey` in
`src/lib/model-registry/profiles.ts`.

Rules:

- **Start empty.** Write an overlay only when a C3 eval failure
  demonstrates a family-specific need (tool-call formatting quirk,
  "respond directly" calibration, …). Growth without sharpening is a
  regression (`.agent/agent-context-framework.md` applies — this is
  agent-facing prose).
- One overlay per FAMILY, not per model. Keep it under ~15 lines.
- Cache-safe by construction: prompt caches are namespaced per upstream
  model and the overlay is deterministic per profile — but NEVER put a
  `{{placeholder}}` in an overlay (it would be substituted per turn and
  break the static prefix).
