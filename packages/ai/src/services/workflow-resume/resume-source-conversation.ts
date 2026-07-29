import db from "@fretik/shared/db";
import { redis } from "@fretik/shared/lib/redis";
import {
  clearConversationActiveStream,
  setConversationActiveStream,
} from "@fretik/shared/services/ai/active-stream";
import { publishConversationEvent } from "@fretik/shared/services/ai/conversation-events";
import {
  loadConversationForAgent,
  saveMessage,
} from "@fretik/shared/services/ai/messages";
import { countTestRuns } from "@fretik/shared/services/workflows/count-test-runs";
import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import { randomUUIDv7 } from "bun";
import {
  getChatbotAgentSet,
  type ChatbotCallOptions,
} from "../../agents/chatbot";
import { runChatbotTurn } from "../../handlers/chatbot";
import {
  resolveChatModelForProfile,
  resolveFlagshipProfileKey,
} from "../../lib/model-registry/resolve";

/** Hidden-message kind — mirrored by the frontend's hidden-kinds filter. */
const CONTINUATION_KIND = "workflow-run-continuation";

/** One resume per run, across racing terminal paths and replicas. */
const resumeLockKey = (runId: string): string => `workflow:resume:${runId}`;

/**
 * Resume the CHAT conversation that launched a test run, once the run is
 * terminal: persist a hidden user-role continuation message (the counterpart
 * of the frontend's `approval-continuation`) and drive one full chatbot turn
 * on it, so the builder analyzes the outcome and iterates or activates —
 * without the user having to say "continue".
 *
 * Fire-and-forget from the run's terminal paths, AFTER
 * `notifySourceConversation` reports it posted the notice (the exactly-once
 * anchor); a Redis NX lock belts-and-braces the check-then-insert race. Every
 * bail is silent by design: the notice is already visible in the chat, so the
 * user can always resume manually — this function must never fail a finalize.
 */
export const resumeSourceConversation = async (params: {
  runId: string;
}): Promise<void> =>
  // Detach from the RUN's tracing context. This is called from the run's
  // terminal path, and OTel propagates context across async continuations —
  // so the chat turn nested under the run's `workflow-turn` span: one merged
  // trace, relabelled with the chat's session, the run's cost billed to the
  // chat, and no way to look a run up by its own conversation. Two units of
  // work, two traces.
  context.with(ROOT_CONTEXT, () => runResume(params));

