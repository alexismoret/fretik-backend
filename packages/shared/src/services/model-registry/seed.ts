import { sql } from "drizzle-orm";
import db from "../../db";
import { modelLiveState } from "../../db/schema/model-registry";
import type {
  DisabledReason,
  PricingSnapshot,
  ProviderPoolByTransport,
  TransportId,
} from "../../model-registry/types";
import { invalidateLiveRegistry } from "./live";

/**
 * Seeding live state from the curated TypeScript registry.
 *
 * The caller lives in `@fretik/ai` (this package cannot see the profiles) and
 * hands over one seed per profile at boot. What matters here is WHICH FIELDS a
 * re-seed is allowed to touch, because the two layers own different things and
 * a boot must not undo a decision the engine took at 3 a.m.
 *
 * Refreshed on every seed — curation owns them, so a merged pull request takes
 * effect on the next deploy:
 *   `modelIds`, `providerPool`, `boundRoles`.
 *
 * Written once, on INSERT only — the runtime owns them afterwards:
 *   `transport` (a rollback must survive a restart), `enabled`, `pricing`,
 *   `effectiveContextLength`, `effectiveMaxOutput`.
 *
 * Never touched here at all: quarantines, `poolWidened`, `lastResort`, health,
 * policy reports, streaks.
 *
 * Curation can still disable a model instantly without a write: the resolver
 * ANDs the profile's own `enabled` with this row's, so `enabled: false` in
 * TypeScript wins on deploy while an automatic disable persists in the row.
 * Neither layer can force the other to enable.
 */

export interface LiveStateSeed {
  profileKey: string;
  transport: TransportId;
  enabled: boolean;
  disabledReason?: DisabledReason;
  modelIds: Partial<Record<TransportId, string>>;
  providerPool: ProviderPoolByTransport;
  /** Catalogue context minus a margin, until the first sync measures the pool. */
  effectiveContextLength: number;
  effectiveMaxOutput?: number;
  /** Hand-curated price, replaced by the pool median on the first sync. */
  pricing: PricingSnapshot;
  /** Internal roles bound to this profile — non-empty means the fleet needs it. */
  boundRoles: string[];
}

export const seedLiveState = async (
  seeds: readonly LiveStateSeed[],
): Promise<{ inserted: number; refreshed: number }> => {
  if (seeds.length === 0) return { inserted: 0, refreshed: 0 };

  const before = await db
    .select({ profileKey: modelLiveState.profileKey })
    .from(modelLiveState);
  const existing = new Set(before.map((row) => row.profileKey));

  await db
    .insert(modelLiveState)
    .values(
      seeds.map((seed) => ({
        profileKey: seed.profileKey,
        status: "published" as const,
        transport: seed.transport,
        enabled: seed.enabled,
        disabledReason: seed.disabledReason ?? null,
        modelIds: seed.modelIds,
        providerPool: seed.providerPool,
        effectiveContextLength: seed.effectiveContextLength,
        effectiveMaxOutput: seed.effectiveMaxOutput ?? null,
        pricing: seed.pricing,
        boundRoles: seed.boundRoles,
        source: "seed" as const,
      })),
    )
    .onConflictDoUpdate({
      target: modelLiveState.profileKey,
      set: {
        modelIds: sql`excluded.model_ids`,
        providerPool: sql`excluded.provider_pool`,
        boundRoles: sql`excluded.bound_roles`,
      },
    });

  await invalidateLiveRegistry();
  const inserted = seeds.filter((s) => !existing.has(s.profileKey)).length;
  return { inserted, refreshed: seeds.length - inserted };
};
