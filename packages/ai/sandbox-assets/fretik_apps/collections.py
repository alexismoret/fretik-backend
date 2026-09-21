# Hand-maintained (NOT manifest-generated). Copied verbatim into
# fretik_apps/ by scripts/generate-sdk.ts. Edit here, then `bun run gen:sdk`.

"""fretik_apps.collections — code-mode SDK for the team's ontology (collections +
records). The bulk / migration power path.

Use it when a task touches MANY records or restructures a type — insert hundreds
of rows, move records between types, merge/split types, data-preserving retype.
Everything runs SERVER-SIDE in fretik-backend: field validation, team scoping,
grants and the domain-events journal are applied exactly like the manageRecord /
manageCollection tools. Intermediate data you build here (parsed files, mappings)
never re-enters your context — only the small result summary does.

For ONE record or a single interactive edit, use the manageRecord /
manageCollection / manageField tools instead; this SDK is the batch path.

  from fretik_apps import collections

  # Bulk insert — ids[i] aligns with rows[i] (None if that row failed).
  res = collections.records.bulk_create("clients", [
      {"name": "ACME", "vat": "FR123"},
      {"name": "Globex"},
  ])
  print(res["okCount"], "created,", len(res["errors"]), "failed")

  # Migration sketch: split one type into two
  collections.schema.create_collection("supplier", "Supplier", "Companies we buy from", fields=[
      {"label": "Name", "type": "text", "is_title": True, "description": "Supplier name"},
  ])
  page = collections.records.query("contact", filters={"kind": "supplier"})
  created = collections.records.bulk_create(
      "supplier", [{"name": r["data"]["name"]} for r in page["records"]]
  )
  collections.records.bulk_delete([r["id"] for r in page["records"]])
"""

from typing import Any

from ._runtime import SDK_INLINE_ROW_LIMIT, _call_collections, _stream_load

# Field dicts use Python snake_case; the backend wants camelCase. Map only the
# multi-word keys — single-word ones (label, type, description, config) pass
# through untouched.
_FIELD_KEY_MAP = {
    "is_title": "isTitle",
    "display_in_filters": "displayInFilters",
}

# Relation dicts use snake_case; the backend wants camelCase.
_RELATION_KEY_MAP = {
    "relation_key": "relationKey",
    "link_type_id": "linkTypeId",
    "to_record_id": "toRecordId",
    "to_document_id": "toDocumentId",
}


def _clean(args: dict[str, Any]) -> dict[str, Any]:
    """Drop None values so optional args fall back to their server defaults."""
    return {k: v for k, v in args.items() if v is not None}


def _field(spec: dict[str, Any]) -> dict[str, Any]:
    """Normalize one field spec (snake_case → the backend's camelCase keys)."""
    return {_FIELD_KEY_MAP.get(k, k): v for k, v in spec.items() if v is not None}


def _relation(spec: dict[str, Any]) -> dict[str, Any]:
    """Normalize one relation spec (snake_case → camelCase)."""
    return {
        _RELATION_KEY_MAP.get(k, k): v for k, v in spec.items() if v is not None
    }


def _row(row: dict[str, Any]) -> dict[str, Any]:
    """Normalize a bulk_create row to {"data", "relations"}. A bare field map IS
    the record's data; pass {"data": {...}, "relations": [...]} to attach
    outgoing relations to the new record in the same write."""
    if "data" in row and isinstance(row["data"], dict):
        data, rels = row["data"], row.get("relations") or []
    else:
        data, rels = row, []
    out: dict[str, Any] = {"data": data}
    if rels:
        out["relations"] = [_relation(r) for r in rels]
    return out


