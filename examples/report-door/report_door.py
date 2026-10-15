"""Report how one use of a business's door went: Python's standard library, one HTTP call.

    python3 report_door.py           prints the report it would send, and sends nothing
    python3 report_door.py --send    sends it

No library, no signature, no account. The rules: https://network.surfingdog.ai/report.md
"""

import email.utils
import json
import secrets
import sys
import time
import urllib.error
import urllib.request

NETWORK = "https://network.surfingdog.ai"


def new_intent() -> str:
    """One per attempt, kept for all its retries, so the attempt counts once."""
    return secrets.token_urlsafe(12)


def retry_after(value, default):
    """Seconds to wait from a Retry-After header: a number of seconds, or an HTTP date."""
    if not value:
        return default
    try:
        return max(0, int(value))
    except ValueError:
        try:
            return max(0, email.utils.parsedate_to_datetime(value).timestamp() - time.time())
        except (TypeError, ValueError):
            return default


def door_report(domain, door, op, result, cls=None, tool=None, ms=None, intent=None, token=None):
    """One report, as the network takes it. result is ok, refused, invalid, fail or info; every result but ok takes a class."""
    report = {"domain": domain, "door": door, "op": op, "at": int(time.time()), "intent": intent or new_intent(), "result": result}
    if cls:
        report["class"] = cls
    if tool:
        report["tool"] = tool.lower()
    if ms is not None:
        report["ms"] = int(ms)
    if token:
        report["token"] = token  # a door's signed outcome token, as it came: keep a copy too
    return report


def report_door(report, attempts=3):
    """Send one report, trying again as the network asks; the network's answer, or None."""
    body = json.dumps({"v": 1, "reports": [report]}).encode()
    req = urllib.request.Request(
        f"{NETWORK}/v1/door-reports",
        data=body,
        method="POST",
        headers={"content-type": "application/json", "accept": "application/json"},
    )
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                return json.load(res)  # {"accepted": [...], "ignored": [...], "next": "..."}
        except urllib.error.HTTPError as e:
            if e.code not in (408, 429) and e.code < 500:
                raise  # 400 or 413: the report itself is wrong, sending it again will not help
            wait = retry_after(e.headers.get("retry-after"), 30 * 2**attempt)
        except (urllib.error.URLError, TimeoutError):
            wait = 30 * 2**attempt
        if attempt < attempts - 1:
            time.sleep(min(wait, 900))
    return None


if __name__ == "__main__":
    # bakery.example is not a listed business: sent, it comes back ignored. Use a domain and door from a
    # search (search_businesses) to see one accepted.
    report = door_report(
        domain="bakery.example",
        door={"type": "inbox", "url": "https://bakery.example/mcp"},
        op="book",
        tool="create_booking",
        result="refused",
        cls="slot_taken",
        ms=1840,
    )
    if "--send" in sys.argv[1:]:
        print(report_door(report))
    else:
        print(json.dumps({"v": 1, "reports": [report]}, indent=2))
        print("Not sent. Run with --send to send it.", file=sys.stderr)
