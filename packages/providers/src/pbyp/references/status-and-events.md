# Statuses and events

`shipping_status` is never written directly — Pbyp derives it from the events, behind a mutex, and cascades the result. Writing it yourself puts a value in the column that survives exactly until the next event lands.

## The event catalogue

23 types. `add_event(event_type_id=…)` takes the id; `list_event_types()` returns them with labels.

| id  | code                          | module   | attaches to   | EN                             | FR                                        |
| --- | ----------------------------- | -------- | ------------- | ------------------------------ | ----------------------------------------- |
| 1   | `PICKED_UP`                   | sea, air | folder, order | Picked up                      | Enlèvement                                |
| 2   | `DELIVERED`                   | sea, air | folder, order | Delivered                      | Livré                                     |
| 3   | `VESSEL_DEPARTURE_FROM_POL`   | sea      | booking       | Vessel departure               | Départ du navire                          |
| 5   | `VESSEL_ARRIVAL_TO_POD`       | sea      | booking       | Arrival at port                | Arrivée au port                           |
| 6   | `CONTAINER_LOADED`            | sea      | container     | Container loaded               | Conteneur chargé                          |
| 7   | `CONTAINER_DISCHARGED`        | sea      | container     | Container discharged           | Conteneur déchargé                        |
| 8   | `PLANE_DEPARTURE_FROM_POL`    | air      | booking       | Plane departure                | Départ de l'avion                         |
| 9   | `PLANE_ARRIVAL_TO_POD`        | air      | booking       | Plane arrival                  | Arrivée de l'avion                        |
| 10  | `GATE_IN`                     | sea      | container     | Container gate in              | Entrée au terminal                        |
| 11  | `GATE_OUT`                    | sea      | container     | Container gate out             | Sortie du terminal                        |
| 12  | `VESSEL_DEPARTURE`            | sea      | booking       | Vessel departure               | Départ du navire                          |
| 13  | `VESSEL_ARRIVAL`              | sea      | booking       | Arrival at port                | Arrivée au port                           |
| 14  | `TRANSHIPMENT`                | sea      | booking       | Transhipment                   | Transbordement                            |
| 15  | `CONTAINER_TRANSHIPMENT`      | sea      | container     | Transhipment of container      | Transbordement du conteneur               |
| 16  | `PLANE_DEPARTURE`             | air      | booking       | Plane departure                | Départ de l'avion                         |
| 17  | `PLANE_ARRIVAL`               | air      | booking       | Plane arrival                  | Arrivée de l'avion                        |
| 18  | `RECEIVED_FROM_SHIPPER`       | air      | booking       | Received from shipper          | Reçu de l'expéditeur                      |
| 19  | `FLIGHT_BOOKED`               | air      | booking       | Flight booked                  | Vol réservé                               |
| 20  | `MANIFESTED`                  | air      | booking       | Manifested                     | Manifesté                                 |
| 21  | `CONTAINER_DISCHARGED_AT_POD` | sea      | container     | Discharged at destination port | Conteneur déchargé au port de destination |
| 22  | `CONTAINER_LOADED_FROM_POL`   | sea      | container     | Loaded at departure port       | Conteneur chargé au port de départ        |
| 23  | `GATE_OUT_FROM_POD`           | sea      | container     | Gate out at destination        | Sortie du terminal de destination         |
| 24  | `GATE_IN_AT_POL`              | sea      | container     | Gate in at departure terminal  | Entrée au terminal de départ              |

## The near-duplicate codes — the trap that matters

Several milestones exist twice: one generic, one qualified with `_FROM_POL` / `_AT_POD`. **Only the qualified ones move a status.** The derivation matches on the qualified substring, so the generic code records the fact and changes nothing.

| To move the status           | Use                                                              | NOT                                              |
| ---------------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| Booking → `IN_TRANSIT`       | `VESSEL_DEPARTURE_FROM_POL` (3) · `PLANE_DEPARTURE_FROM_POL` (8) | `VESSEL_DEPARTURE` (12) · `PLANE_DEPARTURE` (16) |
| Booking → `ARRIVED_AT_POD`   | `VESSEL_ARRIVAL_TO_POD` (5) · `PLANE_ARRIVAL_TO_POD` (9)         | `VESSEL_ARRIVAL` (13) · `PLANE_ARRIVAL` (17)     |
| Container → `ARRIVED_AT_POL` | `GATE_IN_AT_POL` (24)                                            | `GATE_IN` (10)                                   |
| Container → `LOADED`         | `CONTAINER_LOADED_FROM_POL` (22)                                 | `CONTAINER_LOADED` (6)                           |
| Container → `DISCHARGED`     | `CONTAINER_DISCHARGED_AT_POD` (21)                               | `CONTAINER_DISCHARGED` (7)                       |

