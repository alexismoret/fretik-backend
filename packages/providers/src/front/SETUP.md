# Front — operator setup

These steps are for the operator (Fretik admin) configuring the Front
integration end-to-end. The chatbot does not read this file — it lives
here colocated with the provider code, not in `guidance.md`.

## 1. Create a Front OAuth application

1. Go to https://app.frontapp.com/settings/developers → **OAuth applications**.
2. Click **Create OAuth client** (requires Front admin role).
3. Fill in:
   - **Name**: `Fretik`
   - **Redirect URI**: the Nango callback URL shown on the integration
     page in the self-hosted Nango dashboard (typically
     `https://<nango-host>/oauth/callback`).
   - **Scopes**: tick the full set listed in `manifest.ts → scopes`:
     - `conversations:read`, `conversations:write`
     - `messages:read`, `messages:send`, `messages:write`
     - `comments:read`, `comments:write`
     - `contacts:read`, `contacts:write`
     - `tags:read`, `tags:write`
     - `inboxes:read`
     - `teammates:read`
     - `channels:read`
4. Save. Front shows the **Client ID** and **Client Secret** — copy
   both.

## 2. Configure the Nango integration

1. Open the self-hosted Nango dashboard.
2. Click **Configure New Integration** → pick the **Front** provider
   (Nango ships a pre-built OAuth integration under the key `front`).
3. Set the unique key to `front` — this MUST match
   `manifest.nangoProviderConfigKey`.
4. Paste the **Client ID** and **Client Secret** from step 1.
5. Register the scope list from step 1 in the **Scopes** field.
6. Save.

## 3. Smoke-test the connection

1. Launch `./dev.sh` and open the Fretik frontend.
2. Settings → External Apps → Front card → **Add connection**.
3. Pick scope (user/team) — persona pre-selects per scope.
4. Click **Connect** → redirects to Front OAuth → approve. The
   authorizing user must be a Front admin.
5. Connection card should appear with the purple Front logo and the
   `communication / shared-inbox / email` category badges.
6. In the chatbot ask "List my Front inboxes" — the agent should call
   `front.list_inboxes()` and return the inbox list.

## Notes

- **Access tokens expire after 60 minutes.** Nango auto-refreshes
  through the long-lived refresh token (TTL 6 months, rotated in the
  last 24h). No manual rotation needed.
- **Rate limits.** Front plans cap at 50–200 req/min depending on tier;
  partner OAuth apps share 120 req/min per company. The search
  endpoint is capped at 40% of that. The Nango proxy auto-honors
  `Retry-After` / `X-RateLimit-Reset`.
- **API base URL** is `https://api2.frontapp.com` — resolved by Nango,
  no override needed.
- **Persona / author_id** on replies and comments: when the connection
  persona is `bot`, the agent uses the OAuth-authorizing teammate as
  the author. There is no separate "bot teammate" configuration step —
  the mapper uses Front's `/me` automatically.

## API-key fallback (not used in production)

Nango also ships `front-api-key` for simple API-token auth. Configure
it the same way (unique key `front-api-key`, token from Front →
Settings → Developers → API Tokens with all needed feature toggles).
The manifest would need a small `nangoProviderConfigKey` change — not
wired by default.
