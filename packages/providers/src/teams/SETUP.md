# Microsoft Teams — operator setup

Operator-facing: how to register the Microsoft Entra ID OAuth app and wire
it into the self-hosted Nango instance. Not read by the chatbot.

## 1. Register the OAuth app in Microsoft Entra ID

1. Microsoft Entra admin center → **App registrations** → **New registration**.
2. Name: `Fretik Microsoft Teams`. Supported account types:
   **Accounts in any organizational directory and personal Microsoft accounts**.
3. Save. Copy the **Application (client) ID**.
4. **Authentication** → **Add a platform** → **Web**. Redirect URI:
   `https://api.nango.dev/oauth/callback` (or your self-hosted Nango
   callback URL). Save.
5. **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Delegated permissions**. Tick exactly:
   - `offline_access`
   - `User.Read`
   - `User.ReadBasic.All`
   - `Chat.ReadWrite`
   - `ChatMember.Read`
   - `Team.ReadBasic.All`
   - `TeamMember.Read.All`
   - `Channel.ReadBasic.All`
   - `ChannelMessage.Read.All`
   - `ChannelMessage.Send`
   - `Presence.Read.All`
   - `Files.Read.All`

   Click **Add permissions**. For the dev/test tenant you control, also
   click **Grant admin consent for [tenant]** so test connections don't
   get blocked by the admin-consent flow.

6. **Certificates & secrets** → **New client secret**. Description:
   `Fretik Nango`. Expiry: 24 months. **Copy the VALUE immediately** —
   it's shown only once.

## 2. Create the Nango integration

1. Open the self-hosted Nango dashboard.
2. **Integrations** → **Configure New Integration** → search
   **Microsoft Teams** (NOT "Microsoft Teams Bot") → Create.
3. Set **Unique Key** to exactly `microsoft-teams` (must match the
   manifest's `nangoProviderConfigKey`).
4. Paste:
   - **Client ID** = step 1.3
   - **Client Secret** = step 1.6
   - **Scopes** = the 12 scopes from step 1.5, space-separated:
     ```
     offline_access User.Read User.ReadBasic.All Chat.ReadWrite ChatMember.Read Team.ReadBasic.All TeamMember.Read.All Channel.ReadBasic.All ChannelMessage.Read.All ChannelMessage.Send Presence.Read.All Files.Read.All
     ```
5. Save. Use **Add Test Connection → Authorize** to verify the OAuth
   round-trip. Delete the test connection after verification.

## 3. Do NOT register "Microsoft Teams Bot"

Skip the `microsoft-teams-bot` Nango provider. Fretik uses delegated user
permissions exclusively — a bot identity is not required and brings
extra setup (Azure Bot resource, tenant ID per connection, Bot Framework
loop) we explicitly chose against.