class _Records:
    """Bulk record operations. Each call is ONE backend round-trip that fans out
    to a set-based write — never a row-by-row loop."""

    def bulk_create(
        self, collection_key: str, rows: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """Create many records of `collection_key`. Each row is a field map
        (key → value), validated against the type's schema server-side.

        Encode each value in its field's type — describeCollection shows every
        field's `writeFormat`. Money is {"amount": 1500, "currencyCode": "EUR"}
        (the key is "currencyCode", NOT "currency").

        To attach outgoing relations in the same write, give a row as
        {"data": {<field map>}, "relations": [{"relation_key": "client",
        "to_record_id": "<id>"}]} — target by `to_record_id` or an uploaded
        file's `to_document_id` (its document record).

        Pass the WHOLE list, however long — batches beyond a few thousand rows
        are streamed automatically. Never split them into a manual loop: that
        opens one approval per batch instead of one for the load.

        Returns {"ids": [...], "okCount": int, "errors": [{index, error}],
        "relationErrors": [{index, error}]}. `ids[i]` is the new id for `rows[i]`
        (None if it failed); `relationErrors` is indexed by row. Keep the result
        in a variable and print only counts, not the whole list.

        On a streamed load `ids` may be None — it is absent, not empty, when the
        call resumed rows an earlier attempt had already written. Read the
        counts; query the type if you need the ids.
        """
        # Past the inline limit the whole list no longer fits one request, one
        # approval payload, or one thing a person can review. The streamed path
        # uploads it in chunks against a single approval and survives a crash.
        if len(rows) > SDK_INLINE_ROW_LIMIT:
            if any("relations" in r for r in rows):
                raise ValueError(
                    "bulk_create: relations are not supported past "
                    f"{SDK_INLINE_ROW_LIMIT} rows. Create the records first, "
                    "then link them in a second pass."
                )
            return _stream_load(
                "create", collection_key, [_row(r)["data"] for r in rows]
            )
        return _call_collections(
            "records.bulk_create",
            {"collectionKey": collection_key, "rows": [_row(r) for r in rows]},
        )

    def bulk_update(
        self,
        updates: list[dict[str, Any]] | None = None,
        *,
        merge: bool = True,
        records: list[dict[str, Any]] | None = None,
        collection_key: str | None = None,
    ) -> dict[str, Any]:
        """Update the data of many records. Each item is
        {"id": "<record id>", "data": {<field map>}}. Records outside your team
        are skipped.

        merge=True (default): PATCH — only the keys you pass change, the rest
        are kept; pass a key with value None to clear it. merge=False: full
        replace — omitted keys are cleared.

        Pass the WHOLE list, however long — batches beyond a few thousand rows
        are streamed automatically, and a streamed load needs `collection_key`
        (it is one collection at a time). Below that, ids route themselves.

        Returns {"updatedIds": [...], "okCount": int, "errors": [{id, error}]}.
        On a streamed load `updatedIds` is None — read the counts.
        """
        # Tolerant of the bulk_create call shape: `records=` aliases `updates`.
        items = updates if updates is not None else records
        if items is None:
            raise TypeError(
                "bulk_update expects a list of {'id', 'data'} updates"
            )
        if len(items) > SDK_INLINE_ROW_LIMIT:
            if not collection_key:
                raise ValueError(
                    "bulk_update: pass collection_key= past "
                    f"{SDK_INLINE_ROW_LIMIT} rows. A streamed load is sized "
                    "and reviewed against ONE collection; split the updates "
                    "by collection and call once per collection."
                )
            return _stream_load(
                "update", collection_key, items, merge=merge
            )
        return _call_collections(
            "records.bulk_update", {"updates": items, "merge": merge}
        )

    def bulk_delete(
        self,
        record_ids: list[str],
        *,
        collection_key: str | None = None,
    ) -> dict[str, Any]:
        """Delete many records by id. Ids outside your team are skipped.

        Pass the WHOLE list, however long — batches beyond a few thousand rows
        are streamed automatically, and a streamed load needs `collection_key`
        (it is one collection at a time).

        Returns {"deletedIds": [...], "okCount": int, "errors": [{id, error}]}.
        On a streamed load `deletedIds` is None — read the counts.
        """
        if len(record_ids) > SDK_INLINE_ROW_LIMIT:
            if not collection_key:
                raise ValueError(
                    "bulk_delete: pass collection_key= past "
                    f"{SDK_INLINE_ROW_LIMIT} ids. A streamed load is sized "
                    "and reviewed against ONE collection; split the ids by "
                    "collection and call once per collection."
                )
            return _stream_load(
                "delete", collection_key, [{"id": i} for i in record_ids]
            )
        return _call_collections(
            "records.bulk_delete", {"recordIds": record_ids}
        )

    def query(
        self,
        collection_key: str,
        filters: dict[str, Any] | None = None,
        page: int = 0,
        limit: int = 200,
    ) -> dict[str, Any]:
        """Read a page of the team's confirmed records of `collection_key`, each with
        its `data` map. `filters` is an equality map on field keys. The
        migration read primitive — fetch a batch, transform in-sandbox, write it
        back. Full-text search stays in the SQL tool.

        Returns {"records": [{"id", "label", "status", "data"}]}.
        """
        return _call_collections(
            "records.query",
            _clean(
                {
                    "collectionKey": collection_key,
                    "filters": filters,
                    "page": page,
                    "limit": limit,
                }
            ),
        )


class _Schema:
    """Collection & field migrations. Field changes are DDL — bounded in count,
    so these are normal per-call ops (not thousands-scale like records)."""

    def create_collection(
        self,
        key: str,
        label: str,
        description: str,
        label_plural: str | None = None,
        icon: str | None = None,
        fields: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Create a collection, provisioning its typed table. `description` is
        one line — what the type is for (required; you read it later as ground
        truth). Pass `fields` to build the whole schema in ONE call (each a dict
        like {"label": "Name", "type": "text", "is_title": True, "description":
        "..."}; every field needs its own one-line `description`). Max 100
        fields per type. Exclude relation/rollup fields — add those with
        `add_field`. Colors are auto-assigned; a select/multi_select option may
        set an optional `color` (a palette token) to override.

        A field's column key is slugified from its label unless you pass
        `"key"`. Set it explicitly on any field a `formula` in the same call
        names in its expression — otherwise the expression is guessing.

        Returns {"id", "key", "fields": [{key, type}]}.
        """
        if fields and len(fields) > 100:
            raise ValueError(
                f"create_collection: max 100 fields per type, got {len(fields)}"
            )
        return _call_collections(
            "schema.create_collection",
            _clean(
                {
                    "key": key,
                    "label": label,
                    "labelPlural": label_plural,
                    "description": description,
                    "icon": icon,
                    "fields": [_field(f) for f in fields] if fields else None,
                }
            ),
        )

    def update_collection(
        self,
        collection_key: str,
        label: str | None = None,
        label_plural: str | None = None,
        description: str | None = None,
        icon: str | None = None,
        enabled: bool | None = None,
        add_fields: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Patch a type's metadata AND/OR add several new fields in one call
        (`add_fields`, same shape as `create_collection`'s `fields` — each needs a
        one-line `description`). Editing or removing existing fields is
        `change_field`.

        Returns {"key", "addedFields": [{key, type}]}.
        """
        return _call_collections(
            "schema.update_collection",
            _clean(
                {
                    "collectionKey": collection_key,
                    "label": label,
                    "labelPlural": label_plural,
                    "description": description,
                    "icon": icon,
                    "enabled": enabled,
                    "addFields": (
                        [_field(f) for f in add_fields] if add_fields else None
                    ),
                }
            ),
        )

    def add_field(
        self,
        collection_key: str,
        label: str,
        type: str,
        description: str,
        config: dict[str, Any] | None = None,
        display_in_filters: bool | None = None,
    ) -> dict[str, Any]:
        """Add one field (ALTER TABLE ADD COLUMN) to an existing type.
        `description` is one line — what the field holds (required).

        Returns {"key", "type"}.
        """
        return _call_collections(
            "schema.add_field",
            _clean(
                {
                    "collectionKey": collection_key,
                    "label": label,
                    "type": type,
                    "description": description,
                    "config": config,
                    "displayInFilters": display_in_filters,
                }
            ),
        )

    def change_field(
        self,
        collection_key: str,
        field_key: str,
        action: str,
        label: str | None = None,
        description: str | None = None,
        config: dict[str, Any] | None = None,
        type: str | None = None,
        display_in_filters: bool | None = None,
        enabled: bool | None = None,
        cascade: bool | None = None,
    ) -> dict[str, Any]:
        """Edit one field. `action` is "update" (keeps values), "changeType"
        (pass `type`; RESETS the field's values), or "delete" (pass cascade=True
        to drop a field that holds values).
        """
        return _call_collections(
            "schema.change_field",
            _clean(
                {
                    "collectionKey": collection_key,
                    "fieldKey": field_key,
                    "action": action,
                    "label": label,
                    "description": description,
                    "config": config,
                    "type": type,
                    "displayInFilters": display_in_filters,
                    "enabled": enabled,
                    "cascade": cascade,
                }
            ),
        )

    def delete_collection(self, collection_key: str) -> dict[str, Any]:
        """Drop a type and every record in it — the last step of a merge/split."""
        return _call_collections("schema.delete_collection", {"collectionKey": collection_key})


class _Sync:
    """Collections a connected app fills, on a cadence.

    preview BEFORE create: the preview is where the stable id, the column
    types and the pagination promise come from, and none can be guessed from
    an action's name. A source runs on a connection's credentials, so a
    personal connection is usable only by its owner.
    """

    def preview(
        self,
        connection_id: str,
        operation: str,
        args: dict[str, Any] | None = None,
        result_path: str | None = None,
        sample_record_id: str | None = None,
        collection_key: str | None = None,
        match_field_key: str | None = None,
        external_id_path: str | None = None,
    ) -> dict[str, Any]:
        """Call the app once and show what would be mapped: rows, proposed
        columns, candidate stable ids, `read`, and the cost of a cadence.

        Pass `collection_key` + `match_field_key` + `external_id_path` to try
        the match as well: `matched` comes back `{"sampled", "found"}`, and
        `found == 0` means the source would run, succeed and fill nothing.
        """
        return _call_collections(
            "sync.preview",
            _clean(
                {
                    "connectionId": connection_id,
                    "operation": operation,
                    "args": args,
                    "resultPath": result_path,
                    "sampleRecordId": sample_record_id,
                    "collectionKey": collection_key,
                    "matchFieldKey": match_field_key,
                    "externalIdPath": external_id_path,
                }
            ),
        )

    def create(
        self,
        collection_key: str,
        connection_id: str,
        operation: str,
        fields: list[dict[str, Any]],
        kind: str = "table",
        args: dict[str, Any] | None = None,
        result_path: str | None = None,
        external_id_path: str | None = None,
        match_field_key: str | None = None,
        schedule: dict[str, Any] | None = None,
        orphan_policy: str | None = None,
        row_cap: int | None = None,
    ) -> dict[str, Any]:
        """Declare the source. `fields` map upstream paths to columns:
        [{"path": "customer.name", "label": "Client", "type": "text"}].

        A `table` source needs `external_id_path` — the upstream row's own id.
        A `columns` source needs whichever key its ACTION allows: a list action
        is walked, so pass `match_field_key` (the column of the existing
        records) plus `external_id_path` (the value in the app's row that must
        equal it); an action answering about one object is called per record,
        so bind {"$field": "<column key>"} into `args` instead. Not both.

        The first run starts in the background.
        """
        return _call_collections(
            "sync.create",
            _clean(
                {
                    "collectionKey": collection_key,
                    "connectionId": connection_id,
                    "operation": operation,
                    "fields": fields,
                    "kind": kind,
                    "args": args,
                    "resultPath": result_path,
                    "externalIdPath": external_id_path,
                    "matchFieldKey": match_field_key,
                    "schedule": schedule,
                    "orphanPolicy": orphan_policy,
                    "rowCap": row_cap,
                }
            ),
        )

    def update(
        self,
        source_id: str,
        args: dict[str, Any] | None = None,
        schedule: dict[str, Any] | None = None,
        orphan_policy: str | None = None,
        row_cap: int | None = None,
        fields: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Change what a source asks for, how often, or which columns it fills."""
        return _call_collections(
            "sync.update",
            _clean(
                {
                    "sourceId": source_id,
                    "args": args,
                    "schedule": schedule,
                    "orphanPolicy": orphan_policy,
                    "rowCap": row_cap,
                    "fields": fields,
                }
            ),
        )

    def delete(self, source_id: str) -> dict[str, Any]:
        """Stop the sync. The columns stay as ordinary local ones; no record
        is deleted.
        """
        return _call_collections("sync.delete", {"sourceId": source_id})

    def refresh(
        self,
        collection_key: str | None = None,
        source_id: str | None = None,
    ) -> dict[str, Any]:
        """Queue a run now. Returns immediately — re-read the records after."""
        return _call_collections(
            "sync.refresh",
            _clean({"collectionKey": collection_key, "sourceId": source_id}),
        )

    def confirm_full_resync(self, source_id: str) -> dict[str, Any]:
        """Let the next run apply the orphan policy it refused.

        A run that would have orphaned most of a collection stops and asks
        instead. Only confirm what the user confirmed.
        """
        return _call_collections(
            "sync.confirmFullResync", {"sourceId": source_id}
        )

    def list(self, collection_key: str | None = None) -> dict[str, Any]:
        """Every source of a collection, or of the whole team."""
        return _call_collections(
            "sync.list", _clean({"collectionKey": collection_key})
        )


records = _Records()
schema = _Schema()
sync = _Sync()
