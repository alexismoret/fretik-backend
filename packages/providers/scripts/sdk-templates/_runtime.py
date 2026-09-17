"""fretik_apps runtime.

All calls go through fretik-backend → Nango Proxy. NO provider credential
(OAuth token, API key) ever exists in this sandbox. WRITE actions never
execute directly: they are collected as operations and submitted via
run_plan(), which requires explicit user approval (raises ApprovalPending
until granted).

The auth file at /workspace/.fretik/auth.json is re-written by the backend
before every agent turn — so this module re-reads it on every call() and
the JWT rotates without restarting the Jupyter kernel.

Under the `proxy` transport that file carries an EMPTY jwt: the credential is
added to outbound requests by the platform's egress proxy and never exists in
this sandbox at all. No Authorization header is sent in that case.

/workspace/.fretik/egress.json lists the hosts this turn may reach. A host
outside it is not refused — the firewall accepts the TCP handshake and then
kills the TLS one — so a download to one would surface as an unexplained
protocol error. Checking the list first is what turns that into a sentence.
"""

# AUTO-GENERATED via scripts/generate-sdk.ts — do not edit by hand.

import base64
import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any


def _safe_pattern(pattern: str) -> str | None:
    """Return `pattern` if Python's `re` can compile it, else None.

    MCP `inputSchema`s carry ECMAScript regexes, and JS-only constructs
    (e.g. `\\p{...}`, some named-group spellings) raise `re.error` under
    Python's `re`. Pydantic compiles a `Field(pattern=...)` eagerly at class
    definition, so a bad pattern would crash the whole generated module's
    import and take every tool of that app offline. Degrading to `None` (no
    local constraint) keeps the module importable — the MCP server still
    enforces the real pattern on its side.
    """
    try:
        re.compile(pattern)
    except re.error:
        return None
    return pattern


# Canonical sandbox directory for anything the agent DOWNLOADED, whatever
# fetched it — see `conversation-storage.ts: WORKSPACE_DIRS.downloads`.
# Files written here are S3-mirrored so they survive sandbox expiry, and
# every file tool reads them by path (`read`, `vision`, `extract`,
# `presentFiles`).
#
# NOT `attachments/`, which it used to be: that directory means "the user
# gave me this file" and is the only one backed by `ai_chat_files` rows.
# Spilling there stated something false about who provided the file — and
# cost more than a wrong label, because `read` resolves an `attachments/`
# path through those rows and answered `File not found` for every file a
# provider downloaded, pointing the agent at a `<file_attachments>` block
# the file was never in.
#
# The base64 blob itself NEVER reaches the agent — see `_spill_attachments`.
_DOWNLOAD_SPILL_DIR = "/workspace/downloads"


def _sanitize_filename(name: str) -> str:
    """Strip path separators and odd chars so the spilled filename is
    safe to write and easy to refer to. Empty / missing names fall back
    to 'file'."""
    if not name:
        return "file"
    cleaned = "".join(c if c.isalnum() or c in "._-" else "_" for c in name)
    return cleaned[:128] if cleaned else "file"


def _spill_attachments(data: Any) -> Any:
    """Walk `data` recursively. Any dict with a non-empty `content_base64`
    OR `download_url` field has its bytes written to disk; the dict is
    mutated so:
      - `sandbox_path` points to the on-disk file
      - `content_base64` / `download_url` is set to `None`

    This is the load-bearing safety net for every provider's download-
    attachment action: the agent NEVER receives the raw base64 in its
    context, only an `Attachment` whose `sandbox_path` it can open with
    any file-consuming tool (`read`, `vision`, `extract`, presentFiles,
    pypdf, pillow, etc.).

    Two shapes are covered:
      - `content_base64` — provider returned base64 inline (Outlook,
        IMAP-SMTP). Decode + write.
      - `download_url`   — provider returned a short-lived pre-authed
        direct download URL (Teams: `@microsoft.graph.downloadUrl` from
        a OneDrive driveItem). Stream the URL into the file.

    Walks lists and nested dicts so an action returning `list[Attachment]`
    (or any future shape containing attachments) is covered too.

    A spill that FAILS sets `download_error` on the same dict and leaves the
    source field in place. It does not raise: `ftp-sftp.download_files` takes
    up to 20 paths and promises that a file that fails comes back marked while
    the rest still arrive, so one bad item may not take the other nineteen
    with it. The caller decides — which is why every action whose whole point
    is the bytes must check, and why the generated result models allow extra
    fields (pydantic's default would drop `download_error` on the floor).
    """
    if isinstance(data, dict):
        if not data.get("sandbox_path"):
            b64 = data.get("content_base64")
            if isinstance(b64, str) and b64:
                _write_base64_to_spill(data, b64)
            else:
                url = data.get("download_url")
                if isinstance(url, str) and url:
                    _write_url_to_spill(data, url)
        for v in data.values():
            _spill_attachments(v)
    elif isinstance(data, list):
        for item in data:
            _spill_attachments(item)
    return data


