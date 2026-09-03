# Shiptify — operator setup

Operator-facing only (NOT shown to the chatbot). For agent-facing rules, see `guidance.md` in the same folder.

## 1. Provision the Nango integration

Shiptify is not in the Nango public catalog. We use Nango purely as encrypted credential storage.

1. Open the self-hosted Nango dashboard.
2. **Integrations → New integration → Provider** = `private-api-bearer`.
3. Set the unique key to `shiptify` (must match `nangoProviderConfigKey` in `manifest.ts`).
4. No client id / client secret to fill — the template accepts only the user-supplied API key at connect time.
5. Save.

The template stores the key under `credentials.apiKey`; the manifest's `nangoKey` on the `api_key` field handles the rename in both directions. We never call `nango.proxy`, so the template's own `Bearer` projection is irrelevant — `http-direct` sends `Authorization: <api_key>` verbatim.

## 2. Obtain the API key from Shiptify

1. Log in to Shiptify (https://blu.shiptify.com).
2. **Settings → API → Generate token**.
3. Copy the token **whole**. Shiptify's tokens carry their own scheme prefix (`Api-Key <token>`) and the value may itself start with a quote character. It is sent verbatim as the `Authorization` header, so anything trimmed off breaks it with a 401 that looks exactly like a revoked key.

## 3. Understand the scope model before connecting

This is the part that used to make working keys look broken.

A token belongs to a **user**, and `GET /accounts/` lists the accounts that user can SEE. That is not the same set as the accounts the token may ACT ON, and on a carrier-group token the two barely overlap — measured on a production key: 18 accounts listed, **1** accepted, the other 17 answering `403 "Account is not available"` on every call.

`X-Account-ID` is a **narrowing filter**, not a tenant key:

| Header              | Result                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Omitted             | The token's natural scope. On a group token: every account of the group.                                |
| An accepted account | Every call restricted to that one account — sister agencies' shipments become `404 Shipment not found`. |
| Any other account   | `403 "Account is not available"` on every call, forever.                                                |

So **leaving the Account field empty is the right default**, and the only setup that lets a group key reach its whole group. Pick an account only to deliberately restrict a connection to it.

The connect form enforces this: `listAccounts` probes each account with `X-Account-ID` and offers only the ones that answer, behind an "every account this key can reach" entry.

## 4. Connect a Shiptify account in Fretik

1. **Settings → External apps → Add connection → Shiptify**.
2. Paste the **API key**. The **Account** dropdown populates with the probed accounts (this takes one request per account, so a token with many accounts is briefly slower; past 60 accounts the probe is skipped and the raw list is offered).
3. Leave **Account** on "every account this key can reach" unless you are deliberately restricting the connection.
4. **Account type** (shipper / carrier) auto-fills from the key. Override only if it is wrong.
5. **Test connection** checks the key alone, then the chosen account if any — so the error names which of the two failed.
6. Save.

## 5. Account roles (shipper vs carrier)

Shiptify's role check is per user: a shipper token gets `403 "User is not carrier"` on `/galaxy/*`, and a carrier token gets `403 "User is not shipper"` on `/shipment-requests/`, `/carriers/active`, `/content-types/active`, `/orders`, `/invoices`, `/events`, `/tags`.

- **Shipper accounts** use the unprefixed actions.
- **Carrier accounts** use the `galaxy_*` actions, plus `list_quote_requests` for the RFQ inbox.
- Shared: `list_locations`, `create_location`, `list_shipment_modes`, `list_content_types`, `list_shipments`.

`connection.options.account_type` carries the role to the chatbot via `<external_apps>`; `guidance.md` holds the routing table.

**Backfill for connections created before this shipped:** rows with no `account_type` default the agent to the shipper actions, and rows carrying an `account_id` the key cannot act on 403 on every call. Fix both at once:

```sql
UPDATE "external_app_connections"
SET options = jsonb_set(coalesce(options, '{}'::jsonb), '{account_type}', '"carrier"', true)
WHERE provider_key = 'shiptify' AND id = '<connection-uuid>';
```

(Use `'"shipper"'` for shipper accounts.) To widen a connection that was pinned to one account, clear its `account_id` in Nango's `connection_config` — or simply delete and re-create the connection through the form, which is now the safer path.

## 6. Notes / known limits

- `list_content_types` reads `/content-types` (the platform-wide catalogue, ~1 400 rows) and NOT `/content-types/active` (the account's curated subset). The curated one is shipper-only, which left carriers unable to resolve the `type_id` their own create action requires. The trade-off: a shipper now sees types its account has not enabled. Shiptify validates `type_id` server-side on create, so a bad pick fails loudly at approval time rather than silently.
- `list_locations` searches `q` across name / address / city / zipcode / internal_ref only. Use `internal_ref` for an exact match.
- The two shipment lists sort in OPPOSITE directions: `/shipments/` newest-first, `/galaxy-data/shipments` oldest-first. Neither takes a sort parameter, so the carrier list is only usable with a date filter — the manifest says so on the param and `guidance.md` shows the call.
- The manifest ships 50 of Shiptify's ~277 operations. Out of scope: warehouse / dock (`/slots`, `/visits`, `/dock-orders`, `/freight-units`, `/sscc`, `/orders/*`), metadata-prototype writes, all financial endpoints (`/invoices`, `/financial-groups`, `/customs-invoices`, `/price-details`). To expose more, edit the manifest then `cd backend/packages/providers && bun run gen:sdk`.
- Endpoints deliberately NOT exposed because they do not exist as reads, despite reading like they should: `GET /galaxy/carrier/shipments`, `GET /galaxy/carrier/shipment-requests`, `GET /galaxy/carrier/shipment-requests/ready_to_book` are all POST-only (they CREATE), and `/galaxy/carrier/shipment-requests/{id}/prices` answered 404 for every id tried. Re-check against `openapi.json` before adding a `galaxy_list_*` action.
- Two distinct 404 shapes, worth knowing when debugging: `{"success":false,"error":"Not Found","path":"..."}` is the router — the route does not exist. `{"error":{"code":404,"message":"Shipment not found"}}` is the application — the route exists, the resource is out of scope.
- The token is stored encrypted in Nango; we never persist it. Rotation: revoke in Shiptify, then **Reconnect** in Fretik.
