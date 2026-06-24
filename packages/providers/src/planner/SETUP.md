# Microsoft Planner — operator setup

Operator-facing: how to register the Microsoft Entra ID OAuth app and wire it
into the self-hosted Nango instance. Not read by the chatbot.

Planner needs **no tenant admin consent** — `Tasks.ReadWrite` (the only
non-trivial scope) is a per-user consent. Any user can self-connect.

## 1. Register the OAuth app in Microsoft Entra ID

1. Microsoft Entra admin center → **App registrations** → **New registration**.
2. Name: `Fretik Microsoft Planner`. Supported account types:
   **Accounts in any organizational directory** (work/school).
3. Save. Copy the **Application (client) ID**.
4. **Authentication** → **Add a platform** → **Web**. Redirect URI:
   `https://api.nango.dev/oauth/callback` (or your self-hosted Nango callback
   URL). Keep "Allow public client flows" = No. Save.
5. **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Delegated permissions**. Tick exactly:
   - `offline_access`
   - `User.Read`
   - `Tasks.ReadWrite`

   Click **Add permissions**. **No "Grant admin consent" is required** — none
   of these are admin-restricted (each user consents at connect time).

6. **Certificates & secrets** → **New client secret**. Description:
   `Fretik Nango`. Expiry: 24 months. **Copy the VALUE immediately** — it's
   shown only once.

## 2. Create the Nango integration

1. Open the self-hosted Nango dashboard.
2. **Integrations** → **Configure New Integration** → search
   **Microsoft Planner** → Create.
3. Set **Unique Key** to exactly `microsoft-planner` (must match the
   manifest's `nangoProviderConfigKey`).
4. Paste:
   - **Client ID** = step 1.3
   - **Client Secret** = step 1.6
   - **Scopes** = the 3 scopes from step 1.5, space-separated:
     ```
     offline_access User.Read Tasks.ReadWrite
     ```
5. Save. Use **Add Test Connection → Authorize** to verify the OAuth
   round-trip. Delete the test connection after verification.

## 3. Notes

- **Proxy only.** Fretik calls Microsoft Graph through Nango's generic proxy
  (`https://graph.microsoft.com/v1.0/...`). No Nango prebuilt syncs/actions
  are used or required.
- **Group discovery is not built in.** We deliberately skipped `Group.Read.All`
  (admin consent). To work on a team's plans, the agent gets the group id from
  the Microsoft Teams integration (a Teams team id IS its M365 group id) or
  from a group id the user provides.
- **Premium (Project) plans are not supported by the Graph Planner API** — only
  basic Planner plans.
