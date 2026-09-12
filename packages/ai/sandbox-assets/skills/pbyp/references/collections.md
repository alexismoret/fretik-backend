# Collections — what they mean

91 business collections. **This file does not list columns.** `describe_collection([...])` does, live and always current: types, what is required, what a hook computes, the allowed values, and the exact path to follow a link. Here is only what a schema cannot say — the rules behind the columns.

## The four families

**`orders`** — what a client asked to have moved: the cargo, the two parties, the incoterm. Numbered `<entity_id>O<YYYYMM><NNNN>` from `next_order_number()`.

**`sea_folders` / `air_folders`** — the file the forwarder opens for one shipment. It is **not** a bill of lading: the carrier's document number lives on the booking (`BL_number` / `LTA`), and a folder has no such column.

- `folder_type` is `single`, `master`, or `house`. A `house` **must** name its `master_id`; a `master` is the only kind that may omit `payer_id`.
- `folder_number` is assigned by Pbyp, never supplied. **Its month is 0-indexed** — January is `00` — so never reconstruct one by hand to search with.
- `voyage_id` is the only route to the carrier, the terminals and the schedule, and it is **optional** — a folder can exist with no voyage attached.

**`sea_bookings` / `air_bookings`** — the voyage or the flight.

- `booking_type` (`import` / `export`) is the direction **for this agency**. It has nothing to do with master/house.
- The carrier is a link to `oversea_companies`, or `custom_company` free text when the line is not in the catalogue. Read the name through the link; both fields can be empty.
- Sea carries its own route and schedule. **Air recomputes them from `flights`** on the create filter, which is why an air booking is created with legs and no route of its own — but the terminal columns are stored, so read them rather than the legs, which can be empty on bookings that arrived through EDI.
- `air_bookings_flights` is one leg: `pol`, `pod`, `etd`, `eta`, `number`.
- `ATD` / `ATA` mirror the departure and arrival events. They are consequences, never inputs.

**`events`** — the milestones. Exactly ONE of the six junctions must be present on a row. Events are the only thing that moves a `shipping_status`; the derivation rules are in `status-and-events.md`.

## Cargo

A **parcel** is one cargo line. It belongs to an order, a folder or a quotation through a junction, and optionally to a container. `taxable_weight` is the billed weight — `max(weight, volume × 1000)` at sea, `× 167` in the air — and Pbyp computes it when omitted.

A **container** hangs off a sea booking, and is linked to the orders and folders whose cargo it carries. Its number is ISO 6346 and the check digit is verified before the call leaves.

## Parties and organisation

- `entities` — an agency, a company or a head office. **Only an Agency holds shipments.** Created by `create_client()`, never by hand: the call also provisions the address book, the roles and the first admin account.
- `profiles` — the `(user, entity, role)` triple that decides what a person may do and where. Created by `invite_user()`.
- `entities_clients` links a forwarder to a client and carries the account manager.
- `customers` are contacts at a client company — people, not accounts.

## Addresses — two different things

- `address` is a party **on a shipment**: a copy, frozen when the shipment was created.
- `address_book` is the reusable directory, per entity.

Creating a shipment does not add to the directory, and editing a directory entry does not change any past shipment. `address.access_entities` is maintained by a hook; a write to it is refused.

## Documents

A document is two rows. `files` is Pbyp's register — who owns it (`agency_owner`), its kind (`tags`, a value of `files_type.type`), who else may see it — and it has **no name column**: the filename lives on Directus' own `directus_files`, which `files.file` points at. A junction (`orders_files`, `sea_folders_files`, `air_folders_files`, `files_entities`) attaches the register row to what it documents; a `files` row no junction names is filed nowhere.

Alerts (`alerts`, `type_alerts`, `entities_alerts`, `profile_alert`, `external_alerts`) decide which event type notifies which entity, profile or outside address.

## EDI

`gateway_external`, `external_references`, the four journals (`orders_edi`, `folder_edi`, `booking_edi`, `event_edi`) and the transcoding tables. All of it in `edi-ptd.md`.

`gateway_external.access_key` is a partner's static token. It is stripped from every response this connection returns — there is no other way to read it, and no reason to.

## Reference data

`terminals` (ports and airports), `oversea_companies` (shipping lines and airlines), `countries`, `currencies`, `languages`, `localities`, `event_types`, `entity_types`, `files_type`, `parcel_types`, `adr`, `user_permissions`, `template_roles`. Readable, effectively never written.

## Units and money

- Weights are kilograms, volumes cubic metres, `meterage` linear metres.
- Days are `YYYY-MM-DD`, instants full ISO with a zone. Comparing an instant column to a bare day means midnight UTC.
- Quotation lines carry their own `currency`, a `conversion_rate` and `amount_default_entity_currency`. The entity's currency is `entities.default_currency` — compare in that column, never by summing mixed `amount_currency`.