def _write_base64_to_spill(data: dict[str, Any], b64: str) -> None:
    os.makedirs(_DOWNLOAD_SPILL_DIR, exist_ok=True)
    safe_name = _sanitize_filename(data.get("name", "file"))
    path = os.path.join(
        _DOWNLOAD_SPILL_DIR, f"{uuid.uuid4().hex[:8]}_{safe_name}"
    )
    try:
        with open(path, "wb") as f:
            f.write(base64.b64decode(b64))
        data["sandbox_path"] = path
    except (ValueError, OSError) as exc:
        # Malformed base64 or write failure. Keep the original field AND say
        # why on the payload: "surfaces upstream" was only ever true of the
        # field, never of the reason, and a caller reading `sandbox_path is
        # None` cannot tell a refusal from a bug.
        data["download_error"] = f"{type(exc).__name__}: {exc}"
        return
    data["content_base64"] = None


_EGRESS_FILE = "/workspace/.fretik/egress.json"
_egress_cache: dict[str, Any] = {"mtime": None, "allow": None}


def _egress_allows(host: str) -> bool | None:
    """Whether this turn's egress policy admits `host`.

    None when the policy is unknown (file absent or unreadable) — the caller
    then tries the request rather than refusing on a guess. Cached by mtime:
    the backend rewrites the file whenever the policy changes.
    """
    try:
        mtime = os.path.getmtime(_EGRESS_FILE)
        if _egress_cache["mtime"] != mtime:
            with open(_EGRESS_FILE, "r", encoding="utf-8") as f:
                _egress_cache["allow"] = json.load(f).get("allow_out") or []
            _egress_cache["mtime"] = mtime
    except (OSError, ValueError):
        return None
    allow = _egress_cache["allow"]
    if allow is None:
        return None
    host = host.lower()
    for entry in allow:
        entry = str(entry).lower()
        if entry.startswith("*."):
            # A leading wildcard matches subdomains at any depth, never the
            # apex — the same rule the platform's firewall applies.
            if host.endswith(entry[1:]):
                return True
        elif host == entry:
            return True
    return False


def _write_url_to_spill(data: dict[str, Any], url: str) -> None:
    host = urllib.parse.urlparse(url).hostname or ""
    if _egress_allows(host) is False:
        # Refuse here rather than let the firewall kill the TLS handshake: it
        # accepts the connection first, so the failure would arrive as
        # `UNEXPECTED_EOF_WHILE_READING` and read like a broken server.
        # `download_url` is kept so the caller can hand it to `downloadFile`,
        # which fetches from the backend and is not bound by this policy.
        data["download_error"] = (
            f"EGRESS_BLOCKED: {host} is not on this sandbox's network "
            "allowlist. Use the assistant's downloadFile tool on the "
            "download_url instead, or ask an organization admin to allow the "
            "domain in Settings → Sandbox & internet."
        )
        return
    os.makedirs(_DOWNLOAD_SPILL_DIR, exist_ok=True)
    safe_name = _sanitize_filename(data.get("name", "file"))
    path = os.path.join(
        _DOWNLOAD_SPILL_DIR, f"{uuid.uuid4().hex[:8]}_{safe_name}"
    )
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": "fretik-apps-sdk/1.0"}
        )
        with urllib.request.urlopen(req, timeout=30) as resp, open(
            path, "wb"
        ) as f:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                f.write(chunk)
        data["sandbox_path"] = path
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        # Network or write failure — keep `download_url` so the caller can
        # retry manually, and record WHY next to it. A sandbox egress refusal
        # arrives here as a killed TLS handshake with no message of its own
        # (see `services/e2b/network-policy.ts`), so without this line the
        # only trace a blocked host leaves is an absent `sandbox_path`.
        data["download_error"] = f"{type(exc).__name__}: {exc}"
        return
    data["download_url"] = None


class ApprovalPending(Exception):
    """Raised when a write plan awaits the user's approval.

    Expected — not an error. Stop, the user will see an approval card. When
    the user approves and you are prompted to continue, re-run the EXACT
    same code; the grant is matched automatically.
    """

    def __init__(self, approval_id: str):
        super().__init__(f"Plan {approval_id} awaiting user approval")
        self.approval_id = approval_id


