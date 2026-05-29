# Shiptify — operator setup

Operator-facing only (NOT shown to the chatbot). For agent-facing rules, see `guidance.md` in the same folder.

## 1. Provision the Nango integration

Shiptify is not in the Nango public catalog. We use Nango purely as encrypted credential storage via the generic `private-api-key` template.

1. Open the self-hosted Nango dashboard.
2. **Integrations → New integration → Provider** = `private-api-key`.
3. Set the unique key to `shiptify` (must match `nangoProviderConfigKey` in `manifest.ts`).
4. No client id / client secret to fill — `private-api-key` accepts only the user-supplied API key at connect time.
5. Save.

## 2. Obtain the API key from Shiptify

1. Log in to Shiptify (https://blu.shiptify.com).
2. **Settings → API → Generate token** (the exact UI label may have moved — ask Shiptify support if the menu is missing).
3. Copy the token — it is the value the user pastes in the **API key** field of the connect form. That's the only secret to collect; the **Account** dropdown auto-populates from the token.

## 3. Connect a Shiptify account in Fretik

1. **Settings → External apps → Add connection → Shiptify**.
2. The **Connection options** step shows an **Account type** dropdown. Leave it at the default — it is auto-filled in step 3 from the account you pick.
3. Paste the **API key** — the **Account** dropdown auto-populates with every account the token can act on (each labelled `<name> (shipper)` or `<name> (carrier)`). Pick the right one. The chosen account's `type` automatically overrides the **Account type** option, so the connection's role is correct without the user having to set it twice.
4. The connection's display name is auto-prefilled with `Shiptify — <account name>` — keep it or rename it freely.
5. Click **Test connection** — it pings `GET /accounts/` once more to confirm the pair works end-to-end.
6. Save. To connect several accounts that share the same token, repeat the flow and pick a different account in the dropdown.

## 4. Account roles (shipper vs carrier)

Shiptify accounts have a `type` of either `shipper` or `carrier` (returned by `/accounts/`). The provider covers both:

- **Shipper accounts** use the unprefixed actions (`create_shipment_request`, `confirm_shipment_pickup`, …). They hit `/shipment-requests/`, `/shipments/`, `/tracking-points/`.
- **Carrier accounts** use the `galaxy_*` actions (`galaxy_create_carrier_shipment_request`, `galaxy_confirm_shipment_pickup`, …). They hit `/galaxy/carrier/…`, `/galaxy/shipments/…`, `/galaxy/tracking-points/…`.

The active role is stored in `connection.options.account_type` and surfaced to the chatbot via the system prompt's `<external_apps>` block. The agent reads it and picks the matching prefix automatically — calling a mismatched action returns `403 "User is not <role>"`.

**Backfill for connections created before this change shipped:** existing rows have no `account_type` in their `options` JSON. Patch them once with the value matching their account's type. Example SQL:

```sql
UPDATE "external_app_connections"
SET options = jsonb_set(coalesce(options, '{}'::jsonb), '{account_type}', '"carrier"', true)
WHERE provider_key = 'shiptify'
  AND id = '<connection-uuid>';
```

(Use `'"shipper"'` for shipper accounts.) Without the backfill, the chatbot defaults to the shipper-side actions and a carrier account will hit 403 on the first write.

## 5. Notes / known limits

- `list_locations` does not search across all fields equally — `q` filters across name / address / city / zipcode / internal_ref. If you don't find a known location, double-check spelling or use `internal_ref` for exact match.
- The manifest ships ~52 actions out of Shiptify's ~218 — the 24 original shipper-side + 27 carrier-side `galaxy_*` + the shared `list_content_types` lookup. Out-of-scope today: warehouse / dock modules (`/slots`, `/visits`, `/dock-orders`, `/transport-requests`, `/freight-units`, `/sscc`, `/orders/*`), metadata-prototype writes, all financial endpoints (`/invoices`, `/financial-groups`, `/customs-invoices`, `/price-details`). See `manifest.ts` for the per-route justification. To expose more routes, edit the manifest, then `cd backend/packages/providers && bun run gen:sdk` to regenerate the chatbot SDK + SKILL.
- The token is stored encrypted in Nango. We never persist it in our DB. Rotation: revoke the token in Shiptify, then **Reconnect** the connection in Fretik (which re-collects a fresh token).
