import { getProvider } from "../../../external-apps/registry";
import { throwHttpError } from "../../../lib/errors";
import { ERROR_CODES } from "../../../schemas/errors";

/**
 * Resolve the options of a `dynamic-select` credential field at form
 * render time. Used by the descriptor-driven `AddConnectionModal` to
 * populate fields whose values are personal to the connecting user
 * (Shiptify accounts, future Salesforce sandboxes, etc.) — instead of
 * asking the user to find the value by hand.
 *
 * Wired to `POST /external-apps/connections/dynamic-options`. The
 * incoming credentials/connection_config are the IN-PROGRESS values
 * from the form (the connection isn't created yet) — they are NEVER
 * persisted by this path, they just feed the provider's handler. The
 * handler typically pings the provider API with whatever's been typed
 * (e.g. just the API key) and returns the resulting option list.
 */
export const fetchDynamicOptions = async (params: {
  providerKey: string;
  fieldKey: string;
  credentials: Record<string, unknown>;
  connectionConfig: Record<string, unknown>;
}): Promise<{ options: Array<{ value: string; label: string }> }> => {
  const provider = getProvider(params.providerKey);
  if (provider === undefined) {
    return throwHttpError(404, {
      code: ERROR_CODES.EXTERNAL_APP_PROVIDER_NOT_FOUND,
      message: `Unknown provider: ${params.providerKey}`,
    });
  }
  const form = provider.manifest.credentialsForm;
  if (form === undefined) {
    return throwHttpError(400, {
      code: ERROR_CODES.VALIDATION_ERROR,
      message: `Provider ${params.providerKey} has no credentials form`,
    });
  }
  const field = form.fields.find((f) => f.key === params.fieldKey);
  if (field === undefined) {
    return throwHttpError(404, {
      code: ERROR_CODES.VALIDATION_ERROR,
      message: `Field "${params.fieldKey}" not declared on provider ${params.providerKey}`,
    });
  }
  if (field.kind !== "dynamic-select" || field.optionsHandler === undefined) {
    return throwHttpError(400, {
      code: ERROR_CODES.VALIDATION_ERROR,
      message: `Field "${params.fieldKey}" is not a dynamic-select`,
    });
  }
  const handler = provider.dynamicOptions?.[field.optionsHandler];
  if (handler === undefined) {
    return throwHttpError(500, {
      code: ERROR_CODES.VALIDATION_ERROR,
      message: `Provider ${params.providerKey}: no handler registered for "${field.optionsHandler}"`,
    });
  }

  // Surface handler errors as 400 with the message inline so the form
  // can render it next to the field. Auth failures, network errors,
  // empty results all funnel through here.
  try {
    const result = await handler({
      credentials: params.credentials,
      connection_config: params.connectionConfig,
    });
    return { options: result.options };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return throwHttpError(400, {
      code: ERROR_CODES.VALIDATION_ERROR,
      message,
    });
  }
};
