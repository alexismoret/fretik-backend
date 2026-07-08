import { markConsumed } from "../complete";
import type { ApprovalKindHandler } from "./types";

const iso = (d: Date | null): string => (d ?? new Date()).toISOString();

/**
 * `question` — a structured question the workflow executor raised via
 * `askUserQuestion`. Nothing executes on grant: the answers are the result.
 * A kind "apart" — it never passes through the sandbox gate (no `toSandboxData`,
 * no dedup hash), the tool creates the pending row directly.
 */
export const questionHandler: ApprovalKindHandler = {
  kind: "question",
  execute: async ({ approval, decision }) => {
    const answers = decision?.answers ?? {};
    await markConsumed(approval.id, answers);
    return answers;
  },
  toToolOutput: (approval) => ({
    status: "answered",
    approvalId: approval.id,
    answers: approval.result ?? {},
    answeredAt: iso(approval.decisionAt),
  }),
};
