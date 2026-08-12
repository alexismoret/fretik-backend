"""fretik_apps runtime.

All calls go through fretik-backend → Nango Proxy. NO provider credential
(OAuth token, API key) ever exists in this sandbox. WRITE actions never
execute directly: they are collected as operations and submitted via
run_plan(), which requires explicit user approval (raises ApprovalPending
until granted).

The auth file at /workspace/.fretik/auth.json is re-written by the backend
before every agent turn — so this module re-reads it on every call() and
the JWT rotates without restarting the Jupyter kernel.
"""

# AUTO-GENERATED via scripts/generate-sdk.ts — do not edit by hand.

import base64
import json
import os
import re
import urllib.error
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


# Canonical sandbox directory for downloaded attachments. Same path the
# rest of the agent's file tools already speak (`vision`, `read`,
# `presentFiles`, `resolveWorkspacePath`) — see `conversation-storage.ts:
# WORKSPACE_DIRS.attachments`. Files written here are S3-mirrored so
# they survive sandbox expiry and can be surfaced to the user with
# presentFiles. The base64 blob itself NEVER reaches the agent — see
# `_spill_attachments`.
_ATTACHMENT_SPILL_DIR = "/workspace/attachments"


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
    any file-consuming tool (vision, presentFiles, pypdf, pillow, etc.).

    Two shapes are covered:
      - `content_base64` — provider returned base64 inline (Outlook,
        IMAP-SMTP). Decode + write.
      - `download_url`   — provider returned a short-lived pre-authed
        direct download URL (Teams: `@microsoft.graph.downloadUrl` from
        a OneDrive driveItem). Stream the URL into the file.

    Walks lists and nested dicts so an action returning `list[Attachment]`
    (or any future shape containing attachments) is covered too.
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
    os.makedirs(_ATTACHMENT_SPILL_DIR, exist_ok=True)
    safe_name = _sanitize_filename(data.get("name", "file"))
    path = os.path.join(
        _ATTACHMENT_SPILL_DIR, f"{uuid.uuid4().hex[:8]}_{safe_name}"
    )
    try:
        with open(path, "wb") as f:
            f.write(base64.b64decode(b64))
        data["sandbox_path"] = path
    except (ValueError, OSError):
        # Malformed base64 or write failure — keep the original field so
        # the failure surfaces upstream rather than silently losing the
        # payload.
        return
    data["content_base64"] = None


def _write_url_to_spill(data: dict[str, Any], url: str) -> None:
    os.makedirs(_ATTACHMENT_SPILL_DIR, exist_ok=True)
    safe_name = _sanitize_filename(data.get("name", "file"))
    path = os.path.join(
        _ATTACHMENT_SPILL_DIR, f"{uuid.uuid4().hex[:8]}_{safe_name}"
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
    except (urllib.error.URLError, OSError, TimeoutError):
        # Network failure or write failure — keep `download_url` so the
        # caller can retry manually or surface the error.
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
    req = urllib.request.Request(
        f"{auth['backend_url']}/sandbox/exec",
        data=body,
        headers={
            "Authorization": f"Bearer {auth['jwt']}",
            "Content-Type": "application/json",
            "User-Agent": "fretik-apps-sdk/1.0",
        },
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


def _call_objects(op: str, args: dict[str, Any]) -> Any:
    """Dispatch one objects.* op for the code-mode ontology SDK
    (`fretik_apps.objects`). Record writes are gated by workflow autonomy: an
    `approval_required` run pauses on a record_write approval (this call raises
    ApprovalPending); a read_only run is refused; plain chat and autonomous runs
    write directly. Schema changes are blocked for any workflow run. Validation,
    grants and the domain-events journal are always enforced server-side.
    Returns the op's small result summary (ids, counts, per-row errors) — never
    the bulk rows themselves.
    """
    return _post({"kind": "objects", "op": op, "args": args})


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
