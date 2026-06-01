# Exchange (EWS) — operator setup

Not agent-facing. How to wire the `exchange` provider in Nango + what users enter.

## Nango integration

1. Nango dashboard → **Integrations → Configure New Integration → Private API
   (Basic Auth)** (`private-api-basic` template).
2. Unique key: **`exchange`** (must match `nangoProviderConfigKey` in `manifest.ts`).
3. No client id/secret, no scopes, no redirect URL — credentials are collected by
   Fretik's own form and stored by Nango.

## What the user enters (credentials form)

Only **two required fields** — everything else is auto-resolved and lives in a
collapsed "Advanced settings" section (manual fallback only).

| Field (required) | Target      | Notes                                                                                                                     |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| Email            | credentials | Basic-auth login (default) + Autodiscover key + identity. Stored in the Basic-Auth `username` slot (manifest `nangoKey`). |
| Password         | credentials | Windows account password                                                                                                  |

| Field (advanced, optional)      | Target            | Notes                                                                                                                               |
| ------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in name (`login_override`) | connection_config | Only when the AD sign-in differs from the email (e.g. `DOMAIN\user`). Blank → email is the login.                                   |
| EWS server URL (`ews_url`)      | connection_config | Blank → resolved via **Autodiscover** from the email. Override e.g. `https://mail.company.com/EWS/Exchange.asmx`.                   |
| Exchange version                | connection_config | `auto` (default) → **detected** from the server's `ServerVersionInfo`. Override: `Exchange2010_SP2` / `2013` / `2013_SP1` / `2016`. |
| Allow self-signed cert          | connection_config | Enable for internal-CA / self-signed TLS (common on-prem).                                                                          |

## Auto-resolution (URL + version)

When the EWS URL is blank, the client resolves it **convention-first** (the
library's Autodiscover is unreliable for self-hosted servers and masks errors
behind "Not implemented." — it is only a last-resort fallback):

1. **Conventional URLs**, derived from the email domain, each validated by a
   real authenticated request (`Folder.Bind(Inbox)`):
   `https://autodiscover.<domain>/EWS/Exchange.asmx` →
   `https://mail.<domain>/EWS/Exchange.asmx` → `https://<domain>/EWS/Exchange.asmx`.
   The first that binds successfully wins. Because the probe is a real request,
   a failure is a **real** error (auth / TLS / DNS), not a masked one.
2. **Version** comes for free from that same probe: the SOAP response populates
   `service.ServerInfo`; we map `MajorVersion`/`MinorVersion` (14→2010, 15.0→2013,
   15.1/15.2→2016).
3. **Fallback** — the library's `AutodiscoverUrl`; then manual URL in advanced
   settings.

**Performance** — resolution runs **once per connection per process** (cached in
memory, concurrent first-calls deduped). Zero per-action overhead. Cache is not
persisted: a process restart re-resolves once (~a few hundred ms).

Note: `autodiscover.<domain>` must present a TLS cert valid for that hostname
(the bare `<domain>` candidate often fails cert validation — that's expected,
the resolver moves on). Enable "allow self-signed certificate" only for
internal-CA / self-signed deployments.

## Auth / runtime

- **HTTP Basic over TLS.** `WebCredentials` makes `ews-javascript-api` set
  `Authorization: Basic <base64(user:pass)>` on every request; the default
  `@ewsjs/xhr` transport just forwards it. One short-lived `ExchangeService`
  per action (EWS is stateless HTTP — no session pooling); each carries its own
  credentials, so concurrent connections never share state.
- The server must allow Basic auth on EWS (most on-prem Exchange do; it is
  required for this connector). Always over HTTPS.

## Why Basic, not NTLM (Bun limitation)

NTLM cannot work under the Bun runtime: the handshake requires reading the
server's `WWW-Authenticate: NTLM <challenge>` response header, but **Bun's HTTP
client (fetch and node:https) drops duplicate `WWW-Authenticate` headers**,
keeping only the last (Exchange sends `Negotiate` + `NTLM` + `Basic`). The
challenge therefore never reaches JS, so `@ewsjs/xhr`'s NTLM provider fails
(`Invalid message signature`). Only a raw TLS socket sees all the headers.
Basic auth needs no challenge header, so it works natively under Bun — hence the
choice. (If a deployment ever disables Basic, NTLM would require a curl-backed
or raw-socket transport; not implemented today.)
