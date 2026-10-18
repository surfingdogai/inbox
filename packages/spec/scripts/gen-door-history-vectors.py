#!/usr/bin/env python3
"""Writes vectors/door-history.json: a door's history as the public sees it (protocol §4.8, ADR-020).

An implementation of its own, in another language, of the rules the protocol states, so that neither
packages/spec's doorHistoryOf nor a network's code is its own judge: both must reproduce every case.
Python's standard library only. From the repository's root:

    python3 packages/spec/scripts/gen-door-history-vectors.py > packages/spec/vectors/door-history.json
    npx biome format --write packages/spec/vectors/door-history.json
"""

import datetime as dt
import json
import pathlib
import re

MIN_DAYS, RECENT, CURRENT = 14, 90, 7
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# The door types, as vocab/doors.json names them: a type of `types`, or `platform:<name>`, has a
# history; an experimental type, or anything else (llms.txt is never a door), has none.
VOCAB = json.loads((pathlib.Path(__file__).resolve().parent.parent / "vocab" / "doors.json").read_text())


def shown(door_type):
    if door_type in VOCAB["experimental"]:
        return False
    return door_type in VOCAB["types"] or door_type.startswith(VOCAB["platform_prefix"])


def day(s):
    return dt.date.fromisoformat(s)


def words(d):
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def history_of(e, as_of):
    """What the public sees of entry e on as_of; None when it is never shown."""
    if not shown(e["type"]) or not e.get("first_seen") or not e.get("last_seen"):
        return None
    as_of = day(as_of)
    first, last = day(e["first_seen"]), day(e["last_seen"])
    out = {
        "type": e["type"],
        "host": e["host"],
        "first_seen": e["first_seen"],
        "last_seen": e["last_seen"],
        # never fewer than the days its first and last name
        "days_seen": max(e["days_seen"], 1 if first == last else 2),
        "current": e["current"],
    }
    by = {}
    for d, answered, missed, refused in e["days"]:
        d = day(d)
        if d > as_of or min(answered, missed, refused) < 0 or answered + missed + refused == 0:
            continue
        a, m, r = by.get(d, (0, 0, 0))
        by[d] = (a + answered, m + missed, r + refused)
    if len(by) < MIN_DAYS:
        return out

    def mark(counts):
        # missed beats refused beats answered
        _, m, r = counts
        return "x" if m else ("b" if r else "a")

    days = len(by)
    marks = [mark(c) for c in by.values()]
    answered, refused = marks.count("a"), marks.count("b")
    first_checked, last_checked = min(by), max(by)
    recent = ""
    for i in range(RECENT - 1, -1, -1):
        d = as_of - dt.timedelta(days=i)
        recent += mark(by[d]) if d in by else "."
    out["checks"] = {
        "first_checked": first_checked.isoformat(),
        "last_checked": last_checked.isoformat(),
        "days": days,
        "answered": answered,
        "refused": refused,
        "recent": recent,
    }
    when = "since " + words(first_checked)
    if (as_of - last_checked).days > CURRENT:
        when = "from " + words(first_checked) + " to " + words(last_checked)
    share = f"{answered * 100 // days}%"
    if refused:
        share += f"; refused our check on {refused}"
    out["summary"] = f"Answered every check on {answered} of {days} days checked {when} ({share})."
    return out


def run(start, n, answered=1, missed=0, step=1):
    s = day(start)
    return [[(s + dt.timedelta(days=i * step)).isoformat(), answered, missed, 0] for i in range(n)]


cases = []


def case(name, as_of, entry):
    cases.append({"name": name, "as_of": as_of, "entry": entry, "expect": history_of(entry, as_of)})


base = {"type": "mcp", "host": "salon.example", "first_seen": "2026-10-03", "last_seen": "2026-11-13", "days_seen": 42, "current": True}
at16 = {**base, "last_seen": "2026-10-16", "days_seen": 14}

case("fewer than 14 checked days: the dates and nothing else", "2026-10-16", {**at16, "days_seen": 13, "days": run("2026-10-03", 13)})
case("14 checked days, every check answered: 100%", "2026-10-16", {**at16, "days": run("2026-10-03", 14)})
d = run("2026-10-03", 42)
d[20] = [d[20][0], 1, 1, 0]
case("a day with a missed check and an answer later is a day missed: 41 of 42 is 97%", "2026-11-13", {**base, "days": d})
d = run("2026-04-01", 200)
d[150] = [d[150][0], 0, 3, 0]
case(
    "floored, never rounded up: 199 of 200 is 99%",
    "2026-10-17",
    {**base, "first_seen": "2026-04-01", "last_seen": "2026-10-17", "days_seen": 199, "days": d},
)
d = run("2026-10-03", 20)
d[19] = [d[19][0], 0, 1, 0]
case(
    "a check that was only missed is a day missed, and the last day of the window",
    "2026-10-22",
    {**base, "last_seen": "2026-10-21", "days_seen": 19, "days": d},
)
case("its last check more than 7 days ago: from the first to the last", "2026-12-20", {**base, "days": run("2026-10-03", 42)})
case("its last check exactly 7 days ago: still since", "2026-11-20", {**base, "days": run("2026-10-03", 42)})
case("days after as_of are not counted", "2026-10-16", {**base, "last_seen": "2026-10-20", "days_seen": 18, "days": run("2026-10-03", 18)})
d = run("2026-10-03", 14) + [["2026-10-10", 0, 1, 0]]
case("the same day twice (two URLs of the type at the host) is one day, missed if one was", "2026-10-16", {**at16, "days": d})
d = run("2026-10-03", 14) + [["2026-10-20", 0, 0, 0]]
case("a day with no concluded check is no day", "2026-10-20", {**at16, "days": d})
d = run("2026-09-29", 20)
for i in range(3, 20, 4):
    d[i] = [d[i][0], 0, 0, 1]