class FretikActionError(Exception):
    """Raised on any non-approval error returned by the backend."""


@dataclass
class Operation:
    """A single write action collected by `<action>.op(...)`."""

    action: str  # fully-qualified, e.g. "outlook.send_email"
    args: dict[str, Any]


# Seconds before a backend call is abandoned. `urlopen` defaults to no timeout
# at all, so a hung request burned the sandbox's entire 5-minute wall clock and
# surfaced as "the cell did nothing" with no error to act on. Generous enough
# for a large bulk write, short enough to leave room to react.
_POST_TIMEOUT_S = 120


def _auth() -> dict[str, Any]:
    with open("/workspace/.fretik/auth.json", "r", encoding="utf-8") as f:
        return json.load(f)


def _post(payload: dict[str, Any]) -> Any:
    auth = _auth()
    body = json.dumps({**payload, "turnId": auth["turn_id"]}).encode("utf-8")
    # Identify the SDK explicitly. Python's `urllib.request` defaults to
    # `Python-urllib/<version>`, which Cloudflare's bot management flags
    # as a non-browser client and rejects with `403` + body `error code:
    # 1010` ("browser signature revoked") — observed when the backend
    # URL points at a Cloudflare-fronted tunnel (e.g. tunnl.gg in dev).
    # A descriptive UA bypasses that rule and helps server logs identify
    # SDK traffic.
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "fretik-apps-sdk/1.0",
    }
    # Empty under the proxy transport: the egress proxy adds the credential on
    # the way out, and sending `Bearer ` would be a malformed header the
    # backend rejects before it ever looks at the injected one.
    jwt = auth.get("jwt") or ""
    if jwt:
        headers["Authorization"] = f"Bearer {jwt}"
    req = urllib.request.Request(
        f"{auth['backend_url']}/sandbox/exec",
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=_POST_TIMEOUT_S) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise FretikActionError(f"HTTP {exc.code}: {raw}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise FretikActionError(
            f"Backend call timed out or was unreachable after "
            f"{_POST_TIMEOUT_S}s: {exc}"
        ) from exc

    status = data.get("status")
    if status == "approval_pending":
        raise ApprovalPending(data["approvalId"])
    if status == "error":
        raise FretikActionError(data.get("message", "Unknown error"))
    return data.get("data")


def _call_collections(op: str, args: dict[str, Any]) -> Any:
    """Dispatch one collections.* op for the code-mode ontology SDK
    (`fretik_apps.collections`). Record writes are gated by workflow autonomy: an
    `approval_required` run pauses on a record_write approval (this call raises
    ApprovalPending); a read_only run is refused; plain chat and autonomous runs
    write directly. Schema changes are blocked for any workflow run. Validation,
    grants and the domain-events journal are always enforced server-side.
    Returns the op's small result summary (ids, counts, per-row errors) — never
    the bulk rows themselves.
    """
    return _post({"kind": "collections", "op": op, "args": args})


# Rows a single `records.bulk_create` request may carry. Past this the whole
# list no longer fits one HTTP body, one approval payload, or one thing a
# person can review — so `_import` streams it instead. The threshold is
# invisible to the caller: `bulk_create` picks the path itself.
SDK_INLINE_ROW_LIMIT = 1000


def _rows_digest(rows: list[dict[str, Any]]) -> str:
    """Content hash of the rows, computed here so the SAME load can be
    recognized on a re-run WITHOUT re-uploading a byte.

    `sort_keys` makes it independent of dict ordering; `allow_nan=False` is the
    load-bearing part — pandas writes NaN into cells, `json.dumps` would emit
    the non-standard `NaN` literal, and the same DataFrame could then hash two
    ways. Rejecting it forces the caller to clean the value (see `_clean_nan`),
    which is what makes the digest deterministic.
    """
    hasher = hashlib.sha256()
    for row in rows:
        hasher.update(
            json.dumps(
                row, sort_keys=True, separators=(",", ":"), allow_nan=False
            ).encode("utf-8")
        )
    return hasher.hexdigest()