The generic codes are what the carrier tracking feed emits for intermediate legs (a transhipment port is a departure too). That is why they do not advance anything.

## Derivation, in order

Each rule set is evaluated top to bottom; the first match wins.

### Booking (`sea_bookings`, `air_bookings`)

1. `status == "archived"` → `CANCELED`
2. an event whose code contains `ARRIVAL_TO_POD` → `ARRIVED_AT_POD`, and `ATA` = that event's date
3. an event whose code contains `DEPARTURE_FROM_POL` → `IN_TRANSIT`, `ATD` = that date, `ATA` = null
4. otherwise → `CREATED`, `ATD` = null

`ATD` and `ATA` are therefore mirrors of the events. Writing them is pointless.

### Container

1. `status == "archived"` → `CANCELED`
2. `CONTAINER_DISCHARGED_AT_POD` → `DISCHARGED`
3. its booking is `ARRIVED_AT_POD` → `ARRIVED_AT_POD`
4. its booking is `IN_TRANSIT` → `IN_TRANSIT`
5. an event containing `CONTAINER_LOADED_FROM_POL` → `LOADED`
6. an event containing `GATE_IN_AT_POL` → `ARRIVED_AT_POL`
7. otherwise → `CREATED`

A container therefore inherits from its voyage as soon as the voyage sails: its own `LOADED` is only visible before departure.

### Folder (`sea_folders`, `air_folders`)

1. `status == "archived"` → `CANCELED`
2. a `DELIVERED` event — on the folder itself, on **every** attached order, or on **every** house folder → `DELIVERED`
3. its booking (`voyage_id`) is `ARRIVED_AT_POD` → `ARRIVED_AT_POD`
4. its booking is `IN_TRANSIT` → `IN_TRANSIT`
5. sea only, and every container of the folder is `ARRIVED_AT_POL` or `LOADED` → `ARRIVED_AT_POL`
6. a `PICKED_UP` event — on the folder, on every order, or on every house → `PICKED_UP`
7. otherwise → `CREATED`

"Every" is literal: one order without a `DELIVERED` event holds the whole folder back.

### Order

1. `status == "archived"` → `CANCELED`
2. a `DELIVERED` event on the order **or on its folder** → `DELIVERED`, and `delivery_date` = that date
3. its folder is `ARRIVED_AT_POD` → `ARRIVED_AT_POD`
4. its folder is `IN_TRANSIT` → `IN_TRANSIT`
5. every container it is stuffed into is `ARRIVED_AT_POL` or `LOADED` → `ARRIVED_AT_POL`
6. a `PICKED_UP` event on the order or on its folder → `PICKED_UP`
7. otherwise → `CREATED`

## Propagation

An event on a folder or an order propagates **down**: Pbyp copies the `PICKED_UP` / `DELIVERED` onto the objects that inherited the status, creating the missing event with `actual: true`. So marking a folder delivered marks its orders delivered, with their own event rows — you do not need to repeat the call per order.

A booking's status recomputation cascades to its containers, then to its folders, then to their orders. One `add_event` on a voyage can move dozens of rows.

Alerts fire on the booking transitions: `VESSEL_DEPARTURE` / `VESSEL_ARRIVAL` (sea) and `PLANE_DEPARTURE` / `PLANE_ARRIVAL` (air) notify the subscribed entities.

## Deduplication

An event that already exists — same object, same type, same terminal, same address — is **not** created twice. Pbyp updates the existing row and answers HTTP 200 with an error-shaped body carrying `EVENT_ALREADY_EXIST`. `add_event()` maps that to `deduplicated: true`, which is a success. Retrying makes no difference.

## `actual`

`actual: false` is a forecast, `actual: true` is a fact. `add_event()` defaults it from the date — past means actual, future means forecast. The derivation above does not read `actual`: an event moves the status either way, so do not record a forecast departure unless the ship really has a departure.

## Sources

`source` is set by Pbyp, never by you: `user` for anything you create, `tracking` for the carrier feed (see `declare_tracking`), `ptd` for events pushed in by a partner gateway.
