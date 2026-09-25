import { parseApiError } from "@fretik/shared/schemas/errors";
import { HTTPException } from "hono/http-exception";
import {
  TOOL_ERROR_CODES,
  toolError,
  type ToolErrorOutput,
} from "./tool-error-codes";

/**
 * An access refusal, as the agent reads it.
 *
 * The assistant has no access of its own: it acts for the person driving the
 * turn, with exactly their access (`agents/shared/acting-principal.ts`). So a
 * tool meets the same 403 that person meets in the app — and reported as an
 * internal error, it read as a fault to retry or route around. This turns it
 * into what the app shows the person: what was refused, why, and whom to ask,
 * with a hint that ends the attempt instead of steering a retry.
 *
 * `null` when the error is not a refusal, for the caller to handle as before.
 */
export const liftAccessRefusal = (err: unknown): ToolErrorOutput | null => {
  if (!(err instanceof HTTPException) || err.status !== 403) return null;
  const parsed = parseApiError(err.message);
  if (parsed === null) return null;

  const contacts = parsed.access?.ask.map((contact) => contact.name) ?? [];
  const whom =
    contacts.length > 0
      ? ` They can ask ${contacts.slice(0, 3).join(", ")} for it.`
      : "";
  return toolError(
    TOOL_ERROR_CODES.ACCESS_DENIED,
    `Refused: ${parsed.message}`,
    `This is the user's own access, not a fault: do not retry it or look for another way to do the same thing. Tell the user it was refused and why.${whom}`,
  );
};
