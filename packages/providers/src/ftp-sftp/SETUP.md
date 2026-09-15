# `ftp-sftp` — operator setup

Operator-facing only (NOT shown to the chatbot). For agent-facing rules, see
`guidance.md` in the same folder.

## 1. Provision the Nango integration

Nango is used purely as encrypted credential storage — no Nango Proxy, no
OAuth flow, no HTTP call ever leaves Nango for this provider.

1. Open the self-hosted Nango dashboard.
2. **Integrations → Configure New Integration → Private API (Bearer Auth)**
   (template key `private-api-bearer`, `auth_mode: API_KEY`).
3. **Unique key**: `ftp-sftp` — MUST match `nangoProviderConfigKey` in
   [`manifest.ts`](./manifest.ts).
4. **Display name**: `File transfer (FTP/SFTP)`.
5. No client id / secret, no redirect URL, no scopes, no base URL.

The template's own `Authorization: Bearer ${apiKey}` projection is irrelevant
— we never call `nango.proxy`.

## 2. Credential storage — one encrypted slot, 4096 characters

Requires **Nango ≥ v0.71.6**, which is where the `apiKey` credential cap went
from 1024 characters to 4096. Production runs 0.71.7, so every SSH key type
below RSA-8192 fits; keep the floor in mind only when standing up a new
instance or pinning an old image.

### 2.1 Why `private-api-bearer` and not `private-api-basic`

Because of a size ceiling, not a preference.

Nango validates credential bodies with strict per-auth-mode schemas
(`packages/server/lib/helpers/validation.ts` in its repo):

| Template             | auth_mode | Accepted fields        | Cap per field                       |
| -------------------- | --------- | ---------------------- | ----------------------------------- |
| `private-api-basic`  | `BASIC`   | `username`, `password` | 1024 chars — unchanged to this day  |
| `private-api-bearer` | `API_KEY` | `apiKey`               | **4096** chars (1024 before 0.71.6) |

An SFTP connection can need four secrets — username, password **or** private
key, passphrase — and an RSA private key alone is ~1.7 KB at 2048 bits and
~3.3 KB at 4096. `BASIC` fails on both counts: too few slots, each too small.

Parking the key in `connection_config` is not an option either: Nango's
`EncryptionManager.encryptConnection` encrypts `credentials` and nothing else,
so `connection_config` sits in plaintext in its database.

So the manifest declares a `secretEnvelope`: the frontend packs every
`target: "credentials"` field into one JSON string and sends it as `apiKey`;
`normalizeNangoCredentials` parses it back on read. One encrypted blob,
arbitrary keys, and the `apiKey` cap is the only budget. Handlers are unaware
— they read `credentials.private_key` like any other field.

### 2.2 What fits in 4096

Measured, not estimated: `JSON.stringify({ username, private_key })` for a
freshly generated key and a 6-character username. A passphrase adds its own
length plus ~16 characters of JSON.