case(
    "a check refused (blocked while the door was not down) is no answer: the day is refused, never answered",
    "2026-10-18",
    {**base, "first_seen": "2026-09-29", "last_seen": "2026-10-18", "days_seen": 15, "days": d},
)
d = run("2026-10-01", 16)
d[5] = [d[5][0], 1, 0, 1]
d[9] = [d[9][0], 0, 1, 1]
case(
    "a day with a refused check and an answer is refused; with a refused and a missed one, missed",
    "2026-10-16",
    {**base, "first_seen": "2026-10-01", "last_seen": "2026-10-16", "days_seen": 15, "days": d},
)
case(
    "a day whose only check was refused still counts toward the 14 days",
    "2026-10-16",
    {**at16, "days": run("2026-10-03", 13) + [["2026-10-16", 0, 0, 1]]},
)
case(
    "every other day: the recent line has a dot for each day not checked",
    "2026-11-30",
    {**base, "first_seen": "2026-10-01", "last_seen": "2026-11-30", "days_seen": 30, "days": run("2026-10-01", 30, step=2)},
)
case(
    "more than 90 days: the recent line is the last 90, the share is all of them",
    "2027-01-31",
    {**base, "first_seen": "2026-10-01", "last_seen": "2027-01-31", "days_seen": 123, "days": run("2026-10-01", 123)},
)
case(
    "seen answering on a few days a month apart, never read daily: the dates and the count, no checks",
    "2026-10-16",
    {**base, "type": "ucp", "first_seen": "2026-08-16", "last_seen": "2026-09-24", "days_seen": 3, "days": []},
)
case(
    "days_seen is never fewer than the days its first and last name",
    "2026-10-16",
    {**base, "first_seen": "2026-10-07", "last_seen": "2026-10-09", "days_seen": 0, "days": []},
)
case("a member's inbox", "2026-10-16", {**at16, "type": "inbox", "days": run("2026-10-03", 14)})
case(
    "a Shopify store's MCP server is platform:shopify",
    "2026-10-16",
    {"type": "platform:shopify", "host": "shop.example", "first_seen": "2026-10-07", "last_seen": "2026-10-07", "days_seen": 1, "current": True, "days": []},
)
case(
    "a door that is not there now",
    "2027-03-01",
    {"type": "a2a", "host": "agents.salon.example", "first_seen": "2026-10-07", "last_seen": "2027-01-15", "days_seen": 9, "current": False, "days": []},
)
case("llms.txt is not a door: never shown", "2026-10-16", {**at16, "type": "llms.txt", "days": run("2026-10-03", 14)})
case("WebMCP is experimental: never shown", "2026-10-16", {**at16, "type": "webmcp", "days": []})
case(
    "a door no read found answering: never shown",
    "2026-10-16",
    {**base, "first_seen": None, "last_seen": None, "days_seen": 0, "days": run("2026-10-03", 20, answered=0, missed=1)},
)

doc = {
    "description": (
        "A door's history (protocol §4.8, ADR-020): what the public sees of one door type at one host, from the days "
        "a network's own daily checks of the door concluded. entry.type is a door type as vocab/doors.json names it "
        "(an experimental type, or anything else, is never shown). entry.days_seen is the days a read found the door "
        "answering, shown as at least the days first_seen and last_seen name. entry.days are [day, answered, missed, "
        "refused]: that day's daily checks that answered, that were missed (failed, or blocked while the door was down "
        "by the network's reads) and that were refused (blocked otherwise). A day is checked when one concluded; it is "
        "missed when one was missed, else refused when one was refused, else answered. The share of days answered shows "
        "from min_days checked days, floored, so a refused day is never an answered one; recent is the last recent_days "
        "days ending on as_of ('a' answered, 'x' missed, 'b' refused, '.' no check); a door whose last check is more "
        "than current_days before as_of says from…to instead of since. min_days, recent_days and current_days are the "
        "protocol's, not a network's choice. summary is informative: this network's English words for checks, which "
        "another network may word its own way, so a conformance check compares every member of expect except summary. "
        "expect null: never shown. Written by scripts/gen-door-history-vectors.py."
    ),
    "informative": ["summary"],
    "min_days": MIN_DAYS,
    "recent_days": RECENT,
    "current_days": CURRENT,
    "cases": cases,
}
text = json.dumps(doc, indent=2, ensure_ascii=False)
# [day, answered, missed, refused] on one line each
text = re.sub(r'\[\n\s+("\d{4}-\d\d-\d\d"),\n\s+(\d+),\n\s+(\d+),\n\s+(\d+)\n\s+\]', r"[\1, \2, \3, \4]", text)
print(text)
