---
name: pbyp
description: Pbyp — freight-forwarding TMS (sea & air): orders, transport folders, voyages and flights with their carrier, containers, cargo lines, tracking events, quotations, address book, and EDI transfers to partner gateways such as PTD.
version: 16d7e9ff2c18
---

# Pbyp — 37 actions

You can interact with the user's Pbyp account via the `fretik_apps.pbyp` Python module.

## Read actions (auto-approved, eager)

- `pbyp.describe_collection(collections)` — The shape of up to 5 collections at once. Returns ONE ROW PER COLUMN — a flat list across every collection asked for, each row carrying its own `collection` — with whether the column is required or computed, a dropdown's allowed values, and for a link the exact path to write in fields or filter.
- `pbyp.query_items(collection, filter=None, fields=None, include_archived=False, sort=None, limit=25, page=1, search=None, deep=None, aggregate=None, group_by=None)` — Read or count any collection: filter, nested field paths, sort, search, deep, aggregate. This is how you find things — there is no separate search action.
- `pbyp.upload_file(filename, content_base64, content_type=None)` — Store a file's bytes in Pbyp and return the id to link it with. It is attached to NOTHING on its own — see 'Filing a document' in the guidance for the create_items call that puts it in an order's or a folder's GED.
- `pbyp.whoami()` — Who this connection acts as: the active profile, its entity, whether it is a forwarder or a client, and the entity ids it can see.
- `pbyp.list_profiles()` — The profiles this account holds. Only one is active at a time — activate_profile() switches.
- `pbyp.list_events(target_type, target_id, limit=25)` — The event history of one object, most recent first — the milestones that drive its status.
- `pbyp.list_event_types(module=None, category=None)` — The event catalogue: which milestone codes exist, for which module, and what they can be attached to.
- `pbyp.list_gateways()` — EDI gateways this account can see — the partners an object can be transferred to (PTD, …).
- `pbyp.count_by_status(object, module=None, date_from=None, date_to=None)` — How many objects sit in each shipping status over a date window — the answer to 'how many are in transit'.
- `pbyp.next_order_number(module)` — This month's next order sequence. Assemble the number as <entity_id>O<month_key><counter>.
- `pbyp.next_quotation_number()` — This month's next quotation sequence. Assemble the number as Q<entity_id><month_key><counter>.

## Write actions (require user approval — build with `.op()`)