| Key type                    | Packed envelope | Fits |
| --------------------------- | --------------- | ---- |
| password only               | ~100 chars      | ✅   |
| ed25519                     | 444 chars       | ✅   |
| ECDSA P-256                 | 538 chars       | ✅   |
| RSA-2048 (`-m PEM`, PKCS#1) | 1 740 chars     | ✅   |
| RSA-2048 (OpenSSH default)  | 1 876 chars     | ✅   |
| RSA-4096 (OpenSSH default)  | 3 456 chars     | ✅   |
| RSA-8192 (OpenSSH default)  | ~6.6 KB         | ❌   |

RSA-8192 is the only thing that does not fit, and there is no encoding that
rescues it: a PEM body is already base64, so gzip buys back exactly what
re-encoding costs. The answer is a new key — ed25519 for preference, which is
a seventh of the size and what the form's help text recommends.

### 2.3 An oversized credential is refused at SAVE time, silently

Worth knowing because the shape is confusing rather than rare. Nango answers:

```json
{
  "error": {
    "code": "invalid_body",
    "errors": [
      {
        "code": "too_big",
        "message": "Too big: expected string to have <=4096 characters",
        "path": ["apiKey"]
      }
    ]
  }
}
```

Two things make it expensive to diagnose:

- **Test connection passes.** It talks to the customer's file server and never
  touches Nango. Only the save writes credentials, so the green check means
  nothing about whether they can be stored.
- **The message is empty in the UI.** `@nangohq/frontend` throws
  `new AuthError(errorResponse.error.message, …)` and a validation body carries
  `code` + `errors[]` with no `message` — so the SDK discards exactly the part
  that names the field. Still true as of 0.71.7. The frontend's
  `describeNangoAuthError` measures the payload itself and substitutes a real
  message; without it the user sees nothing and has to open the network tab.

The same body, with `<=1024` instead of `<=4096`, means the instance is older
than v0.71.6 — check the version before touching the key.

## 3. What the user supplies

The descriptor-driven form (see `credentialsForm` in [`manifest.ts`](./manifest.ts)):

**Server**

- `protocol` — `sftp` (default) / `ftps` (explicit TLS) / `ftps-implicit`
  (legacy port 990) / `ftp` (no encryption).
- `host`.
- `port` — optional. Blank means the protocol's standard port: SFTP 22,
  FTP and FTPS 21, implicit FTPS 990.

**Authentication**

- `username`.
- `auth_method` — `password` (default) or `private_key`. Drives which of the
  fields below is shown; SSH keys are an SFTP feature and the connection test
  refuses the combination on FTP/FTPS.
- `password`, or `private_key` (+ optional `passphrase`).

**Advanced** (collapsed)

- `root_path` — pin the connection to one folder. Every path the agent sends
  and receives is then relative to it, and a path that would climb out is
  refused.
- `host_fingerprint` — SFTP only. Pin the server's host key. Accepts OpenSSH's
  `SHA256:…` (what `ssh-keyscan host | ssh-keygen -lf -` prints) or a hex MD5.
  Left empty, any host key is accepted — the default every comparable product
  ships, and the only one that can work on a first connection.
- `allow_self_signed_cert` — FTPS only. Needed by a lot of on-premise servers
  running their own certificate authority.

## 4. Egress

Both protocols leave from the API/worker process, not from the chatbot
sandbox. Outbound TCP to the customer's port (22 / 21 / 990, plus the passive
data-port range an FTP server advertises) has to be reachable from wherever
`@fretik/api` runs. `basic-ftp` is passive-only, which is the right side of
that trade: active mode would need the SERVER to open a connection back to us.

If a customer's server firewalls by source IP, they need the platform's
egress address allow-listed on their side.

## 5. Behaviours worth knowing before the first support ticket

All three were measured against a live vsftpd 3.0.5 and a live OpenSSH 9.6
sftp subsystem, not reasoned about.

**One call at a time, per connection.** The manifest declares
`concurrency: { mode: "serial", maxWaitMs: 60_000 }`. Each action opens its
own session, and a file server caps concurrent sessions per LOGIN — an EDI
account is routinely limited to one or two, and exceeding it answers `421
Too many connections`, which reads exactly like bad credentials. A customer
whose server is comfortable with parallel sessions can relax it per account
via `external_app_connections.concurrency_mode`.

**A 25-second ceiling per action.** `@fretik/api` serves with
`idleTimeout: 30`, and Bun applies that to a request whose HANDLER is slow,
not merely to an idle socket (measured: a handler sleeping 6 s behind
`idleTimeout: 3` loses its connection at 4 s). Past that the call does not
return an error, it loses the connection — and on an upload that means the
bytes landed while the agent was told they did not. The provider finishes
first, with a message saying to send fewer files.

**FTP downloads are verified against the announced size, and retried once.**
Over 1 000 downloads from a stock vsftpd on localhost, **10 came back empty
with no error at all** — FTP opens a separate data connection per transfer,
and on a fast server the payload and its FIN can arrive before the control
channel's `150` reply is parsed and the reader attached. Nothing in the
protocol reports it. Every one of the 10 succeeded on the retry, and the
`[ftp-sftp] short read on …` warning in the logs is that happening. A second
short read is reported to the agent as a failed transfer rather than
returned as content. A bare FTP server offering neither `SIZE` nor `MLSD`
announces no size and cannot be checked this way — worth knowing if a
customer reports an empty file on one.

## 6. Verifying a connection

The form's **Test connection** button connects AND lists the starting folder.
Logging in successfully is not enough to prove a connection works — a
`root_path` typo or a chroot that does not contain the folder authenticates
fine and then answers nothing, which the agent would report as "there are no
files". The failure messages in `test-connection.ts` translate the raw
protocol errors (530, `All configured authentication methods failed`,
`ECONNREFUSED`, self-signed certificates) into the fix each one needs.
