# Access and scope

Pbyp cloisons its data on the server. Nothing you send can widen what this connection sees — but a lot of confusing answers become obvious once the model is clear.

## `current_entities` is the whole story

`directus_users.current_entities` is a flat list of entity ids: **the effective scope of the account**. It is written by exactly one thing — `POST /auth-endpoints/profile/:id`, which `activate_profile()` calls — and it holds the profile's entity plus its children and grandchildren.

The rule that follows from it:

```
visible  :  entity_id ∈ current_entities            (owner)
         OR <sharing junction>.entities_id ∈ current_entities
editable :  owner, or shared with can_edit = true
```

| Object                        | Owner column   | Sharing table                                         |
| ----------------------------- | -------------- | ----------------------------------------------------- |
| `orders`                      | `entity_id`    | `orders_entities`                                     |
| `sea_folders` / `air_folders` | `entity_id`    | `{sea,air}_folders_entities`                          |
| `quotations`                  | `entity_id`    | the `client` / `freight_forwarder` columns themselves |
| `address_book`                | `entity_id`    | `address_book_entities`                               |
| `files`                       | `agency_owner` | `files_entities`                                      |

Objects without an owner column inherit from their parent: bookings via their folders, containers via their booking or folders, events via one of their six junctions, parcels via the order / folder / quotation / container they hang off, external references via their object.

**An empty result is not evidence of absence.** It means the rows are outside `current_entities`. Say so — "I cannot see it under the active profile" — and offer `list_profiles()` / `activate_profile()`.

## The entity hierarchy

Three levels: **Head Office → Company → Agency**. Only an **Agency** holds shipments. Activating a profile on a Head Office widens `current_entities` to every company and agency underneath, so the same account can be narrow or wide depending on the profile.

`is_client` splits the world in two:

- **`is_client: false`** — a freight forwarder. Owns folders and bookings, sees its clients' orders, prices its own purchases and sales.
- **`is_client: true`** — a shipper. Sees only what its forwarder shared, has no master folders, and cannot read purchase prices (`quotations_quotes` of `type: "purchases"` are filtered out server-side, not hidden in the UI).

## The five policies

Attached to the `User` role. A sixth, `Pbyp / EDI`, adds to it for gateway accounts.

| Policy                         | Grants                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `Pbyp / Référentiel`           | The world catalogues, read-only: countries, currencies, localities, terminals, carriers, ADR classes, event types, alert types |
| `Pbyp / Compte`                | Self-service: one's own account, profiles, table preferences, alerts                                                           |
| `Pbyp / Exploitation`          | Orders, folders, bookings, containers, parcels, events, addresses, documents and every junction                                |
| `Pbyp / Commercial`            | Quotations, price lines, clients, commercial contacts                                                                          |
| `Pbyp / Administration entité` | Entities, application roles, address book, PDF templates, AI/OCR configuration, alerts, EDI configuration                      |

Consequences you will meet:

- **Row filters union (OR)** — several policies granting the same collection widen access.
- **Validations are conjunctive (AND)** — one policy's validation applies even where another grants unconditionally. A create outside the scope is refused by a validation, not by a filter.
- **Field lists do not union** — each rule is evaluated with _its own_ field list for the rows _its_ filter covers. This is why an entity administrator can fix a colleague's name without gaining access to their credentials.

## Three server guards that will refuse you

These are hooks, not policies, so they answer with a message rather than an empty list.

1. **`ownership-guard`** — on the 22 collections carrying an owner column. You may move an object between two entities of your own scope; you may never change the owner of an object you do not own. **Do not resend `entity_id` on an update at all** — `update_items()` strips it for you. It is the single most common cause of a refused update, because reading a row and writing it back sends the owner along with it.
2. **`junction-guard`** — on the seven `*_entities` junctions plus `containers`. It stops a share from being created toward an entity outside your scope, and stops a read-only share from being escalated.
3. **`address-access`** — `address.access_entities` is maintained by the server. Sending it is ignored.

Beyond that: a share granted with `can_edit: false` really is read-only, all the way down. The parcels, events, files and external references of a shared object are not editable through the share, and neither are the sharing rows themselves — so a read-only partner cannot revoke anyone else's access. Quotations are the deliberate exception: both `client` and `freight_forwarder` are parties, so the client can accept, decline and amend.

## Profiles

An account holds one profile per entity it works in. Only one is active.

```python
me = pbyp.whoami()
if me.entity_name != "Fatton Nantes":
    for p in pbyp.list_profiles():
        if p.entity_name == "Fatton Nantes":
            pbyp.activate_profile(profile_id=p.id).op()
```

**Activating a profile changes the account, not just this connection.** The person's own Pbyp session moves with it, and if they switch profile in Pbyp this connection follows. Say so before switching, and prefer answering under the current profile when the data is reachable there.

## Gateway accounts

An EDI gateway is an account too, with no profile: its `current_entities` is set when the gateway is created. Its `token` is `gateway_external.access_key`. That value is stripped from every response here — it is a partner's credential, and a credential that reaches a transcript has been published.
