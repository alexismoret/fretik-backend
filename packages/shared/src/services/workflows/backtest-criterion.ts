import { and, desc, eq, inArray } from "drizzle-orm";
import db from "../../db";
import { domainEvents } from "../../db/schema";
import { probabilityOf, thresholdFor } from "../../decisions/policy";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";
import {
  CRITERION_BACKTEST_EVENTS,
  eventSubscriptions,
  type CriterionBacktestResponse,
  type WorkflowTriggerConfig,
} from "../../schemas/workflows";
import { remoteEvaluator, type DecisionEvaluator } from "../decisions/remote";
import { resolveFactSheets } from "../facts/resolve";
import type { FactSheet } from "../facts/types";
import { lintCriterion } from "./criterion-lint";
import { filterWorkflowConversationIds } from "./filter-workflow-conversation-ids";
import { buildGateQuestion, GATE_POINT, gateQuestionId } from "./gate-question";
import { getWorkflowRow } from "./get";
import { matchesEvent, selectTriggerCandidates } from "./trigger-matching";
import type { WorkflowRequester } from "./visibility";

/**
 * "Test the condition": replay a criterion over the events this workflow
 * would actually have received, and show what the gate would decide for each.
 *
 * The gate reads a sentence literally, and a sentence that reads right to its
 * author can refuse the very inputs it was meant for. Nothing else surfaces
 * that before real firings are lost, so the test runs the REAL question — same
 * builder, same point, same threshold — over real events, and the person sees
 * each verdict next to a handle they recognise.
 *
 * Journals nothing: these are not decisions, and a label written from a test
 * would calibrate the bar on firings that never happened.
 */

/** How far back to look for matching events: events of the subscribed types
 * are read newest first in one query, then matched in memory. */
const SCAN_WINDOW = 300;

/** The fact that best names an event for a person, first one present. */
const LABEL_FACTS = ["filename", "label", "name", "fullPath", "collectionName"];

const labelOf = (sheet: FactSheet | undefined): string | null => {
  for (const key of LABEL_FACTS) {
    const value = sheet?.facts[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
};

export const backtestCriterion = async (params: {
  workflowId: string;
  teamId: string;
  organizationId: string;
  criterion: string;
  triggerConfig?: WorkflowTriggerConfig;
  requester?: WorkflowRequester;
  evaluator?: DecisionEvaluator;
}): Promise<CriterionBacktestResponse> => {
  const lintError = await lintCriterion({
    criterion: params.criterion,
    context: { teamId: params.teamId, organizationId: params.organizationId },
    ...(params.evaluator ? { evaluator: params.evaluator } : {}),
  });
  if (lintError !== null) return throwHttpError(400, badRequest(lintError));

  const workflow = await getWorkflowRow({
    id: params.workflowId,
    teamId: params.teamId,
    ...(params.requester !== undefined ? { requester: params.requester } : {}),
  });
  if (!workflow) return throwHttpError(404, notFound("Workflow"));

  const tested = {
    ...workflow,
    triggerConfig: params.triggerConfig ?? workflow.triggerConfig,
    triggerCriterion: params.criterion.trim(),
  };
  const types = [
    ...new Set(eventSubscriptions(tested.triggerConfig).map((s) => s.type)),
  ];
  if (types.length === 0) return { threshold: null, results: [] };

  const recent = await db
    .select()
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.teamId, params.teamId),
        inArray(domainEvents.type, types),
      ),
    )
    .orderBy(desc(domainEvents.occurredAt))
    .limit(SCAN_WINDOW);

  const workflowConversations = await filterWorkflowConversationIds({
    conversationIds: [
      ...new Set(
        recent
          .map((e) => e.conversationId)
          .filter((id): id is string => id !== null),
      ),
    ],
  });
  const events = selectTriggerCandidates(recent, workflowConversations)
    .filter((event) => matchesEvent(tested, event))
    .slice(0, CRITERION_BACKTEST_EVENTS);
  if (events.length === 0) return { threshold: null, results: [] };

  const sheets = await resolveFactSheets(events);
  const questionId = gateQuestionId(workflow.id);
  const question = buildGateQuestion(tested);
  const evaluate = params.evaluator ?? remoteEvaluator;

  // One call per event: each has its own state. They run side by side, and
  // the decision service's per-minute budget is what bounds them.
  const responses = await Promise.all(
    events.map((event) =>
      evaluate(
        {
          point: GATE_POINT,
          subject: { type: "domain_event", id: event.id },
          sessionId: `criterion-test:${workflow.id}`,
          state: {
            ...(sheets.get(event.id)?.facts ?? {}),
            eventType: event.type,
          },
          questions: { [questionId]: question },
        },
        { teamId: params.teamId, organizationId: params.organizationId },
      ),
    ),
  );

  let threshold: number | null = null;
  const results = events.map((event, i) => {
    const response = responses[i];
    const answered = response?.status === "answered" ? response : null;
    const bar = answered
      ? thresholdFor(answered.policy, questionId)
      : undefined;
    if (bar !== undefined) threshold = bar;
    const probability = probabilityOf(answered?.answers[questionId]);
    const outcome: "run" | "filtered" | "unknown" =
      probability === null || bar === undefined
        ? "unknown"
        : probability >= bar
          ? "run"
          : "filtered";
    return {
      eventId: event.id,
      eventType: event.type,
      occurredAt: event.occurredAt,
      label: labelOf(sheets.get(event.id)),
      outcome,
      probability,
    };
  });
  return { threshold, results };
};
