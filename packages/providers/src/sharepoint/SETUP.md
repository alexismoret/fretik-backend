# Microsoft SharePoint — operator setup

Operator-facing: how to register the Microsoft Entra ID OAuth app, wire it
into the self-hosted Nango instance, and connect a team-wide SharePoint
account. Not read by the chatbot.

## 0. Which Nango integration, and why

Nango ships three SharePoint entries. Fretik uses the first:

| Nango provider                | Auth                                    | Verdict                  |
| ----------------------------- | --------------------------------------- | ------------------------ |
| `sharepoint-online`           | OAuth2 delegated (alias of `microsoft`) | **What we use**          |
| `sharepoint-online-oauth2-cc` | OAuth2 client credentials (app-only)    | Rejected — see below     |
| `sharepoint-online-v1`        | Two-step, legacy SharePoint REST        | Rejected — pre-Graph API |

`sharepoint-online` is `alias: microsoft` in Nango's catalogue: the same
OAuth2 authorization-code flow, the same `login.microsoftonline.com/common`
endpoints and the same `https://graph.microsoft.com` proxy base that
`outlook`, `microsoft-teams` and `microsoft-planner` already use here. Its
display name in the dashboard is **SharePoint Online (v2)**.

**Why not client credentials.** App-only SharePoint permissions are
all-or-nothing: `Sites.ReadWrite.All` as an _application_ permission reaches
every site collection in the tenant, including HR, Finance and every private
site. Microsoft's own answer to that is `Sites.Selected` plus an
admin-executed per-site grant — an operator workflow Fretik does not have.
App-only also has no user: writes are attributed to "the app", the audit log
loses the actor, `/me` endpoints disappear, and SharePoint's per-user
permissions stop bounding what the agent can reach. It buys nothing our data
model lacks either — a Fretik connection is already `scope: team`.

**The team-wide SharePoint account is a delegated service account** — see §4.

## 1. Register the OAuth app in Microsoft Entra ID

1. Microsoft Entra admin center → **App registrations** → **New registration**.
2. Name: `Fretik SharePoint`. Supported account types: **Accounts in any
   organizational directory** (multi-tenant). SharePoint has no consumer
   equivalent, so personal Microsoft accounts are not needed.
3. Save. Copy the **Application (client) ID**.
4. **Authentication** → **Add a platform** → **Web**. Redirect URI:
   your Nango callback URL (`https://nango.fretik.com/oauth/callback` on the
   self-hosted instance, `https://api.nango.dev/oauth/callback` on Nango
   Cloud). Save.
5. **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Delegated permissions**. Tick exactly:
   - `offline_access`
   - `User.Read`
   - `Sites.Read.All`
   - `Sites.ReadWrite.All`

   Click **Add permissions**. `Sites.Read.All` is not redundant with
   `Sites.ReadWrite.All`: Microsoft Search (`POST /search/query`, which backs
   the `search` action) matches scopes literally and its permission table
   names only the read one.

   Do **not** add `Sites.Manage.All` (Fretik never creates a list),
   `Sites.FullControl.All`, or any `Files.*` scope (that is the user's own
   OneDrive, a different product).

6. Both `Sites.*` scopes require **admin consent** in most tenants. For the
   dev/test tenant you control, click **Grant admin consent for [tenant]** so
   test connections aren't blocked.
7. **Certificates & secrets** → **New client secret**. Description:
   `Fretik Nango`. Expiry: 24 months. **Copy the VALUE immediately** — it is
   shown only once.

## 2. Create the Nango integration

1. Open the self-hosted Nango dashboard.
2. **Integrations** → **Configure New Integration** → search **SharePoint
   Online (v2)** → Create. Do NOT pick "SharePoint Online (Client
   Credentials V2)" or "SharePoint Online (v1)".
3. Set **Unique Key** to exactly `sharepoint-online` — it must match the
   manifest's `nangoProviderConfigKey`, and Fretik's Connect session is
   minted against that string.
4. Paste:
   - **Client ID** = step 1.3
   - **Client Secret** = step 1.7
   - **Scopes** = the four from step 1.5, space-separated:
     ```
     offline_access User.Read Sites.Read.All Sites.ReadWrite.All
     ```
5. Save. Use **Add Test Connection → Authorize** to verify the OAuth
   round-trip, then delete the test connection.

Note: Nango attaches a `post_connection_script` (`onedrivePostConnection`,
inherited from the OneDrive integration) to this provider. Fretik never reads
what it stores — every action resolves its own site and drive ids — so a
warning from it in the Nango logs is harmless. If it ever fails the
connection outright, create the integration on the plain **Microsoft**
provider instead, keeping the same unique key `sharepoint-online`: the OAuth
config is identical, only the script and the dashboard label differ.

## 3. Connect a personal account

Settings → External apps → Add connection → **Microsoft SharePoint** →
scope **Personal**. The user signs in; the connection reaches exactly the
sites that user can already open in SharePoint.

If their tenant has not consented to the app, the OAuth callback returns
`AADSTS65001` / `AADSTS90094` and Fretik shows the "your organization needs
admin approval" alert. An IT admin then connects once with the **Install for
the entire organization** toggle on (which forwards `prompt=consent`), and
every user in the tenant can connect afterwards.

## 4. Connect a team-wide ("global") SharePoint account

This is the answer to "we want one shared SharePoint connection, not one per
person".

1. Create a dedicated Entra user, e.g. `fretik@customer.com`. Give it a
   Microsoft 365 licence that includes SharePoint. Nothing else — no admin
   role.
2. In SharePoint, add that user as a **Member** (or Visitor, for read-only)
   of every site the team should reach. That membership IS the blast radius:
   Fretik cannot see a site the account was not invited to.
3. In Fretik: Add connection → **Microsoft SharePoint** → scope **Team** →
   sign in as the service account.
4. Optional but recommended: set **Default SharePoint site** on the
   connection to the site the team lives in. The assistant reads it and stops
   spending a discovery call per request.

Every member of the team then uses that one connection, writes are attributed
to the service account, and revoking access is one membership removal in
SharePoint — not a per-user reconnect dance.

## 5. Sandbox egress

Downloads and uploads move bytes between the agent's E2B sandbox and
`<tenant>.sharepoint.com` (Graph hands out pre-authenticated URLs on that
host, not on `graph.microsoft.com`). `*.sharepoint.com` is on the sandbox
allowlist in `@fretik/shared/services/e2b/network-policy.ts` for that reason
— removing it silently breaks `download_file` and every upload.

## 6. Cross-app flows and the account-overlap trap

Teams, Outlook and Planner reach SharePoint through their own connections,
each with its own account. Nothing is shared between them: a `teams` action
uses the Teams token, a `sharepoint` action uses the SharePoint token.

So a cross-app flow only works where the two ACCOUNTS overlap. The case that
bites: Teams connected as each user's own account, SharePoint connected as a
team service account that was never added to the Teams team's site. The
agent reads the channel's folder id happily (that call runs on the Teams
connection) and then the upload answers `itemNotFound` — the service account
simply cannot see that library.

Fix: add the SharePoint service account as a Member of every Teams team's
site the assistant should write into. In SharePoint, a Teams team's site is
the one named after the team; its group id and the Teams `team_id` are the
same value.