- `pbyp.create_items.op(collection, items)` — Create one or more rows in any writable collection. Computed columns are stripped and reported back.
- `pbyp.update_items.op(collection, ids, data)` — Apply the same change to one or more rows of a collection, by id.
- `pbyp.delete_items.op(collection, ids)` — Permanently delete rows. Refused on orders, folders, bookings, containers and quotations — cancel those with archive().
- `pbyp.create_order.op(module, number, date, incoterm, entity_id, shipper, consignee, client_reference=None, billing_reference=None, comments=None, pickup_date=None, delivery_date=None, available_date=None, deadline=None, parcels=None, parcels_description=None, parcels_price=None, parcels_price_currency=None, folder_id=None, shared_with=None)` — Create an order: parties, incoterm, dates and cargo lines in one call.
- `pbyp.create_folder.op(module, folder_type, date, incoterm, entity_id, shipper, consignee, payer_id=None, master_id=None, voyage_id=None, client_reference=None, billing_reference=None, comments=None, pickup_date=None, delivery_date=None, order_ids=None, parcels=None, shared_with=None)` — Create a transport folder — the file for one shipment. The folder number is assigned by Pbyp.
- `pbyp.create_sea_booking.op(booking_number, entity_id, booking_type, departure_terminal, arrival_terminal, ETD, ETA, ship_name=None, voyage_number=None, BL_number=None, agent_code=None, company_id=None, custom_company=None, containers=None)` — Create a sea voyage, optionally with its containers.
- `pbyp.create_air_booking.op(booking_number, entity_id, booking_type, LTA, flights, voyage_number=None, agent_code=None, airline_company=None, custom_company=None)` — Create an air booking with its flight legs. ETD, ETA and the terminals are derived from the legs.
- `pbyp.create_quotation.op(number, entity_id, transport_type, booking_type, incoterm, margin, counterparty, shipper, consignee, departure_terminal, arrival_terminal, etd, eta, validity_start_date=None, validity_end_date=None, comments=None, parcels=None, quotes=None)` — Create a quotation with its purchase and sale lines.
- `pbyp.add_event.op(target_type, target_id, event_type_id, date, actual=None, terminal_id=None, address_id=None, comments=None)` — Record a milestone on one object. Events drive shipping_status — this is how a shipment advances.
- `pbyp.set_parcels.op(target_type, target_id, parcels)` — Replace the cargo lines of an order or a folder. The previous list is dropped.
- `pbyp.attach_order_to_folder.op(module, order_id, folder_id)` — Link an order to a folder of the same module.
- `pbyp.detach_order_from_folder.op(module, order_id, folder_id)` — Unlink an order from a folder.
- `pbyp.share_with_entity.op(object, object_id, entity_id, can_edit=False)` — Give another entity access to an order or a folder — it will see it in its own Pbyp.
- `pbyp.revoke_share.op(object, object_id, entity_id)` — Remove an entity's access to an order or a folder.
- `pbyp.archive.op(object, object_id)` — Cancel an object. Pbyp archives rather than deletes: the status becomes CANCELED and the cancellation cascades.
- `pbyp.set_quotation_status.op(quotation_id, quotation_status)` — Move a quotation through its workflow.
- `pbyp.transfer_to_gateway.op(object, object_id, gateway_id, external_reference=None)` — Enrol an object in an EDI gateway (PTD, …) so the partner picks it up on its next pull.
- `pbyp.assign_containers.op(scope, items)` — Stuff an order's or a folder's cargo into containers — fully, or line by line across several boxes.
- `pbyp.unassign_parcel_container.op(scope, target_id, parcel_id)` — Take one cargo line back out of its container. The quantity returns to the unassigned line.
- `pbyp.activate_profile.op(profile_id)` — Switch the active profile. This changes what this connection — and the user's own Pbyp session — can see.
- `pbyp.create_gateway.op(gateway_type, external_code, entity_id)` — Create an EDI gateway for an entity — this also creates the partner's access account.
- `pbyp.update_gateway.op(gateway_id, gateway_type, external_code)` — Change an existing gateway's partner type or code.
- `pbyp.declare_tracking.op(module, booking_id)` — Register a booking with the carrier tracking service, so events start arriving on their own.
- `pbyp.create_lta_stock.op(first_awb, last_awb, airline_company, entity_id)` — Reserve a range of air waybill numbers for an entity and an airline.
- `pbyp.invite_user.op(first_name, last_name, email, role_id, entity_id, phone=None)` — Invite someone to an entity with a role. They receive an e-mail invitation.
- `pbyp.create_client.op(agency_id, name, admin_user, commercial, address)` — Create a client company under an agency: the entity, its address book, its roles and its first admin account.

## Data models

Read actions return Pydantic models — field names below are EXACT. Use the names as-is (`m.from_address`, NOT `m.sender` or `m.from_`). A trailing `?` marks an optional field.

- `Me` — `user_id: str`, `email: str`, `name: str`, `profile_id?: int`, `profile_role?: str`, `entity_id?: int`, `entity_name?: str`, `is_client?: bool`, `current_entities: list[int]`
- `Profile` — `id: int`, `entity_id: int`, `entity_name: str`, `role?: str`, `is_client?: bool`
- `FieldDoc` — `collection: str`, `field: str`, `type: str`, `required?: bool`, `computed?: bool`, `links_to?: str`, `path?: str`, `choices?: list[str]`, `note?: str`
- `StoredFile` — `id: str`, `filename_download: str`, `type: str`, `filesize: int`
- `Event` — `id: int`, `code: str`, `type_id: int`, `label?: str`, `date: str`, `actual: bool`, `source: str`, `terminal?: str`, `address?: str`, `comments?: str`
- `EventType` — `id: int`, `code: str`, `label?: str`, `modules: list[str]`, `category: list[str]`
- `Gateway` — `id: int`, `external_code: str`, `gateway_type: int`, `gateway_label?: str`, `entity_id?: int`, `status?: str`
- `StatusCount` — `shipping_status: str`, `count: int`
- `Counter` — `counter: str`, `month_key: str`, `pattern: str`


