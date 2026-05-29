# `imap-smtp` — operator setup

This file documents the **one-time external setup** an operator must perform before the `imap-smtp` provider can be used. End-user-facing instructions live in `guidance.md` (rendered into the chatbot's `SKILL.md`).

## Nango integration

The provider uses Nango purely as encrypted credential storage — no Nango Proxy, no OAuth flow.

In the self-hosted Nango dashboard:

1. **Integrations → Configure New Integration → Private API (Basic Auth)** (template key `private-api-basic`).
2. **Unique key** : `imap-smtp` — MUST match `nangoProviderConfigKey` in [`manifest.ts`](./manifest.ts).
3. **Display name** : `Email (IMAP/SMTP)`.
4. No redirect URL, no scopes, no base URL (Nango never makes HTTP calls for this integration).

Once created, the Fretik frontend calls headless `nango.auth("imap-smtp", { credentials: { username, password }, params: connection_config })` to store user-supplied credentials. No Connect UI iframe.

## What the user supplies

The descriptor-driven form (see `credentialsForm` in [`manifest.ts`](./manifest.ts)) collects:

- **Account** : `username` (email), `password` — both stored in Nango `credentials`.
- **IMAP** : `imap_host`, `imap_port` (default 993), `imap_secure` (`tls` or `starttls`) — stored in Nango `connection_config`.
- **SMTP** : `smtp_host`, `smtp_port` (default 465), `smtp_secure` (`tls` or `starttls`) — stored in Nango `connection_config`.

A **single password** is shared between IMAP and SMTP (covers Exchange, Gmail with App Passwords, Yahoo, Fastmail, OVH, …). v1 does not support a separate SMTP password.