const runResume = async (params: { runId: string }): Promise<void> => {
  const { runId } = params;
  const locked = await redis.set(resumeLockKey(runId), "1", "EX", 3600, "NX");
  if (locked !== "OK") return;

  const run = await db.query.workflowRuns.findFirst({
    where: { id: runId },
    columns: {
      sourceConversationId: true,
      workflowId: true,
      status: true,
      outputSummary: true,
      error: true,
      isTest: true,
      triggeredByUserId: true,
      usage: true,
      startedAt: true,
      finishedAt: true,
    },
  });
  if (!run?.sourceConversationId) return;
  const conversationId = run.sourceConversationId;

  const conversation = await db.query.aiConversations.findFirst({
    where: { id: conversationId },
    columns: {
      id: true,
      organizationId: true,
      teamId: true,
      userId: true,
      agentType: true,
      modelProfileKey: true,
    },
  });
  if (!conversation || conversation.agentType !== "chatbot") return;

  const workflow = await db.query.workflows.findFirst({
    where: { id: run.workflowId },
    columns: { name: true },
  });

  // The run outcome, one line — per-task detail stays behind `get_run` so the
  // message never goes stale and stays tiny.
  const outcome =
    run.status === "failed" && run.error
      ? `${run.error.code}: ${run.error.message}`
      : (run.outputSummary?.trim() ?? "");
  const testsSoFar = run.sourceConversationId
    ? await countTestRuns({
        workflowId: run.workflowId,
        sourceConversationId: run.sourceConversationId,
      })
    : 0;
  // What the run just cost, on the header line — the builder decides whether
  // another round is worth it against a number, not a feeling. Tokens only,
  // never a currency amount: this message is visible in the conversation.
  const durationMs =
    run.startedAt && run.finishedAt
      ? run.finishedAt.getTime() - run.startedAt.getTime()
      : null;
  const weight = [
    ...(durationMs !== null && durationMs > 0
      ? [`${Math.max(1, Math.round(durationMs / 60_000)).toString()} min`]
      : []),
    ...(run.usage.totalTokens > 0
      ? [`${(run.usage.totalTokens / 1_000_000).toFixed(1)}M tokens`]
      : []),
  ].join(", ");
  const text = [
    `[workflow-run-finished] Test run ${runId} of workflow "${workflow?.name ?? "Workflow"}" ${run.status}. Test run #${testsSoFar.toString()} in this conversation${weight ? ` (${weight})` : ""}.`,
    ...(outcome ? [outcome] : []),
    // Until 2026-07-28 this said "download the run's output" — no tool could,
    // so the builder graded run after run on the summary the run wrote about
    // itself. `get_run` now materialises the deliverables under `runs/<id>/`.
    // Until 2026-07-29 it then said only "fix with update + run_test, or
    // activate" — no convergence rule, so a prod session re-ran a SUCCEEDED
    // run twice over number formats and data-inherent gaps (3 runs, ~30 min,
    // near-identical deliverables). The classification below is that rule.
    "FIRST call get_run — never judge the run from this summary alone. It returns `outputs` with a path per deliverable: OPEN the file and compare it to what was asked. When the conversation holds an example of the output, diff the two in `python` and print the first difference per column — comparing them by eye misses a decimal or an empty column every time. A run that produced no deliverable at all is itself a playbook defect — fix the playbook so it always delivers, with the values it could not establish left empty, rather than debating its report. THEN classify each gap you found: (a) playbook defect — the deliverable's structure or logic does not match what was asked → fix with update + run_test; (b) data gap — the input genuinely lacks the value, any correct run would leave that cell empty → report it as a finding, NEVER as a reason to re-run; (c) spec detail you could have stated upfront (a number format, a label, a sort order) → fold it into the playbook with update and move on WITHOUT a new test — the current deliverable already proves the logic. Deliverable structurally conform → activate now and report the (b)/(c) items alongside. When you update, tighten the existing task in place — appending validation tasks makes every future run longer, not better. A test run costs the user the time and tokens shown above; two rounds without convergence → show the user the remaining difference and ask. NEVER redo the run's work yourself in this chat — the deliverable is produced by the run, not here; reproducing it proves nothing about the workflow. The user has not spoken — only ask them when a decision genuinely needs their input.",
  ].join("\n");

  // Claim the turn slot BEFORE persisting the continuation: if a user turn is
  // mid-flight, degrade to notice-only (persisting the message anyway would
  // inject it into that turn's history unannounced).
  const streamId = randomUUIDv7();
  const claimed = await setConversationActiveStream(conversationId, streamId);
  if (!claimed) return;

  try {
    await saveMessage({
      conversationId,
      role: "user",
      parts: [{ type: "text", text }],
      metadata: {
        kind: CONTINUATION_KIND,
        runId,
        workflowId: run.workflowId,
        status: run.status,
      },
    });

    // Announce like a user POST /stream: every open tab fans in to the
    // resumable buffer. The empty `byUserId` matches no viewer, so nobody
    // skips the fan-in as "their own" turn.
    await publishConversationEvent(conversationId, {
      type: "turn-started",
      streamId,
      byUserId: "",
    });

    const history = await loadConversationForAgent(conversationId, 30);
    const actingUserId = run.triggeredByUserId ?? conversation.userId;
    const callOptions: ChatbotCallOptions = {
      organizationId: conversation.organizationId,
      teamId: conversation.teamId,
      conversationId,
      traceId: streamId,
      ...(actingUserId ? { userId: actingUserId } : {}),
    };
    const { profileKey } = resolveFlagshipProfileKey(
      conversation.modelProfileKey,
    );
    const response = await runChatbotTurn({
      conversationId,
      history,
      callOptions,
      resumableStreamId: streamId,
      logPrefix: "[chatbot.wf-resume]",
      agentSet: getChatbotAgentSet(profileKey),
      modelProfile: resolveChatModelForProfile(profileKey).profile,
    });
    // Drive the turn to completion server-side — nobody holds this Response.
    // The resumable tee + `onFinish` persist, clear the slot, and publish
    // `turn-ended` exactly as a user-facing turn does.
    if (response.body) {
      for await (const chunk of response.body) {
        void chunk;
      }
    }
  } catch (err) {
    console.error(
      `[chatbot.wf-resume] resume failed for run ${runId} (conversation ${conversationId}):`,
      err,
    );
    // The turn's own onFinish never ran — free the slot so the user (and
    // future runs) can start a turn; the notice is already in the chat.
    await clearConversationActiveStream(conversationId, streamId).catch(
      () => undefined,
    );
  }
};