def _clean_nan(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Replace float NaN / infinities with None — an empty cell, which is what
    a spreadsheet meant by them. Also what makes `allow_nan=False` above safe.
    """
    out: list[dict[str, Any]] = []
    for row in rows:
        cleaned = {
            k: (None if isinstance(v, float) and v != v else v)
            for k, v in row.items()
        }
        # +/- inf survives the NaN test; JSON cannot carry it either.
        out.append(
            {
                k: (None if v in (float("inf"), float("-inf")) else v)
                for k, v in cleaned.items()
            }
        )
    return out


def _import(collection_key: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Stream a large create load: announce it, upload it in chunks, commit it.

    Called by `collections.records.bulk_create` past `SDK_INLINE_ROW_LIMIT`. The
    agent never calls this directly and never chooses between the two paths.

    Resumable by construction. Every step is keyed by content, so re-running the
    exact same code after a crash, a sandbox recycle, or an approval skips
    whatever already landed — including all of it, in which case the call
    returns the earlier outcome without sending a single row.

    That covers a load that FAILED partway too: re-running picks up the chunks
    that never landed, under the approval already granted, and returns with
    `state: "running"`. Only after the same failure repeats is it refused, and
    the message then says so — at which point retrying is not the answer.
    """
    rows = _clean_nan(rows)
    columns = sorted({k for row in rows[:100] for k in row.keys()})

    begin = _post(
        {
            "kind": "collections",
            "op": "records.import_begin",
            "args": {
                "op": "create",
                "collectionKey": collection_key,
                "totalRows": len(rows),
                "rowsDigest": _rows_digest(rows),
                "sample": rows[:3],
                "columns": columns,
            },
        }
    )
    # Already finished, or already running in the background — nothing to send.
    if begin.get("state") in ("replay", "running"):
        return begin

    operation_id = begin["operationId"]
    chunk_rows = begin["chunkRows"]
    done = set(begin.get("doneChunks") or [])

    # None once any chunk was applied by an EARLIER attempt: those ids went to
    # a process that is gone, and a list with holes in it would read as "these
    # rows failed". Explicitly absent beats quietly wrong — see `bulk_create`.
    ids: list[Any] | None = []
    ok_count = 0
    errors: list[dict[str, Any]] = []
    for index, start in enumerate(range(0, len(rows), chunk_rows)):
        if index in done:
            ids = None
            continue
        result = _post(
            {
                "kind": "collections",
                "op": "records.import_chunk",
                "args": {
                    "operationId": operation_id,
                    "chunkIndex": index,
                    "rows": rows[start : start + chunk_rows],
                },
            }
        )
        if ids is not None:
            ids.extend(result.get("ids") or [])
        ok_count += result.get("okCount", 0)
        errors.extend(result.get("errors") or [])

    # Raises ApprovalPending when a human must grant the load — the agent then
    # re-runs this exact code and lands on the `replay` branch above.
    commit = _post(
        {
            "kind": "collections",
            "op": "records.import_commit",
            "args": {"operationId": operation_id},
        }
    )
    return {**commit, "ids": ids, "okCount": commit.get("okCount", ok_count)}


def _call_read(action: str, args: dict[str, Any]) -> Any:
    """Eager call for a read action. Consumed by every generated read
    wrapper in `fretik_apps/<provider>.py` (e.g. `outlook.list_messages`,
    `outlook.download_message_attachment`).

    Returns the normalized data with any attachment `content_base64`
    blobs spilled to on-disk files (see `_spill_attachments`).
    """
    return _spill_attachments(_post({"kind": "read", "action": action, "args": args}))


def run_plan(operations: list[Operation]) -> list[dict[str, Any]]:
    """Submit N independent WRITE operations as ONE approval.

    The user approves the whole plan once. Returns per-op results
    [{"ok": True, "data": {...}} | {"ok": False, "error": "..."}, ...] in
    submission order. Operations must be INDEPENDENT — no op may depend on
    another op's result; if you need a result from one op to feed another,
    do the first one in a turn, inspect the outcome, then issue the second.

    Raises ApprovalPending until the user grants the plan, then returns
    normally on the next re-run of the same code.
    """
    for i, op in enumerate(operations):
        if not isinstance(op, Operation):
            raise FretikActionError(
                f"run_plan() element {i} is a {type(op).__name__}, not an Operation. "
                "Build every element with `<action>.op(...)` — a bare write call "
                "does not build an operation."
            )
    payload = {
        "kind": "plan",
        "operations": [{"action": op.action, "args": op.args} for op in operations],
    }
    result = _post(payload)
    if not isinstance(result, list):
        raise FretikActionError(
            f"Expected list from plan execution, got: {type(result).__name__}"
        )
    # Per-op `data` payloads might carry attachments (e.g. a future write
    # action that returns the forwarded attachment for confirmation). The
    # spill walks dicts and lists recursively, so we apply it to the
    # whole result list — read-action behaviour stays uniform with
    # write-action behaviour.
    _spill_attachments(result)
    return result