## What Pbyp is

A TMS for freight forwarders and their shipper clients, sea and air. Everything hangs off four families:

- **order** — what a client asked to have moved. Carries the cargo, the parties, the incoterm.
- **folder** (`sea_folders` / `air_folders`) — the file the forwarder opens for a shipment: parties, cargo, references, and the voyage it travels on. `single`, or a `master` grouping several `house` folders. Identified by `folder_number`. **A folder is NOT a bill of lading** — do not call it one.
- **booking** (`sea_bookings` / `air_bookings`) — the voyage or the flight, and the ONLY place the carrier lives: the shipping line or airline, the vessel, both terminals, the schedule, and the carrier's own document — `BL_number` at sea, `LTA` (air waybill) in the air. Sea bookings carry **containers**.
- **event** — a dated milestone. Events are what make a shipment advance; nothing else does.

Sea and air are separate tables all the way down. Pick the module explicitly — a user saying "my shipment" has one in mind, and guessing puts the answer in the wrong half of the database.

## Start every session with `whoami()`

It returns the active profile, its entity, and `is_client`. That last flag changes what the same question means:

- `is_client: false` — a **freight forwarder**. Sees its own agencies plus the clients attached to them. Speaks in BL, AWB, FCL/LCL, POL/POD.
- `is_client: true` — a **shipper**. Sees only what was shared with it, never master folders, never purchase prices. Explain the jargon.

Scope is enforced by the server through `current_entities`. **An empty result means "not in your scope", not "does not exist"** — never tell the user a shipment is missing on that basis; say you cannot see it under the active profile.

## Reading

`query_items` is the only finder — there is no search action. Two calls answer almost any question: one `describe_collection` for the tables involved, one cell that queries them.

**NEVER guess a field path.** `describe_collection(["orders", "air_folders"])` returns **one row per column**, flat across every collection asked for — each row carries its own `collection`, so group them yourself (`[f for f in docs if f.collection == "orders"]`). A row says whether the column is `required` or `computed`, its `choices`, and for a link the `path` — the literal prefix to write. Copy it. Ask for every table your question touches in one call, up to five.

The reason guessing is unrecoverable here: **Directus ignores an invalid path instead of rejecting it**, and hands back the raw foreign key. So a wrong path does not look like a mistake, it looks like "nested fields don't work" — and the tempting next move, pulling both tables and joining by hand, is how a one-call question becomes fifteen. A nested field that comes back as a bare number means your path is wrong. Call `describe_collection`, do not guess twice.

- **Resolve names in the same query.** `fields=["consignee.name", "consignee.country_id.name", "voyage_id.arrival_terminal.name"]`. An id column that points at a table is a link like any other. Never collect ids and look them up in a second query.
- **A many-to-many is read through its junction key**, which `path` gives you: `air_folders.air_folders_id.folder_number`. Asking for `air_folders.id` returns the JUNCTION row's id — no error, and every join built on it is wrong.
- **Count on the server.** "Which X the most / how many per Y" is one grouped read: `aggregate={"count": "id"}, group_by=["companies"]`. Never pull rows to tally them. `group_by` takes a column of the collection itself — a path through a link answers 500. Counts come back nested and as strings: `int(row["count"]["id"])`.
- **Count on the collection that OWNS the column.** Counting it from a neighbour answers a different question and silently drops every row whose link is empty. Both numbers are right; they are not comparable. Say which collection you counted, and never put two such counts side by side as one table.
- **Batch.** One `python` cell can run every query your plan needs; they cost one tool call together and several apart.
- Omit `fields` on orders, folders, bookings and containers and you get a curated set with the parties, carrier and terminals already resolved.
- Archived rows are excluded unless you pass `include_archived=True` — Pbyp cancels by archiving, so an unfiltered count would include cancellations.

