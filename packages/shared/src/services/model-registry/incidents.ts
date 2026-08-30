import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import db from "../../db";
import { modelProviderIncidents } from "../../db/schema/model-registry";
import { normalizeProviderName } from "../../model-registry/provider-names";
import type { IncidentKind, TransportId } from "../../model-registry/types";

/**
 * Runtime evidence that an upstream is misbehaving.
 *
 * ONE ROW PER GENERATION PER KIND. The detectors accumulate everything they see
 * inside a single stream and file once at the end, with the occurrence count in
 * the evidence. That is not a size optimisation — it is what makes the
 * breaker's corroboration rule exact: a threshold of "three incidents" means
 * three separate generations, so a single pathological answer can never trip a
 * quarantine on its own, and no `generationId` has to be present for the count
 * to be trustworthy.
 *
 * `evidence` carries codepoints, counts and finish reasons — never the text
 * that carried them. These streams are customer documents and conversations; a
 * corruption detector is not a licence to copy them into an infra table.
 */

export interface RecordIncidentInput {
  /** Profile key when known, else the raw model id (the bypass call sites). */
  modelKey: string;
  /** Upstream name as the transport reported it; normalised on the way in. */
  provider: string;
  transport: TransportId;
  kind: IncidentKind;
  evidence?: Record<string, number | string>;
  generationId?: string;
  traceId?: string;
  role?: string;
}

export const recordProviderIncident = async (
  input: RecordIncidentInput,
): Promise<string | undefined> => {
  const provider = normalizeProviderName(input.provider);
  if (provider.length === 0) return undefined;
  const [row] = await db
    .insert(modelProviderIncidents)
    .values({
      modelKey: input.modelKey,
      provider,
      transport: input.transport,
      kind: input.kind,
      evidence: input.evidence ?? null,
      generationId: input.generationId ?? null,
      traceId: input.traceId ?? null,
      role: input.role ?? null,
    })
    .returning({ id: modelProviderIncidents.id });
  return row?.id;
};

/**
 * How many distinct generations hit this (model, provider, kind) inside the
 * window — the breaker's only question.
 */
export const countRecentIncidents = async (input: {
  modelKey: string;
  provider: string;
  kind: IncidentKind;
  windowMinutes: number;
  now: Date;
}): Promise<number> => {
  const cutoff = new Date(input.now.getTime() - input.windowMinutes * 60_000);
  const [row] = await db
    .select({ total: count() })
    .from(modelProviderIncidents)
    .where(
      and(
        eq(modelProviderIncidents.modelKey, input.modelKey),
        eq(
          modelProviderIncidents.provider,
          normalizeProviderName(input.provider),
        ),
        eq(modelProviderIncidents.kind, input.kind),
        gt(modelProviderIncidents.createdAt, cutoff),
      ),
    );
  return row?.total ?? 0;
};

/** Ids of the incidents that met a threshold, so a quarantine stays auditable. */
export const recentIncidentIds = async (input: {
  modelKey: string;
  provider: string;
  kind: IncidentKind;
  windowMinutes: number;
  now: Date;
  limit?: number;
}): Promise<string[]> => {
  const cutoff = new Date(input.now.getTime() - input.windowMinutes * 60_000);
  const rows = await db
    .select({ id: modelProviderIncidents.id })
    .from(modelProviderIncidents)
    .where(
      and(
        eq(modelProviderIncidents.modelKey, input.modelKey),
        eq(
          modelProviderIncidents.provider,
          normalizeProviderName(input.provider),
        ),
        eq(modelProviderIncidents.kind, input.kind),
        gt(modelProviderIncidents.createdAt, cutoff),
      ),
    )
    .limit(input.limit ?? 20);
  return rows.map((r) => r.id);
};

/** Total incidents on a model in the last 24 h — the health score's own-traffic term. */
export const countIncidentsForModel = async (
  modelKey: string,
  now: Date,
): Promise<number> => {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60_000);
  const [row] = await db
    .select({ total: count() })
    .from(modelProviderIncidents)
    .where(
      and(
        eq(modelProviderIncidents.modelKey, modelKey),
        gt(modelProviderIncidents.createdAt, cutoff),
      ),
    );
  return row?.total ?? 0;
};

/**
 * Incident counts for MANY models in ONE grouped query.
 *
 * The hub renders every model on the page, so the per-model reader above would
 * be one round trip per card — 139 of them on the current fleet, on a request a
 * team makes every time it opens its settings. Models with no incidents are
 * absent from the result rather than present with a zero; the caller reads a
 * missing key as none, which is what it means.
 */
export const countIncidentsForModels = async (
  modelKeys: readonly string[],
  windowHours: number,
  now: Date,
): Promise<Map<string, number>> => {
  if (modelKeys.length === 0) return new Map();
  const cutoff = new Date(now.getTime() - windowHours * 60 * 60_000);
  const rows = await db
    .select({ modelKey: modelProviderIncidents.modelKey, total: count() })
    .from(modelProviderIncidents)
    .where(
      and(
        inArray(modelProviderIncidents.modelKey, [...modelKeys]),
        gt(modelProviderIncidents.createdAt, cutoff),
      ),
    )
    .groupBy(modelProviderIncidents.modelKey);
  return new Map(rows.map((row) => [row.modelKey, row.total]));
};

/** Per-(provider, kind) incident counts on one model, for the admin scorecard. */
export const summarizeIncidents = async (input: {
  modelKey: string;
  windowHours: number;
  now: Date;
}): Promise<{ provider: string; kind: IncidentKind; total: number }[]> => {
  const cutoff = new Date(
    input.now.getTime() - input.windowHours * 60 * 60_000,
  );
  const rows = await db
    .select({
      provider: modelProviderIncidents.provider,
      kind: modelProviderIncidents.kind,
      total: count(),
    })
    .from(modelProviderIncidents)
    .where(
      and(
        eq(modelProviderIncidents.modelKey, input.modelKey),
        gt(modelProviderIncidents.createdAt, cutoff),
      ),
    )
    .groupBy(modelProviderIncidents.provider, modelProviderIncidents.kind)
    .orderBy(sql`count(*) desc`);
  return rows;
};
