# Pbyp — operator setup

Everything here is done once, by an operator. None of it is agent-facing.

## 1. Nango integration

Create an integration in the self-hosted Nango dashboard:

|            |                                              |
| ---------- | -------------------------------------------- |
| Unique key | `pbyp` — must match `nangoProviderConfigKey` |
| Template   | `private-api-bearer`                         |

Nango only stores the secret; it never calls Pbyp. The credential lands at `credentials.apiKey`, which the manifest's `nangoKey: "apiKey"` maps back to `credentials.api_key`.

## 2. What the user does

1. In Pbyp: **Gestion du profil → Clé API → Générer**. The key is shown once — Directus conceals `token` on read — so it has to be copied then.
2. In Fretik: **Settings → External apps → Pbyp**, paste the key. The Profile dropdown populates from the account's own profiles.
3. Pick the profile, **Test**, save.

Saving activates that profile on Pbyp (`POST /auth-endpoints/profile/:id`, see `on-connected.ts`). Say what that means: the active profile belongs to the ACCOUNT, so it also changes what the person sees in their own Pbyp session, and their switching profile in Pbyp changes what the connection sees.

Two people must not share one key. A key carries its account's rights, and the profile is a property of the account.

## 3. Environment

`baseUrl` is hard-coded to the preprod host, `https://directus.preprod.pbyp.fr`, in `manifest.ts`. Moving to production is that one constant plus `bun run gen:sdk` — the manifest hash is the SKILL version, so the sandbox picks the change up. If both environments ever have to coexist, the `http-direct` schema needs a `connection_config.base_url` source; do not fake it with a second provider key.

## 4. Refreshing the schema snapshot

`src/pbyp/directus-schema.ts` is generated and committed. After any Pbyp schema change:

```bash
PBYP_DIRECTUS_URL=https://directus.preprod.pbyp.fr \
PBYP_ADMIN_TOKEN=<admin token> \
bun run pbyp:schema
```

Then `bun run test`: `pbyp-schema-contract.test.ts` reports every whitelist entry, computed column, required parameter and enum the change invalidated. An **admin** token is required — `/fields` is permission-scoped, and a persona token would produce a snapshot missing whatever that persona cannot see.

## 5. Preprod caveat

The legacy `User` policy (382 open rules) is still attached to the Pbyp role on preprod, and Directus unions row filters. **Tenancy is therefore not enforced there**: a test account reads other entities' rows, gateways included. Scope behaviour cannot be verified until `scripts/directus-security/apply-policies.mjs --detach-legacy` has run. Everything else — payload shapes, hooks, statuses, EDI — behaves normally.

## 6. Deliberately out of scope

- **Binary files.** `http-direct` sends JSON, so documents are reachable as metadata (`files`) but never uploaded or downloaded. The file name itself lives on `directus_files`, which this connection does not read.
- **`gateway_external.access_key`.** Scrubbed from every response at any depth. It is a partner's static token, and a token in a transcript is a published token.
- **The Directus MCP.** Pbyp exposes one at `/mcp`; Fretik does not use it. Its OAuth JWT is audience-locked to `/mcp`, so none of the eight bundle endpoints (numbering, container stuffing, profile activation, gateway creation, tracking, LTA stock, invite, client creation) are reachable through it, and its seven tools carry no `readOnlyHint`, so every read would raise an approval card. If a Fretik MCP connection to Pbyp exists, delete it — its minted `provider_key` collides with this provider's.