A filter is `{field: {operator: value}}`; dots walk relations. Operators: `_eq` `_neq` · `_in` `_nin` · `_lt` `_lte` `_gt` `_gte` · `_null` `_nnull` (value `true`) · `_contains` `_icontains` · `_starts_with` `_ends_with` · `_between` (`[low, high]`) · `_and` `_or` (a list of filters).

```python
pbyp.query_items(
    collection="air_folders",
    filter={"consignee": {"name": {"_icontains": "longchamp"}}},
    fields=["folder_number", "date", "consignee.name",
            "consignee.country_id.name", "voyage_id.arrival_terminal.name"],
    limit=100,
)
```

**When a query comes back empty**, in order of likelihood: the row is outside `current_entities`; it is archived and you did not ask for archived; you are in the wrong module's table; the reference the user gave is a client reference and you filtered on `number`. Say which you checked rather than reporting that the shipment does not exist.

## Writing

1. **NEVER write a computed column.** `describe_collection` flags them `computed`. They are stripped and reported back in `stripped`; a value you send survives only until the hook next runs, then contradicts itself.
2. **Archive, never delete.** `archive()` sets `status: "archived"`, which derives `CANCELED` and cascades. `delete_items()` refuses orders, folders, bookings, containers and quotations.
3. **A status changes by adding an event**, never by writing the status. `add_event()` is how a shipment moves.
4. **Exactly one target per event.** `add_event()` builds the junction for you — use it rather than `create_items("events", …)`.
5. **`address` is not `address_book`.** `address` is a party ON a shipment (a copy, frozen at the time). `address_book` is the reusable directory. Creating a shipment does not touch the directory.
6. **Many-to-many lists take junction rows**, not ids: `parcels: [{"parcels_id": 41}]`. Bare ids are accepted and silently link the wrong rows.
7. **Cargo lists replace.** `set_parcels()` drops the previous lines. Read them first if you mean to add one.
8. **Numbers come from `next_order_number()` / `next_quotation_number()`** and their `pattern`. Folder numbers are assigned by Pbyp — never supply one.
9. **Days and instants are different.** `date`, `delivery_date`, `validity_*` are `YYYY-MM-DD`. `ETD`, `ETA`, `pickup_date`, `deadline`, event dates are full ISO timestamps.

## Choosing an action

A typed action exists only where the shape or the consequence needs one; its name says what it does. Four routing decisions are not obvious from the names:

- **Anything you want to find, list, count or analyse** → `query_items`. There is no search action.
- **Anything you want to change** → `update_items`, whatever the collection and whatever the typed action that created it.
- **Cancel** → `archive`, never `delete_items`.
- **Any of the other 91 collections** → `create_items` / `update_items`, shapes in `references/payloads.md`.

French vocabulary maps as: dossier → folder, commande → order, voyage/booking → booking, conteneur → container, colis/marchandise → parcel (cargo line), cotation → quotation, carnet d'adresses → address_book, passerelle → gateway, enlèvement → pickup, livraison → delivery, POL/POD → departure/arrival terminal, transitaire → freight forwarder, chargeur → shipper, destinataire → consignee.

## Recipes

**Where is this container?**

```python
c = pbyp.query_items(collection="containers",
                     filter={"number": {"_eq": "CMAU0945402"}})["items"][0]
events = pbyp.list_events(target_type="container", target_id=c["id"])
# events[0] is the most recent; `actual` False means it is still forecast.
```

**Record a milestone.**

```python
types = pbyp.list_event_types(module="sea", category="folder")
pickup = next(t for t in types if "pickup" in (t.label or "").lower())
pbyp.add_event(
    target_type="sea_folder", target_id=folder_id,
    event_type_id=pickup.id, date="2026-09-07T08:00:00Z", actual=True,
).op()
```

