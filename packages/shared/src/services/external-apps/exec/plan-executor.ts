import type {
  ToolApprovalOpResult,
  ToolApprovalRequest,
} from "../../../db/schema";
import { isRecord } from "../../../external-apps/json-access";
import { getAction } from "../../../external-apps/registry";
import { markConsumed, updatePartialResult } from "../../approvals/complete";
import { resolveConnection } from "../connections/resolve";
import { buildRequest } from "./build-request";
import { callCustomHandler } from "./call-custom-handler";
import { extractFrameworkArgs } from "./framework-args";
import { callHttpDirect } from "./http-direct";
import { callNangoProxy } from "./nango-proxy";

/**
 * Execute every operation of a granted (now `executing`) approval, with
 * bounded concurrency and incremental result persistence.
 *
 *  - Concurrency 3 — enough to amortise Microsoft Graph round-trips on
 *    bulk operations (50 emails ≈ 5s instead of 25s), low enough to
 *    avoid tripping provider rate limits.
 *  - `result` is written after EVERY completed op, so a process crash
 *    mid-plan leaves a partial result on the row. A re-run lands on
 *    `executing`, the dispatcher surfaces `EXTERNAL_APP_PLAN_EXECUTING`
 *    with the partial trace, never a silent NULL.
 *  - On all-done, `markConsumed` transitions the row to its terminal
 *    state with the full result attached.
 */

const CONCURRENCY = 3;

export const executePlan = async (params: {
  approval: ToolApprovalRequest;
  teamId: string;
  userId: string;
}): Promise<ToolApprovalOpResult[]> => {
  // `operations` is nullable on the row (only `external_app_plan` rows set it);
  // this executor is only ever called for that kind, so a null here is a bug.
  const operations = params.approval.operations ?? [];
  const results: (ToolApprovalOpResult | null)[] = Array.from(
    { length: operations.length },
    () => null,
  );

  const runOne = async (index: number): Promise<void> => {
    const op = operations[index];
    if (op === undefined) return;
    try {
      const resolved = getAction(op.action);
      if (resolved === undefined) {
        results[index] = {
          ok: false,
          error: `Unknown action: ${op.action}`,
        };
        return;
      }
      const { framework, action: cleanArgs } = extractFrameworkArgs(op.args);
      const connection = await resolveConnection({
        providerKey: resolved.providerKey,
        teamId: params.teamId,
        userId: params.userId,
        explicitId: framework.connection_id,
      });

      let data: unknown;
      if (resolved.transport.kind === "nango-proxy") {
        const req = buildRequest(resolved, cleanArgs);
        const raw = await callNangoProxy({
          providerConfigKey: connection.nangoProviderConfigKey,
          connectionId: connection.nangoConnectionId,
          method: req.method,
          endpoint: req.endpoint,
          query: req.query,
          body: req.body,
        });
        data =
          resolved.responseMapper !== undefined
            ? resolved.responseMapper(raw)
            : raw;
      } else if (resolved.transport.kind === "http-direct") {
        const req = buildRequest(resolved, cleanArgs);
        const raw = await callHttpDirect({
          manifest: resolved.manifest,
          transport: resolved.transport,
          providerConfigKey: connection.nangoProviderConfigKey,
          connectionId: connection.nangoConnectionId,
          method: req.method,
          endpoint: req.endpoint,
          query: req.query,
          body: req.body,
        });
        data =
          resolved.responseMapper !== undefined
            ? resolved.responseMapper(raw)
            : raw;
      } else {
        if (resolved.handler === undefined) {
          results[index] = {
            ok: false,
            error: `Action ${op.action} has no handler registered`,
          };
          return;
        }
        data = await callCustomHandler({
          manifest: resolved.manifest,
          providerConfigKey: connection.nangoProviderConfigKey,
          connectionId: connection.nangoConnectionId,
          handler: resolved.handler,
          args: cleanArgs,
        });
      }
      const safeData: Record<string, unknown> = isRecord(data)
        ? data
        : { value: data };
      results[index] = { ok: true, data: safeData };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results[index] = { ok: false, error: message };
    } finally {
      // Persist what we have so far — partial result survives a crash.
      const snapshot = results.filter(
        (r): r is ToolApprovalOpResult => r !== null,
      );
      await updatePartialResult(params.approval.id, snapshot);
    }
  };

  // Worker pool: each worker pulls the next index until exhausted.
  // Parallelism is between workers (Promise.all below); each worker
  // is sequential by design, hence the await inside the while loop.
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= operations.length) return;
      // eslint-disable-next-line no-await-in-loop -- worker-pool pattern
      await runOne(index);
    }
  });
  await Promise.all(workers);

  const finalResults: ToolApprovalOpResult[] = results.map(
    (r) => r ?? { ok: false, error: "operation skipped" },
  );
  await markConsumed(params.approval.id, finalResults);
  return finalResults;
};
