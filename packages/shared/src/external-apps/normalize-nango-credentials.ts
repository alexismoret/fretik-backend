import type { ProviderManifest } from "./manifest-schema";

/**
 * Reverse-map a Nango-stored credentials / connection_config pair into the
 * snake_case shape our handlers expect. Symmetric to the forward mapping
 * done by the frontend (`ConnectPanel.onConnect` /
 * `ReconnectModal.onSubmit` → `useNangoConnect` /
 * `useReconnectConnection.completeCustomHandlerReconnect`).
 *
 * Two transformations, in this order:
 *
 *  1. **Secret envelope** (`credentialsForm.secretEnvelope`) — the whole
 *     secret set arrives as ONE JSON string in a single Nango credential
 *     field, because Nango's templates expose at most two encrypted slots
 *     and cap each at 1024 (BASIC) or 4096 (API_KEY) characters. Parse it
 *     back into flat fields. See the schema's JSDoc for why an SSH private
 *     key leaves no other option.
 *  2. **Per-field rename** (`credentialsForm.fields[i].nangoKey`) — some
 *     Nango templates require a specific wire shape (`private-api-bearer`
 *     expects `credentials.apiKey` camelCase) that doesn't match our
 *     codebase's snake_case convention. Project it back to `field.key`.
 *
 * Either way every downstream consumer (testCredentials, custom handlers,
 * the http-direct executor, get-connection-config) reads the same canonical
 * shape regardless of provider.
 *
 * Keys not declared by any field pass through verbatim — defends against
 * Nango adding tokens / metadata the manifest doesn't enumerate (refresh
 * tokens, expires_at, …).
 */
export const normalizeNangoCredentials = (
  manifest: ProviderManifest,
  rawCredentials: Record<string, unknown>,
  rawConnectionConfig: Record<string, unknown>,
): {
  credentials: Record<string, unknown>;
  connection_config: Record<string, unknown>;
} => {
  const unpacked = unpackSecretEnvelope(manifest, rawCredentials);

  const credsRename = new Map<string, string>();
  const cfgRename = new Map<string, string>();
  for (const field of manifest.credentialsForm?.fields ?? []) {
    const nangoKey = field.nangoKey;
    if (nangoKey === undefined || nangoKey === field.key) continue;
    if (field.target === "credentials") {
      credsRename.set(nangoKey, field.key);
    } else {
      cfgRename.set(nangoKey, field.key);
    }
  }

  if (credsRename.size === 0 && cfgRename.size === 0) {
    return { credentials: unpacked, connection_config: rawConnectionConfig };
  }

  const credentials: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(unpacked)) {
    credentials[credsRename.get(k) ?? k] = v;
  }
  const connection_config: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawConnectionConfig)) {
    connection_config[cfgRename.get(k) ?? k] = v;
  }
  return { credentials, connection_config };
};

/**
 * Expand `{ apiKey: '{"username":"u","password":"p"}' }` back into
 * `{ username: "u", password: "p" }`, leaving anything Nango added beside
 * the envelope untouched.
 *
 * Tolerant on purpose. A connection created before the provider adopted an
 * envelope still holds flat fields, and a Nango credential row can carry
 * metadata we never wrote — so an absent, non-string, or unparseable
 * envelope returns the credentials unchanged rather than throwing. The
 * handler then fails on the missing field it actually needs, which is a far
 * better message than "invalid JSON" from a layer the user never sees.
 */
const unpackSecretEnvelope = (
  manifest: ProviderManifest,
  rawCredentials: Record<string, unknown>,
): Record<string, unknown> => {
  const envelope = manifest.credentialsForm?.secretEnvelope;
  if (envelope === undefined) return rawCredentials;

  const packed = rawCredentials[envelope.nangoKey];
  if (typeof packed !== "string" || packed.length === 0) return rawCredentials;

  let parsed: unknown;
  try {
    parsed = JSON.parse(packed);
  } catch {
    return rawCredentials;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return rawCredentials;
  }

  const { [envelope.nangoKey]: _packed, ...rest } = rawCredentials;
  return { ...rest, ...(parsed as Record<string, unknown>) };
};
