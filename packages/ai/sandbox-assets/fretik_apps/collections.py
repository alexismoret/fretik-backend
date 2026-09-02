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

from ._runtime import SDK_INLINE_ROW_LIMIT, _call_collections, _import

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
            return _import(collection_key, [_row(r)["data"] for r in rows])
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
        {"id": "<record id>", "data": {<field map>}}. No collection_key needed —
        each id routes itself. Records outside your team are skipped.

        merge=True (default): PATCH — only the keys you pass change, the rest
        are kept; pass a key with value None to clear it. merge=False: full
        replace — omitted keys are cleared.

        Returns {"updatedIds": [...], "okCount": int, "errors": [{id, error}]}.
        """
        # Tolerant of the bulk_create call shape: `records=` aliases `updates`,
        # and a stray `collection_key` is accepted (each id routes itself).
        items = updates if updates is not None else records
        if items is None:
            raise TypeError(
                "bulk_update expects a list of {'id', 'data'} updates"
            )
        return _call_collections(
            "records.bulk_update", {"updates": items, "merge": merge}
        )

    def bulk_delete(self, record_ids: list[str]) -> dict[str, Any]:
        """Delete many records by id. Ids outside your team are skipped.

        Returns {"deletedIds": [...], "okCount": int, "errors": [{id, error}]}.
        """
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


records = _Records()
schema = _Schema()
