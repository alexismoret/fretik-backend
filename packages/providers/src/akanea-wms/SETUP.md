# Akanea WMS — operator setup

Not agent-facing. The chatbot never reads this file.

## 1. Nango integration

Create an integration in the self-hosted Nango dashboard:

- Template: **`private-api-basic`** (no client id / secret — it is credential storage only).
- Unique key: **`akanea-wms`** (must match `manifest.nangoProviderConfigKey`).

The form maps onto it as: `user_id → credentials.username` (via `nangoKey`), `password → credentials.password`, `base_url` and `access_id` → `connection_config`.

## 2. What the customer must provide

- **Server URL** — the root of their Xtent install, e.g. `https://xtent.customer.com`. It must be reachable over **public HTTPS**: our backend calls it directly, and `assertPublicHttpsUrl` rejects private, internal or plain-http hosts. An on-premises Xtent with no public endpoint cannot be integrated. For local development against such a host, set `EXTERNAL_APPS_ALLOW_PRIVATE_URLS=true`.
- **Access ID, user, password** — issued by Akanea with the web-service licence.

## 3. Prerequisites on the Akanea side

The vendor documentation makes these mandatory; without them every integration call is rejected:

- each warehouse customer (_stockeur_) involved must be configured in Xtent;
- the matching **integration flow** must be added to each of them;
- **integration via web services** must be explicitly authorised for them.

## 4. License seats — why every call leases and releases

Xtent authenticates with `GetToken` / `ReleaseToken`, and a token holds a **license seat** for as long as it is alive. The vendor warns that failing to release leaves the seat consumed and can lock the customer out of their own WMS.

`client.ts` therefore leases one token per action and releases it in a `finally`; a failed release is logged (`[akanea-wms] ReleaseToken failed`) and never masks the original error. There is no token cache — the seat window stays as short as possible.

Make sure the customer has at least one web-service seat provisioned. Xtent answers HTTP 200 both for bad credentials and for a saturated pool, so `getToken` deliberately attaches **no** HTTP status to that failure: `isAuthFailure` only disables a connection on a real 401/403, and a momentarily full seat pool surfaces as a transient error instead.

## 5. Observed against a live install (2026-08-06)

Measured on a customer's production server, resolving what the vendor documentation left ambiguous:

| Question               | Answer                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GetToken` envelope    | Bare JSON string, 26 characters — `extractToken` takes it on its first branch                                                                                                                        |
| Response casing        | **PascalCase** (117 of 118 fields). The case-insensitive lookup in `normalize.ts` stays as cheap insurance for other installs                                                                        |
| Date format            | **ISO without any offset** — `2026-08-05T15:30:03`, the warehouse's local wall clock                                                                                                                 |
| Header-only projection | **`metaId`** is the key that applies: `GetPreparations` drops from 10.2 MB / 118 fields to 2.35 MB / 106. The `meta` spelling in the vendor's own example is silently ignored, and is no longer sent |
| Error envelope         | **WCF XML `<Fault>` returned with HTTP 200**, not JSON. The only actionable sentence is in `<Reason><Text>`                                                                                          |

Two consequences are load-bearing and are pinned by tests:

- **Dates are never parsed.** `akaneaDate` passes offset-less timestamps through untouched. Feeding them to `Date` would read them in the Fretik server's timezone and re-emit them in UTC, moving a dock appointment by hours.
- **Faults are extracted before JSON parsing.** `faultMessage` lifts `<Reason><Text>` so the agent reads "Le filtre n'est pas valide: No property or field 'Foo' exists in type 'EnItem'" and can repair its own filter, instead of a truncated blob of markup.

Payload volume is worth knowing: 844 preparations over 7 days weigh ~2.3 MB even with the projection. The `limit` param (200 by default) caps what reaches the sandbox, but the warehouse still pays for the scan — filters matter.

## 6. `upsert_parties` is unavailable on the tested install

Posting an EMPTY list (so nothing could be created) to `IntegrationWebServices/Parties` returned **HTTP 404** for `listPartys`, for `listParties`, **and for a deliberately nonsensical parameter name** — while the three sibling routes answered `{"result":{}}` to the same empty-list treatment:

| Route                                 | Empty-list POST                                        |
| ------------------------------------- | ------------------------------------------------------ |
| `IntegrationWebServices/Receptions`   | HTTP 200 `{"result":{}}`                               |
| `IntegrationWebServices/Items`        | HTTP 200 `{"result":{}}`                               |
| `IntegrationWebServices/StockChanges` | HTTP 200 `{"result":{}}`                               |
| `IntegrationWebServices/Parties`      | HTTP 404 (IIS error page), whatever the parameter name |

Identical answers for a nonsense key rule out parameter binding: **the operation itself is not published on that server**. So this is not a `listPartys`/`listParties` question — that one stays open and unanswerable until an install exposes the route.

The action is kept in the manifest (the vendor documents it, and another install may publish it). A 404 on any web service now produces an explicit message — "Akanea WMS does not expose the … web service on this server" — instead of the raw IIS page, so the agent reports the capability as missing rather than retrying.

If a customer needs party sync, ask Akanea to publish the operation and enable the parties integration flow for the stockeur (§3). To re-test afterwards without creating anything, POST `{"token": "…", "listPartys": []}` to the route: an empty list binds the parameter without submitting an entity, so a `{"result":{}}` answer means the route is live.

## 7. Still open

- **The parties result collection.** `EnResultIntegrationWebServices` documents result lists for receptions, preparations, items and stock movements, but none for parties. `handlers.ts` probes both `ResultOfPartiesIntegration` and `ResultOfPartysIntegration`; drop the dead name once one is observed on a server that publishes the route.
- Whether `LineNumber` must be a quoted string (we send a JSON number, as its declared numeric type implies), and whether `InternalItemId` accepts the item code — the vendor's own example repeats the item code there, which is what we default to when the agent omits it.
- The empty-list controls confirm the `{"result": …}` envelope, but an ACCEPTED write (non-empty payload) is still needed to observe `FlowsId`, `XtentReceptionId` and the per-entity error shape in the flesh.

## 8. Smoke test

1. Settings → External apps → Akanea WMS → fill the four fields → **Test connection** (leases and releases a token).
2. In the chatbot, ask for stock on a known item — the agent should read `skills/akanea-wms/SKILL.md` first, then call `get_item_quantities` with a filter.
3. For a write, check the approval card's title and fields BEFORE approving. On a production server, the safest first write is a reception created for a test stockeur and left unvalidated — `upsert_parties` is NOT the harmless option it looks like, since §6 shows it may not be published at all.
