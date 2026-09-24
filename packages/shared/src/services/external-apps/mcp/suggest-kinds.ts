import { and, eq } from "drizzle-orm";
import db from "../../../db";
import { decisionLog } from "../../../db/schema";
import {
  chosenOf,
  minChosenFor,
  thresholdFor,
} from "../../../decisions/policy";
import type { ParamSpec } from "../../../external-apps/manifest-schema";
import type {
  DecisionAnswered,
  DecisionQuestion,
} from "../../../schemas/decisions";
import type { ExternalAppDescriptorAction } from "../../../schemas/external-app-descriptor";
import { recordDecisions } from "../../decisions/journal";
import { answerJournalEntry } from "../../decisions/journal-entry";
import {
  remoteEvaluator,
  type DecisionEvaluator,
} from "../../decisions/remote";
import { getSnapshotForConnection } from "./snapshot-store";

/**
 * What an MCP tool does, when its server did not say.
 *
 * A tool without a `readOnlyHint` is write-gated (`to-descriptor.ts`), and
 * that stays true whatever is decided here: guessing "read" would put a
 * delete on the ungated path. What the decision model adds is a SUGGESTION
 * next to the tool in the permissions list. An admin who accepts it lifts
 * the approval gate for that one tool, through the same per-connection
 * policy they could have set by hand; one who rejects it labels it wrong.
 *
 * Asked once per tool per snapshot: a snapshot is immutable, so an answer
 * about one stays true for as long as the connection uses it, and a changed
 * tool list is a new snapshot asked afresh.
 */

export const SUGGEST_KIND_POINT = "external-apps.mcp.suggest-kind";

export const MCP_TOOL_KINDS = [
  "read",
  "write",
  "destructive",
  "mixed",
] as const;
export type McpToolKind = (typeof MCP_TOOL_KINDS)[number];

const KINDS: ReadonlySet<string> = new Set(MCP_TOOL_KINDS);
export const isMcpToolKind = (value: string): value is McpToolKind =>
  KINDS.has(value);

const KIND_CRITERIA: Record<McpToolKind, string> = {
  read: "Only reads, searches or lists. Changes nothing and sends nothing.",
  write: "Creates, updates or sends something, and deletes nothing.",
  destructive: "Deletes data, or overwrites it with no way back.",
  mixed:
    "Reads or writes depending on an argument, such as an action or operation parameter.",
};

export const SUGGESTION_SUBJECT = "mcp_tool_snapshot";

/** Wire id, by position in one call. */
export const kindQuestionId = (index: number): string =>
  `kind:t${index.toString()}`;

/** Journal id, by tool: the row an admin's answer labels. */
export const kindJournalId = (actionName: string): string =>
  `kind:${actionName}`;

const MAX_PARAMS = 12;
const PARAM_LINE_CHARS = 200;

const paramLine = (name: string, spec: ParamSpec): string => {
  const values =
    spec.values !== undefined && spec.values.length > 0
      ? ` (one of: ${spec.values.join(", ")})`
      : "";
  const description =
    spec.description !== undefined ? `: ${spec.description}` : "";
  return `- ${name} ${spec.type}${values}${description}`.slice(
    0,
    PARAM_LINE_CHARS,
  );
};

export const buildKindQuestion = (
  action: ExternalAppDescriptorAction,
): DecisionQuestion => {
  const params = Object.entries(action.params).slice(0, MAX_PARAMS);
  return {
    type: "choice",
    instructions: [
      `Tool "${action.mcpToolName ?? action.name}" of this server.`,
      `Description: ${action.summary}`,
      params.length > 0
        ? `Parameters:\n${params.map(([name, spec]) => paramLine(name, spec)).join("\n")}`
        : "No parameters.",
      "What does calling this tool do? Judge by what it acts on, not by what its description claims about being safe.",
    ].join("\n"),
    criteria: KIND_CRITERIA,
  };
};

