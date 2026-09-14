import type { ProviderManifest } from "@fretik/shared/external-apps/manifest-schema";
import { providerManifestSchema } from "@fretik/shared/external-apps/manifest-schema";
import { normalizeNangoCredentials } from "@fretik/shared/external-apps/normalize-nango-credentials";
import { describe, expect, test } from "bun:test";

/**
 * The secret envelope is a wire contract split across two repositories: the
 * frontend packs the JSON before handing it to Nango, this function parses
 * it back. Nothing type-checks that seam, and a mismatch does not fail — it
 * hands every handler a credentials object with the fields missing, which
 * surfaces as "missing required field: password" on a connection the user
 * filled in completely.
 *
 * So the cases pinned here are the ones that decide whether a stored
 * connection can still be read: a pre-envelope connection, a Nango row
 * carrying metadata beside the envelope, and a blob that is not what we
 * expect.
 */

const base = {
  key: "test-provider",
  displayName: "Test",
  nangoProviderConfigKey: "test-provider",
  icon: "i-lucide-plug",
  transport: { kind: "custom-handler" as const },
  scopes: [],
  categories: ["storage"],
  types: {},
  actions: [
    {
      name: "ping",
      kind: "read" as const,
      summary: "Ping",
      handler: "ping",
      params: {},
      returns: { void: true as const },
    },
  ],
};

const enveloped: ProviderManifest = {
  ...base,
  credentialsForm: {
    secretEnvelope: { nangoKey: "apiKey" },
    fields: [
      {
        key: "username",
        labelKey: "l",
        kind: "text",
        target: "credentials",
        required: true,
      },
      {
        key: "private_key",
        labelKey: "l",
        kind: "textarea",
        target: "credentials",
        required: false,
      },
      {
        key: "host",
        labelKey: "l",
        kind: "text",
        target: "connection_config",
        required: true,
      },
    ],
    testConnection: { supported: true },
  },
};

const renamed: ProviderManifest = {
  ...base,
  credentialsForm: {
    fields: [
      {
        key: "api_key",
        nangoKey: "apiKey",
        labelKey: "l",
        kind: "password",
        target: "credentials",
        required: true,
      },
    ],
    testConnection: { supported: true },
  },
};

describe("secret envelope", () => {
  test("unpacks the JSON blob into flat credential fields", () => {
    const { credentials, connection_config } = normalizeNangoCredentials(
      enveloped,
      {
        apiKey: JSON.stringify({
          username: "edi",
          private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n",
        }),
      },
      { host: "files.example.com" },
    );

    expect(credentials).toEqual({
      username: "edi",
      private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n",
    });
    // The envelope key itself never reaches a handler.
    expect(credentials.apiKey).toBeUndefined();
    expect(connection_config).toEqual({ host: "files.example.com" });
  });

  test("keeps newlines intact through the JSON round-trip", () => {
    // A private key that loses its line breaks parses nowhere, and the
    // error blames the key rather than the transport.
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIE\nowIB\n-----END-----\n";
    const { credentials } = normalizeNangoCredentials(
      enveloped,
      { apiKey: JSON.stringify({ username: "edi", private_key: key }) },
      {},
    );
    expect(credentials.private_key).toBe(key);
  });

  test("preserves anything Nango stored beside the envelope", () => {
    const { credentials } = normalizeNangoCredentials(
      enveloped,
      { apiKey: JSON.stringify({ username: "edi" }), expires_at: "2027-01-01" },
      {},
    );
    expect(credentials).toEqual({ username: "edi", expires_at: "2027-01-01" });
  });

  test("leaves a pre-envelope connection readable", () => {
    // Adopting an envelope must not orphan the connections stored before
    // it existed — they hold flat fields and keep working untouched.
    const { credentials } = normalizeNangoCredentials(
      enveloped,
      { username: "edi", password: "s3cret" },
      {},
    );
    expect(credentials).toEqual({ username: "edi", password: "s3cret" });
  });

  test("passes a non-JSON blob through rather than throwing", () => {
    // The handler then fails on the field it actually needs, which is a
    // message the user can act on — unlike a parse error from a layer they
    // have never heard of.
    const { credentials } = normalizeNangoCredentials(
      enveloped,
      { apiKey: "not json" },
      {},
    );
    expect(credentials).toEqual({ apiKey: "not json" });
  });

  test("a JSON array is not an envelope", () => {
    const { credentials } = normalizeNangoCredentials(
      enveloped,
      { apiKey: "[1,2,3]" },
      {},
    );
    expect(credentials).toEqual({ apiKey: "[1,2,3]" });
  });

  test("the per-field nangoKey rename still works without an envelope", () => {
    const { credentials } = normalizeNangoCredentials(
      renamed,
      { apiKey: "sk-123" },
      {},
    );
    expect(credentials).toEqual({ api_key: "sk-123" });
  });
});

describe("credentials form validation", () => {
  test("rejects a credentials field that declares nangoKey under an envelope", () => {
    const result = providerManifestSchema.safeParse({
      ...enveloped,
      credentialsForm: {
        ...enveloped.credentialsForm,
        fields: [
          {
            key: "username",
            nangoKey: "user",
            labelKey: "l",
            kind: "text",
            target: "credentials",
            required: true,
          },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects a visibleWhen pointing at a field that does not exist", () => {
    const result = providerManifestSchema.safeParse({
      ...enveloped,
      credentialsForm: {
        ...enveloped.credentialsForm,
        fields: [
          {
            key: "password",
            labelKey: "l",
            kind: "password",
            target: "credentials",
            required: true,
            visibleWhen: { field: "auth_method", equals: ["password"] },
          },
        ],
      },
    });
    // A condition on a missing field never matches, so the credential is
    // silently dropped from every submission — caught at boot instead.
    expect(result.success).toBe(false);
  });

  test("accepts a visibleWhen pointing at a sibling field", () => {
    const result = providerManifestSchema.safeParse({
      ...enveloped,
      credentialsForm: {
        ...enveloped.credentialsForm,
        fields: [
          {
            key: "auth_method",
            labelKey: "l",
            kind: "select",
            target: "connection_config",
            required: true,
            options: [{ value: "password", labelKey: "l" }],
          },
          {
            key: "password",
            labelKey: "l",
            kind: "password",
            target: "credentials",
            required: true,
            visibleWhen: { field: "auth_method", equals: ["password"] },
          },
        ],
      },
    });
    expect(result.success).toBe(true);
  });
});
