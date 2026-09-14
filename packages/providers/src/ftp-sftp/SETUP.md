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

## 2. Why `private-api-bearer` and not `private-api-basic`

Because of a size ceiling, not a preference.

Nango validates credential bodies with strict per-auth-mode schemas
(`packages/server/lib/helpers/validation.ts` in its repo):

| Template             | auth_mode | Accepted fields        | Cap per field |
| -------------------- | --------- | ---------------------- | ------------- |
| `private-api-basic`  | `BASIC`   | `username`, `password` | 1024 chars    |
| `private-api-bearer` | `API_KEY` | `apiKey`               | 4096 chars    |

An SFTP connection can need four secrets — username, password **or** private
key, passphrase — and an RSA private key alone is ~1.7 KB at 2048 bits and
~3.3 KB at 4096. `BASIC` fails on both counts: too few slots, each too small.

Parking the key in `connection_config` is not an option either: Nango's
`EncryptionManager.encryptConnection` encrypts `credentials` and nothing else,
so `connection_config` sits in plaintext in its database.

So the manifest declares a `secretEnvelope`: the frontend packs every
`target: "credentials"` field into one JSON string and sends it as `apiKey`;
`normalizeNangoCredentials` parses it back on read. One encrypted blob, 4096
characters to spend, arbitrary keys. Handlers are unaware — they read
`credentials.private_key` like any other field.

**Operational consequence:** an RSA-8192 key (~6.3 KB) does not fit and Nango
answers HTTP 400. Ed25519 (~400 chars), ECDSA (~300) and RSA up to 4096 all
fit comfortably. If a customer ever brings an 8192-bit key, the answer is a
new key, not a schema change.

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

## 5. Verifying a connection

The form's **Test connection** button connects AND lists the starting folder.
Logging in successfully is not enough to prove a connection works — a
`root_path` typo or a chroot that does not contain the folder authenticates
fine and then answers nothing, which the agent would report as "there are no
files". The failure messages in `test-connection.ts` translate the raw
protocol errors (530, `All configured authentication methods failed`,
`ECONNREFUSED`, self-signed certificates) into the fix each one needs.