export type KindVerdict =
  | { outcome: "suggested"; kind: McpToolKind }
  | { outcome: "unsure"; kind: null };

/**
 * A suggestion only when the whole distribution is decided: the model's
 * confidence clears the family's bar AND the winner carries enough on its
 * own. A missing confidence is "not reported", so no suggestion.
 */
export const readKindVerdict = (
  response: DecisionAnswered,
  index: number,
): KindVerdict => {
  const id = kindQuestionId(index);
  const chosen = chosenOf(response.answers[id]);
  if (
    chosen === null ||
    !isMcpToolKind(chosen.choice) ||
    chosen.confidence === null ||
    chosen.probability === null
  ) {
    return { outcome: "unsure", kind: null };
  }
  const threshold = thresholdFor(response.policy, id) ?? 1;
  const minChosen = minChosenFor(response.policy, id) ?? 0;
  if (chosen.confidence < threshold || chosen.probability < minChosen) {
    return { outcome: "unsure", kind: null };
  }
  return { outcome: "suggested", kind: chosen.choice };
};

/**
 * Suggest a kind for every un-annotated tool of a connection's current
 * snapshot that has not been asked about yet. Returns how many suggestions
 * it wrote. Called after each introspection; never throws on a missing
 * connection or snapshot.
 */
export const suggestMcpToolKinds = async (params: {
  connectionId: string;
  evaluator?: DecisionEvaluator;
}): Promise<number> => {
  const connection = await db.query.externalAppConnections.findFirst({
    columns: {
      id: true,
      teamId: true,
      organizationId: true,
      providerKey: true,
      displayName: true,
      description: true,
      toolFingerprint: true,
    },
    where: { id: params.connectionId },
  });
  if (connection === undefined) return 0;
  const snapshot = await getSnapshotForConnection(connection);
  if (snapshot === undefined) return 0;

  const asked = new Set(
    (
      await db
        .select({ questionId: decisionLog.questionId })
        .from(decisionLog)
        .where(
          and(
            eq(decisionLog.teamId, connection.teamId),
            eq(decisionLog.point, SUGGEST_KIND_POINT),
            eq(decisionLog.subjectId, snapshot.id),
          ),
        )
    ).map((row) => row.questionId),
  );
  const tools = snapshot.descriptor.actions.filter(
    (action) =>
      action.kindSource === "default" && !asked.has(kindJournalId(action.name)),
  );
  if (tools.length === 0) return 0;

  const response = await (params.evaluator ?? remoteEvaluator)(
    {
      point: SUGGEST_KIND_POINT,
      subject: { type: SUGGESTION_SUBJECT, id: snapshot.id },
      state: {
        server: connection.displayName,
        ...(connection.description !== null
          ? { serverDescription: connection.description }
          : {}),
      },
      questions: Object.fromEntries(
        tools.map((tool, i) => [kindQuestionId(i), buildKindQuestion(tool)]),
      ),
    },
    { teamId: connection.teamId, organizationId: connection.organizationId },
  );
  // Only answered questions are journaled. A row is unique per question, so
  // journaling a miss would block the next night's retry for that tool.
  if (response?.status !== "answered") return 0;

  const entries = tools.flatMap((tool, i) => {
    if (response.answers[kindQuestionId(i)] === undefined) return [];
    const verdict = readKindVerdict(response, i);
    return [
      answerJournalEntry({
        organizationId: connection.organizationId,
        teamId: connection.teamId,
        point: SUGGEST_KIND_POINT,
        questionId: kindQuestionId(i),
        journalQuestionId: kindJournalId(tool.name),
        subjectType: SUGGESTION_SUBJECT,
        subjectId: snapshot.id,
        response,
        questionCount: tools.length,
        outcome: verdict.outcome,
        applied: false,
      }),
    ];
  });
  await recordDecisions(entries);
  return entries.filter((entry) => entry.outcome === "suggested").length;
};
