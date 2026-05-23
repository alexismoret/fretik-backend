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

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


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


def _auth() -> dict[str, Any]:
    with open("/workspace/.fretik/auth.json", "r", encoding="utf-8") as f:
        return json.load(f)


def _post(payload: dict[str, Any]) -> Any:
    auth = _auth()
    body = json.dumps({**payload, "turnId": auth["turn_id"]}).encode("utf-8")
    req = urllib.request.Request(
        f"{auth['backend_url']}/sandbox/exec",
        data=body,
        headers={
            "Authorization": f"Bearer {auth['jwt']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise FretikActionError(f"HTTP {exc.code}: {raw}") from exc

    status = data.get("status")
    if status == "approval_pending":
        raise ApprovalPending(data["approvalId"])
    if status == "error":
        raise FretikActionError(data.get("message", "Unknown error"))
    return data.get("data")


def _call_read(action: str, args: dict[str, Any]) -> Any:
    """Eager call for a read action. Returns the normalized data."""
    return _post({"kind": "read", "action": action, "args": args})


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
    return result
