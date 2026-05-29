/**
 * Pull a useful one-line summary out of an Axios-flavoured Nango error
 * without dragging the full stack into the API response. Falls back to
 * the raw exception message when the shape doesn't match.
 *
 * Used by every service that calls the Nango Node SDK and wants to
 * surface a stable, JSON-encodable error envelope to the API layer.
 */
export const extractNangoErrorDetails = (error: unknown): string => {
  if (typeof error !== "object" || error === null) {
    return String(error);
  }
  const err = error as {
    response?: { status?: number; data?: unknown };
    message?: string;
  };
  const status = err.response?.status;
  const data = err.response?.data;
  let body = "";
  if (typeof data === "string") {
    body = data;
  } else if (typeof data === "object" && data !== null) {
    try {
      body = JSON.stringify(data);
    } catch {
      body = "";
    }
  }
  const prefix = status !== undefined ? `HTTP ${status.toString()}` : "Error";
  if (body !== "") return `${prefix}: ${body}`;
  return `${prefix}: ${err.message ?? "unknown error"}`;
};