A repeat of the same milestone comes back as `deduplicated: True`. That is a success — Pbyp updated the existing event. Do not retry.

**File a document in an order's or a folder's GED.**

Two calls: the bytes, then the link. `upload_file` on its own files nothing — an uploaded file no row points at is unreachable.

```python
import base64, pathlib
f = pbyp.upload_file(
    filename="BL-CMA-2026-001.pdf",
    content_base64=base64.b64encode(pathlib.Path(src).read_bytes()).decode(),
)
pbyp.create_items(                       # sea_folders_files / air_folders_files,
    collection="orders_files",           # keyed by sea_folders_id / air_folders_id
    items=[{"orders_id": order_id,
            "files_id": {"file": f.id, "agency_owner": entity_id, "tags": "invoice"}}],
).op()
```

`agency_owner` is the entity that owns the shipment — read it off the target (`entity_id`), never off `whoami()`, which is the profile's own agency and differs on a multi-agency account. `tags` is the document kind, one of `files_type.type`: claims, deliveries, suppliers, invoice, others.

**Send a folder to PTD.**

```python
gw = next(g for g in pbyp.list_gateways() if g.gateway_label == "PTD")
pbyp.transfer_to_gateway(object="sea_folder", object_id=folder_id, gateway_id=gw.id).op()
```

This enrols the folder in the partner's journal; PTD collects it on its next pull and acknowledges. Preconditions and pitfalls: `references/edi-ptd.md`.

## References

Read one when the task calls for it, not upfront. Shapes come from `describe_collection`, not from here.

- `collections.md` — what each collection MEANS: who owns which column, the conditional obligations, what a client cannot see.
- `access-and-scope.md` — profiles, scope, what the server refuses.
- `status-and-events.md` — the event catalogue and the exact rules that derive every `shipping_status`.
- `edi-ptd.md` — gateways, the journal, transferring to a partner, transcoding, the traps.
- `payloads.md` — the create shapes the schema cannot express: nested creates, junctions, numbering.
- `quotations.md` — the quotation workflow and its conversion into a shipment.

---

## Write actions & approval

Write actions NEVER execute on their own: `.op(...)` builds an operation,
`run_plan([...])` submits them, and calling a write action directly raises.
The user approves the whole plan at once.

- One write:   `run_plan([ pbyp.create_items.op(collection="…", items=[{…}]) ])`
- Many writes: `run_plan([ pbyp.<action>.op(...), ... ])`

`run_plan` raises `fretik_apps.ApprovalPending`. This is EXPECTED — not an
error. Stop there. Never wrap it in `try/except` (that hides the approval
card), and never `print` the ops as a preview instead of calling it — no
call, no plan.

Once the user decides, the outcome replaces that same tool result. It covers
only the operations it lists: if any code sat AFTER the `run_plan` call,
re-run the identical cell — approved plans replay from cache and never execute
twice. On rejection you get their feedback — adapt and write new code.

### STRONG RULE — read→write flows
When a plan depends on data you just read, you MUST inline the read
results as EXPLICIT LITERALS in the `.op()` calls. Do NOT compute
`.op()` arguments from a read performed in the same script as
`run_plan`.

Correct: read in one turn, inspect the results, THEN in the next turn
write `run_plan([...])` with concrete IDs / addresses as literals.

Why: on re-run after approval, a volatile read (inbox changed) would
change the plan's lookupHash and force a needless re-approval.

### Plan rules
- Every write of the turn goes in ONE `run_plan`. A second call in the
  same cell is lost: the first raises and the rest of the cell never runs.
- Operations in one plan must be INDEPENDENT (no op uses another op's
  result). Dependent steps (create_folder, then move into it) → use
  TWO turns.
- A plan may mix actions from several apps — one approval for all of them.
- Partial failures come back per-op; re-submit a `run_plan` with only
  the failed ops.
