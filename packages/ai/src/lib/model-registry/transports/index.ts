import type { TransportId } from "@fretik/shared/model-registry/types";
import { gatewayAdapter } from "./gateway";
import { createOpenRouterAdapter, type EnvelopeForRole } from "./openrouter";
import { scalewayAdapter } from "./scaleway";
import type { GenerationReport, TransportAdapter } from "./types";

/**
 * The transport registry.
 *
 * Adding a transport is a file implementing `TransportAdapter` plus an entry
 * here — nothing in the resolver, the model registry or the picker changes.
 * `scaleway` was the proof: it is a direct provider rather than an aggregator,
 * and it landed without touching any of the three.
 *
 * One remains declared in the shared vocabulary and not built: `custom`, a base
 * URL and token a team supplies for self-hosted or on-premise models. Its
 * credentials belong in a per-team table rather than in the environment, which
 * is the one piece of design it still needs.
 */
export const createTransportRegistry = (
  envelopeForRole: EnvelopeForRole,
): ReadonlyMap<TransportId, TransportAdapter> =>
  new Map<TransportId, TransportAdapter>([
    ["gateway", gatewayAdapter],
    ["openrouter", createOpenRouterAdapter(envelopeForRole)],
    ["scaleway", scalewayAdapter],
  ]);

/**
 * Read cost and serving provider out of a response without knowing which
 * transport produced it.
 *
 * Both namespaces are tried because a single process serves both at once:
 * during a migration the same Langfuse trace list contains generations from
 * either, and telemetry that only understands one of them silently reports no
 * cost for half the fleet.
 */
export const extractGenerationReport = (
  metadata: unknown,
  adapters: Iterable<TransportAdapter>,
): GenerationReport => {
  for (const adapter of adapters) {
    const report = adapter.extractReport(metadata);
    if (report.costUsd !== undefined || report.servingProvider !== undefined)
      return report;
  }
  return {};
};

export type { GenerationReport, TransportAdapter } from "./types";
