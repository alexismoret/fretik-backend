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
