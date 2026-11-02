#!/usr/bin/env python3
"""
Writes the catalogue version 2 vectors (docs/protocol/network.md §4.18, as amended):

  vectors/catalogue-signature.json  canonical JSON, item hashes, and Catalogue-Signature JWS
  vectors/catalogue-checks.json     what a reader holds, drops or withdraws in one item
  vectors/catalogue-prices.json     price models, unit-price arithmetic and the "was" price rule
  vectors/catalogue-options.json    a product group's options, read as one product or not
  vectors/catalogue-v1.json         the version 1 item an inbox serves for a version 2 one
  vectors/catalogue-policies.json   the policies document, read part by part, and shipping quotes

Python's standard library only: an implementation of its own, in another language than either side it
checks (the inbox's TypeScript, the network's Go), as vectors/door-history.json is. It works out every
number (hashes, SHA-256, Ed25519 signatures, unit prices, the "was" price windows, the shipping fees and
the version 1 items) itself; the codes each check gives are written by hand in the cases below.

    python3 scripts/gen-catalogue-vectors.py && npx biome format --write vectors

Run from packages/spec. packages/spec/test/catalogue-v2.test.ts checks every file against the code on
Node and in workerd; the network checks the same files in Go.
"""

import base64
import copy
import hashlib
import json
import os
import re
import urllib.parse
from datetime import datetime, timedelta, timezone
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
VECTORS = os.path.join(HERE, "..", "vectors")
VOCAB = os.path.join(HERE, "..", "vocab")


def vocab(name):
    with open(os.path.join(VOCAB, name), encoding="utf-8") as f:
        return json.load(f)


# The spellings each vocabulary reads as its key or kind (data, not an implementation).
OPTION_KEY = {w: k["key"] for k in vocab("option-keys.json")["keys"] for w in [k["key"], *k["also"]]}
AGE_KIND = {w: k["kind"] for k in vocab("age-kinds.json")["kinds"] for w in [k["kind"], *k["also"]]}


def write(name, doc):
    with open(os.path.join(VECTORS, name), "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")


# --- canonical JSON (RFC 8785) ---------------------------------------------------------------------


def jnum(n):
    if isinstance(n, bool):
        raise TypeError("bool is not a number")
    if isinstance(n, int):
        return str(n)
    if isinstance(n, float):
        if n != n or n in (float("inf"), float("-inf")):
            raise TypeError("not finite")
        if n == int(n) and abs(n) < 1e21:
            return str(int(n))
        s = repr(n)
        if "e" in s or "E" in s:
            raise ValueError("an exponent: not a number a catalogue holds")
        return s
    raise TypeError(type(n))


def jstr(s):
    for ch in s:
        if 0xD800 <= ord(ch) <= 0xDFFF:
            raise ValueError("half of a surrogate pair")
    out = ['"']
    for ch in s:
        o = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\r":
            out.append("\\r")
        elif o < 0x20:
            out.append("\\u%04x" % o)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def canonical(v):
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return jnum(v)
    if isinstance(v, str):
        return jstr(v)
    if isinstance(v, list):
        return "[" + ",".join(canonical(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys(), key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(jstr(k) + ":" + canonical(v[k]) for k in keys) + "}"
    raise TypeError(type(v))


def sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def item_hash(item):
    body = {k: v for k, v in item.items() if k not in ("updated_at", "hash")}
    return sha256(canonical(body))[:16]


def fin(item):
    """An item with its hash worked out (members kept in the order given, hash last)."""
    item = {k: v for k, v in item.items() if k != "hash"}
    item["hash"] = item_hash(item)
    return item


def compact(v):
    """As ECMAScript's JSON.stringify writes it: members in their order, no whitespace."""
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


# --- Ed25519 (RFC 8032 §5.1), and compact JWS ------------------------------------------------------

P = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493


def inv(x):
    return pow(x, P - 2, P)


D = -121665 * inv(121666) % P
SQRT_M1 = pow(2, (P - 1) // 4, P)


def add(p1, p2):
    a = (p1[1] - p1[0]) * (p2[1] - p2[0]) % P
    b = (p1[1] + p1[0]) * (p2[1] + p2[0]) % P
    c = 2 * p1[3] * p2[3] * D % P
    d = 2 * p1[2] * p2[2] % P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % P, g * h % P, f * g % P, e * h % P)


def mul(s, pt):
    q = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            q = add(q, pt)
        pt = add(pt, pt)
        s >>= 1
    return q


def recover_x(y, sign):
    x2 = (y * y - 1) * inv(D * y * y + 1) % P
    if x2 == 0:
        return 0
    x = pow(x2, (P + 3) // 8, P)
    if (x * x - x2) % P != 0:
        x = x * SQRT_M1 % P
    assert (x * x - x2) % P == 0
    if (x & 1) != sign:
        x = P - x
    return x


GY = 4 * inv(5) % P
GX = recover_x(GY, 0)
G = (GX, GY, 1, GX * GY % P)


def compress(pt):
    zi = inv(pt[2])
    x, y = pt[0] * zi % P, pt[1] * zi % P
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def expand(secret):
    h = hashlib.sha512(secret).digest()
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return a, h[32:]


def public_of(secret):
    a, _ = expand(secret)
    return compress(mul(a, G))


def ed_sign(secret, msg):
    a, prefix = expand(secret)
    pub = compress(mul(a, G))
    r = int.from_bytes(hashlib.sha512(prefix + msg).digest(), "little") % L
    rs = compress(mul(r, G))
    h = int.from_bytes(hashlib.sha512(rs + pub + msg).digest(), "little") % L
    s = (r + h * a) % L
    return rs + s.to_bytes(32, "little")


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def unb64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# RFC 8037 A.1: the key every signature vector here is made with (as vectors/receipts.json's issuer).
D_B64 = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A"
X_B64 = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"
SECRET = unb64u(D_B64)
assert b64u(public_of(SECRET)) == X_B64, "Ed25519: the public key of RFC 8037 A.1"
KID = b64u(hashlib.sha256(compact({"crv": "Ed25519", "kty": "OKP", "x": X_B64}).encode()).digest())
assert KID == "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k", "RFC 8037 A.3's thumbprint"

# RFC 8037 A.4, so an implementation can check its Ed25519 before anything of ours.
RFC_INPUT = b64u(compact({"alg": "EdDSA"}).encode()) + "." + b64u(b"Example of Ed25519 signing")
RFC_JWS = RFC_INPUT + "." + b64u(ed_sign(SECRET, RFC_INPUT.encode("ascii")))
assert RFC_JWS.endswith(
    "hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR6dWbhijcNR4ki4iylGjg5BhVsPt9g7sVvpAr_MuM0KAg"
), "RFC 8037 A.4's signature"


def jws(header, payload):
    hj, pj = compact(header), compact(payload)
    signing = b64u(hj.encode()) + "." + b64u(pj.encode())
    return hj, pj, signing + "." + b64u(ed_sign(SECRET, signing.encode("ascii")))


HEADER = {"alg": "EdDSA", "typ": "sdi-catalogue+jws", "kid": KID}

# --- times -----------------------------------------------------------------------------------------


def t(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (dt.microsecond // 1000)


AS_OF = "2026-11-02T10:00:00.000Z"

# --- the items -------------------------------------------------------------------------------------

V2_MEMBERS = [
    "id", "state", "sku", "name", "description", "group", "options", "price_model", "price", "price_max",
    "list_price", "unit_price", "tax_included", "availability", "available_from", "available_until", "gtin",
    "no_gtin", "multipack", "is_bundle", "brand", "mpn", "condition", "url", "media", "age_restricted",
    "fulfil_methods", "shipping_profile", "weight", "return_policy", "withdrawal", "updated_at", "hash",
]

BASE = {
    "id": "MOKA-6-ALU",
    "state": "listed",
    "sku": "MOKA-6",
    "name": "Moka pot, 6 cups, aluminium",
    "description": "The stovetop pot, in aluminium.",
    "group": {"id": "MOKA", "title": "Moka pot", "position": 2},
    "options": [
        {"key": "size", "name": "Size", "value": "6 cups"},
        {"key": "material", "name": "Material", "value": "Aluminium"},
    ],
    "price_model": "fixed",
    "price": {"value": 3490, "currency": "EUR"},
    "availability": "in_stock",
    "gtin": "09506000134352",
    "no_gtin": False,
    "brand": "Bialetti",
    "mpn": None,
    "condition": "new",
    "url": "https://loja.example/produtos/moka-6",
    "media": [{"type": "image", "url": "https://loja.example/img/moka-6.jpg", "alt": "A six-cup moka pot"}],
    "fulfil_methods": ["pickup", "shipping"],
    "shipping_profile": "standard",
    "weight": {"value": 0.65, "unit": "kg"},
    "return_policy": "standard",
    "updated_at": "2026-11-02T09:12:00.000Z",
}


def item(**changes):
    """BASE with changes; a change to None-the-sentinel DROP removes the member."""
    it = copy.deepcopy(BASE)
    for k, v in changes.items():
        if v is DROP:
            it.pop(k, None)
        else:
            it[k] = v
    return fin(it)


class _Drop:
    pass


DROP = _Drop()

SINGLE = dict(group=DROP, options=DROP, id="MOKA-6", name="Moka pot, 6 cups")

# The members each drop code drops alone (CATALOGUE_V2_PROBLEMS in catalogue-problems.ts), in the order
# the registry lists them: a reader names its drops in this order, each once. A member in NONE is set to
# its none instead of left out.
DROPS = {
    "sku_dropped": ["sku"],
    "description_dropped": ["description"],
    "group_dropped": ["group", "options"],
    "options_without_group": ["options"],
    "group_without_options": ["group"],
    "option_key_twice": ["group", "options"],
    "list_price_dropped": ["list_price"],
    "list_price_not_fixed": ["list_price"],
    "list_price_currency": ["list_price"],
    "list_price_not_above": ["list_price"],
    "unit_price_dropped": ["unit_price"],
    "unit_price_not_fixed": ["unit_price"],
    "unit_unknown": ["unit_price"],
    "unit_mismatch": ["unit_price"],
    "unit_measure": ["unit_price"],
    "available_from_unused": ["available_from"],
    "gtin_dropped": ["gtin"],
    "no_gtin_dropped": ["no_gtin"],
    "gtin_and_no_gtin": ["no_gtin"],
    "brand_dropped": ["brand"],
    "mpn_dropped": ["mpn"],
    "url_dropped": ["url"],
    "url_off_site": ["url"],
    "media_dropped": ["media"],
    "media_entry_dropped": [],
    "media_alt_dropped": [],
    "shipping_profile_unused": ["shipping_profile"],
    "age_shipping_unchecked": ["shipping_profile"],
    "weight_dropped": ["weight"],
    "weight_unit": ["weight"],
    "withdrawal_dropped": ["withdrawal"],
}
NONE = {"sku": None, "description": None, "gtin": None, "no_gtin": False, "brand": None, "mpn": None, "url": None, "media": []}


def kept(it, dropped, media=None):
    """The item as a reader keeps it: members it does not know left out, option keys and an age's kind read
    through their vocabularies, fulfil methods once, drops applied. media: the pictures kept, when a drop
    left some out (written by hand)."""
    out = {k: copy.deepcopy(it[k]) for k in V2_MEMBERS if k in it}
    if "fulfil_methods" in out:
        seen = []
        for m in out["fulfil_methods"]:
            if m not in seen:
                seen.append(m)
        out["fulfil_methods"] = seen
    if "options" in out and "group_dropped" not in dropped:
        for o in out["options"]:
            o["key"] = OPTION_KEY.get(o["key"], o["key"])
    if "age_restricted" in out:
        out["age_restricted"]["kind"] = AGE_KIND[out["age_restricted"]["kind"]]
    for code in dropped:
        for f in DROPS[code]:
            if f in NONE:
                out[f] = copy.deepcopy(NONE[f])
            else:
                out.pop(f, None)
        if code == "age_shipping_unchecked":
            out["fulfil_methods"] = [m for m in out["fulfil_methods"] if m != "shipping"]
    if media is not None:
        out["media"] = media
    return out


def listed(it, dropped=(), media=None):
    order = list(DROPS)
    assert list(dropped) == sorted(dropped, key=order.index) and len(set(dropped)) == len(dropped), dropped
    k = kept(it, dropped, media)
    out = {"state": "listed", "dropped": list(dropped)}
    if k != it:
        out["item"] = k
    return out


def held(_it, problems, path=None):
    """Held, with every problem named; the id is the case's own item's (case fills it in). path: with
    unreadable, the JSON Pointer of the first member that does not read, in the order the schema lists them."""
    assert (path is not None) == (problems == ["unreadable"]), (problems, path)
    out = {"state": "held", "id": None, "problems": problems}
    if path is not None:
        out["path"] = path
    return out


def unreadable(path):
    return held(None, ["unreadable"], path)


def withdrawn(_it, why):
    return {"state": "withdrawn", "id": None, "why": why}


def case(name, it, expect, policies=False, site=None, note=None):
    if expect["state"] in ("held", "withdrawn"):
        own = it.get("id") if isinstance(it, dict) else None
        expect = dict(expect, id=own if isinstance(own, str) else None)
        keys = ["state", "id", "problems", "path"] if expect["state"] == "held" else ["state", "id", "why"]
        expect = {k: expect[k] for k in keys if k in expect}
    c = {"name": name, "item": it, "expect": expect}
    if policies:
        c["with_policies"] = True
    if site is not None:
        c["site"] = site
    if note:
        c["note"] = note
    return c


LONG_ID = "SKU-" + "x" * 252
assert len(LONG_ID) == 256
AGE = lambda kind, age=18, **more: dict(SINGLE, age_restricted=dict({"min_age": age, "kind": kind, "check": "id_at_handover"}, **more))  # noqa: E731
EMOJI_5000 = "\U0001F355" * 2500 + "é" * 2500
assert len(EMOJI_5000) == 5000 and len(EMOJI_5000.encode("utf-16-le")) // 2 == 7500
SITE = ["loja.example"]
PIC = {"type": "image", "url": "https://loja.example/img/moka-6.jpg", "alt": "A six-cup moka pot"}

CHECKS = [
    case("a variant, every field", item(), listed(item())),
    case("a product with no variants", item(**SINGLE), listed(item(**SINGLE))),
    case(
        "withdrawn",
        {"id": "MOKA-3-ALU", "state": "withdrawn", "updated_at": "2026-11-02T09:11:00.000Z"},
        {"state": "withdrawn", "id": "MOKA-3-ALU", "why": "withdrawn"},
    ),
    case(
        "withdrawn, with an id of 257 characters",
        {"id": LONG_ID + "x", "state": "withdrawn", "updated_at": "2026-11-02T09:11:00.000Z"},
        unreadable("/id"),
    ),
    case("not an object at all", "MOKA-6-ALU", unreadable("")),
    case("a state it does not know", item(state="archived"), unreadable("/state")),
    case("an id of 256 characters", item(id=LONG_ID), listed(item(id=LONG_ID))),
    case("an id of 257 characters", item(id=LONG_ID + "x"), unreadable("/id")),
    case("an id with a comma", item(id="MOKA,6"), unreadable("/id")),
    case("an id with a space", item(id="MOKA 6"), unreadable("/id")),
    case(
        "an id that is a path, printable ASCII",
        item(id="gid://shop/ProductVariant/4471"),
        listed(item(id="gid://shop/ProductVariant/4471")),
    ),
    case("a price of 0", item(price={"value": 0, "currency": "EUR"}), unreadable("/price/value")),
    case(
        "a price written as a decimal",
        item(price={"value": "34.90", "currency": "EUR"}),
        unreadable("/price/value"),
    ),
    case(
        "the first member that does not read, in the schema's order",
        item(name=DROP, price={"value": 0, "currency": "EUR"}, availability="3 left"),
        unreadable("/name"),
        note="name comes before price and availability in the schema",
    ),
    case(
        "a price in no ISO 4217 currency",
        item(price={"value": 3490, "currency": "ABC"}),
        held(item(), ["currency_unknown"]),
    ),
    case("an availability that is a count", item(availability="3 left"), unreadable("/availability")),
    case("few left, as the owner chose to publish", item(availability="limited"), listed(item(availability="limited"))),
    case("on sale, no count kept", item(availability="on_sale"), listed(item(availability="on_sale"))),
    case("made to order", item(availability="made_to_order"), listed(item(availability="made_to_order"))),
    case("a pre-order with no date", item(availability="preorder"), held(item(), ["preorder_without_date"])),
    case(
        "a pre-order, out next month",
        item(availability="preorder", available_from="2026-12-01T00:00:00.000Z"),
        listed(item(availability="preorder", available_from="2026-12-01T00:00:00.000Z")),
    ),
    case(
        "a pre-order whose date has passed",
        item(availability="preorder", available_from="2026-11-01T00:00:00.000Z"),
        held(item(), ["preorder_date_passed"]),
    ),
    case(
        "a back-order, back next week",
        item(availability="backorder", available_from="2026-11-09T00:00:00.000Z"),
        listed(item(availability="backorder", available_from="2026-11-09T00:00:00.000Z")),
    ),
    case("a back-order with no date", item(availability="backorder"), listed(item(availability="backorder"))),
    case(
        "in stock, with a date it is available from: the date dropped",
        item(available_from="2026-11-09T00:00:00.000Z"),
        listed(item(available_from="2026-11-09T00:00:00.000Z"), ["available_from_unused"]),
    ),
    case(
        "past its last day: withdrawn",
        item(available_until="2026-11-02T10:00:00.000Z"),
        withdrawn(item(), "available_until_passed"),
    ),
    case(
        "a season that ends in December",
        item(available_until="2026-12-24T23:59:59.000Z"),
        listed(item(available_until="2026-12-24T23:59:59.000Z")),
    ),
    case(
        "a pre-order that stops before it starts",
        item(availability="preorder", available_from="2026-12-01T00:00:00.000Z", available_until="2026-11-30T00:00:00.000Z"),
        held(item(), ["available_dates_order"]),
    ),
    case(
        "a barcode, and no barcode: the barcode kept",
        item(no_gtin=True),
        listed(item(no_gtin=True), ["gtin_and_no_gtin"]),
    ),
    case(
        "no barcode at all, as the owner says",
        item(**SINGLE, gtin=None, no_gtin=True, brand=None),
        listed(item(**SINGLE, gtin=None, no_gtin=True, brand=None)),
    ),
    case("a barcode of 13 digits: left out", item(gtin="9506000134352"), listed(item(gtin="9506000134352"), ["gtin_dropped"])),
    case("no_gtin missing: false", item(no_gtin=DROP), listed(item(no_gtin=DROP), ["no_gtin_dropped"])),
    case("a bundle", item(**SINGLE, is_bundle=True, gtin=None), listed(item(**SINGLE, is_bundle=True, gtin=None))),
    case(
        "a bundle that is also a pack of six",
        item(**SINGLE, is_bundle=True, multipack=6),
        held(item(), ["bundle_multipack"]),
    ),
    case("a pack of twelve", item(**SINGLE, multipack=12), listed(item(**SINGLE, multipack=12))),
    case(
        "alcohol, 18 and over, 21 in the US",
        item(**AGE("alcohol", by_country={"US": 21})),
        listed(item(**AGE("alcohol", by_country={"US": 21}))),
    ),
    case(
        "wine: read as alcohol",
        item(**AGE("wine")),
        listed(item(**AGE("wine"))),
        note="an also spelling of vocab/age-kinds.json is kept as its kind",
    ),
    case("a kitchen knife, 18 and over", item(**AGE("blades")), listed(item(**AGE("blades")))),
    case(
        "a kind the vocabulary does not know: held until the business picks one",
        item(**AGE("party_balloons", 16)),
        held(item(), ["age_kind_unknown"]),
    ),
    case("knives: blades or weapons, the business says which", item(**AGE("knives")), held(item(), ["age_kind_unknown"])),
    case("vapes, ID check or not: kept off", item(**AGE("tobacco_nicotine")), held(item(), ["age_kind_off"])),
    case("tobacco, as a shop types it: kept off", item(**AGE("tobacco")), held(item(), ["age_kind_off"])),
    case("nicotine: kept off", item(**AGE("nicotine")), held(item(), ["age_kind_off"])),
    case("vape: kept off", item(**AGE("vape")), held(item(), ["age_kind_off"])),
    case("cannabis: kept off", item(**AGE("cannabis", 21)), held(item(), ["age_kind_off"])),
    case("weapons: kept off", item(**AGE("weapons")), held(item(), ["age_kind_off"])),
    case("firearms: kept off", item(**AGE("firearms")), held(item(), ["age_kind_off"])),
    case("an age under 12", item(**AGE("rated_media", 11)), unreadable("/age_restricted/min_age")),
    case("an age over 21", item(**AGE("alcohol", 22)), unreadable("/age_restricted/min_age")),
    case("a country's age over 25", item(**AGE("alcohol", by_country={"XK": 26})), unreadable("/age_restricted/by_country/XK")),
    case(
        "an age with no check",
        item(**dict(SINGLE, age_restricted={"min_age": 18, "kind": "alcohol"})),
        unreadable("/age_restricted/check"),
    ),
    case(
        "alcohol shipped, a profile with a service that checks ID",
        item(**AGE("alcohol")),
        listed(item(**AGE("alcohol"))),
        policies=True,
    ),
    case(
        "alcohol, collected or shipped by a profile that checks no ID: shipping taken out",
        item(**AGE("alcohol"), shipping_profile="letterbox"),
        listed(item(**AGE("alcohol"), shipping_profile="letterbox"), ["age_shipping_unchecked"]),
        policies=True,
    ),
    case(
        "alcohol, only shipped, by a profile that checks no ID",
        item(**AGE("alcohol"), shipping_profile="letterbox", fulfil_methods=["shipping"]),
        held(item(), ["age_shipping_only_unchecked"]),
        policies=True,
    ),
    case(
        "alcohol, no ways said: nothing to check",
        item(**AGE("alcohol"), shipping_profile="letterbox", fulfil_methods=DROP),
        listed(item(**AGE("alcohol"), shipping_profile="letterbox", fulfil_methods=DROP)),
        policies=True,
        note="a quote for it offers only services marked id_check (quoteShipping, age_restricted)",
    ),
    case("options and no group", item(group=DROP), listed(item(group=DROP), ["options_without_group"])),
    case("a group and no options", item(options=DROP), listed(item(options=DROP), ["group_without_options"])),
    case(
        "one option twice",
        item(options=[{"key": "size", "name": "Size", "value": "6 cups"}, {"key": "size", "name": "Size", "value": "6"}]),
        listed(
            item(options=[{"key": "size", "name": "Size", "value": "6 cups"}, {"key": "size", "name": "Size", "value": "6"}]),
            ["option_key_twice"],
        ),
    ),
    case(
        "colour is color",
        item(options=[{"key": "size", "name": "Size", "value": "6 cups"}, {"key": "colour", "name": "Colour", "value": "Silver"}]),
        listed(item(options=[{"key": "size", "name": "Size", "value": "6 cups"}, {"key": "colour", "name": "Colour", "value": "Silver"}])),
        note="kept as color, the key of vocab/option-keys.json",
    ),
    case(
        "colour and color: one option twice",
        item(options=[{"key": "color", "name": "Colour", "value": "Silver"}, {"key": "colour", "name": "Colour", "value": "Red"}]),
        listed(
            item(options=[{"key": "color", "name": "Colour", "value": "Silver"}, {"key": "colour", "name": "Colour", "value": "Red"}]),
            ["option_key_twice"],
        ),
    ),
    case(
        "six options: shown as a product of its own",
        item(options=[{"key": "k%d" % i, "name": "K", "value": "v"} for i in range(6)]),
        listed(item(options=[{"key": "k%d" % i, "name": "K", "value": "v"} for i in range(6)]), ["group_dropped"]),
    ),
    case(
        "an option value of 101 characters: shown as a product of its own",
        item(options=[{"key": "size", "name": "Size", "value": "x" * 101}]),
        listed(item(options=[{"key": "size", "name": "Size", "value": "x" * 101}]), ["group_dropped"]),
    ),
    case(
        "a group position of 251 reads: the reader holds past the 250th",
        item(group={"id": "MOKA", "title": "Moka pot", "position": 251}),
        listed(item(group={"id": "MOKA", "title": "Moka pot", "position": 251})),
    ),
    case(
        "collect only, with a shipping profile: the profile dropped",
        item(fulfil_methods=["pickup"]),
        listed(item(fulfil_methods=["pickup"]), ["shipping_profile_unused"]),
    ),
    case(
        "shipping named twice: once",
        item(fulfil_methods=["shipping", "shipping"]),
        listed(item(fulfil_methods=["shipping", "shipping"])),
    ),
    case("no ways said, with a profile", item(fulfil_methods=DROP), listed(item(fulfil_methods=DROP))),
    case(
        "a shipping profile the policies document has",
        item(),
        listed(item()),
        policies=True,
    ),
    case(
        "a shipping profile the policies document does not have: held, never the default",
        item(shipping_profile="overnight"),
        held(item(), ["shipping_profile_unknown"]),
        policies=True,
    ),
    case(
        "a return policy the policies document does not have: held, never the default",
        item(return_policy="lifetime"),
        held(item(), ["return_policy_unknown"]),
        policies=True,
    ),
    case(
        "collect only, naming a profile the document does not have: the profile dropped",
        item(fulfil_methods=["pickup"], shipping_profile="overnight"),
        listed(item(fulfil_methods=["pickup"], shipping_profile="overnight"), ["shipping_profile_unused"]),
        policies=True,
    ),
    case(
        "ids not checked without a policies document",
        item(shipping_profile="overnight", return_policy="lifetime"),
        listed(item(shipping_profile="overnight", return_policy="lifetime")),
        note="with no document no default applies either: its shipping and returns are not known until one is read",
    ),
    case(
        "a weight in stone",
        item(weight={"value": 1, "unit": "st"}),
        listed(item(weight={"value": 1, "unit": "st"}), ["weight_unit"]),
    ),
    case(
        "a weight with four decimals",
        item(weight={"value": 0.6505, "unit": "kg"}),
        listed(item(weight={"value": 0.6505, "unit": "kg"}), ["weight_unit"]),
    ),
    case("a weight below 0", item(weight={"value": -1, "unit": "kg"}), listed(item(weight={"value": -1, "unit": "kg"}), ["weight_dropped"])),
    case("a weight in pounds", item(weight={"value": 1.5, "unit": "lb"}), listed(item(weight={"value": 1.5, "unit": "lb"}))),
    case("perishable: no right to withdraw", item(withdrawal="perishable"), listed(item(withdrawal="perishable"))),
    case("the right to withdraw runs", item(withdrawal="standard"), listed(item(withdrawal="standard"))),
    case("a withdrawal it does not know", item(withdrawal="final_sale"), listed(item(withdrawal="final_sale"), ["withdrawal_dropped"])),
    case("a page on http: left out", item(url="http://loja.example/produtos/moka-6"), listed(item(url="http://loja.example/produtos/moka-6"), ["url_dropped"])),
    case("a page as a path, not an address", item(url="/produtos/moka-6"), listed(item(url="/produtos/moka-6"), ["url_dropped"])),
    case("a page with a user in it", item(url="https://shop:pw@loja.example/p"), listed(item(url="https://shop:pw@loja.example/p"), ["url_dropped"])),
    case("a page on an IP address", item(url="https://192.0.2.10/p"), listed(item(url="https://192.0.2.10/p"), ["url_dropped"])),
    case("a page with a space in it", item(url="https://loja.example/moka 6"), listed(item(url="https://loja.example/moka 6"), ["url_dropped"])),
    case("https: with no //", item(url="https:loja.example/p"), listed(item(url="https:loja.example/p"), ["url_dropped"])),
    case(
        "a page with a port, a query and a fragment",
        item(url="https://loja.example:8443/p?id=6&c=%C3%A9#top"),
        listed(item(url="https://loja.example:8443/p?id=6&c=%C3%A9#top")),
    ),
    case("a page on the shop's own site", item(url="https://www.loja.example/p/moka-6"), listed(item(url="https://www.loja.example/p/moka-6")), site=SITE),
    case(
        "a page on another site: left out",
        item(url="https://marketplace.example/p/moka-6"),
        listed(item(url="https://marketplace.example/p/moka-6"), ["url_off_site"]),
        site=SITE,
    ),
    case(
        "a site that only ends like the shop's: another site",
        item(url="https://notloja.example/p/moka-6"),
        listed(item(url="https://notloja.example/p/moka-6"), ["url_off_site"]),
        site=SITE,
    ),
    case("no page", item(url=None), listed(item(url=None))),
    case("no pictures", item(media=[]), listed(item(media=[]))),
    case(
        "a video, then a picture",
        item(
            media=[
                {"type": "video", "url": "https://loja.example/v/moka.mp4"},
                {"type": "image", "url": "https://loja.example/img/moka-6.jpg"},
            ]
        ),
        listed(
            item(
                media=[
                    {"type": "video", "url": "https://loja.example/v/moka.mp4"},
                    {"type": "image", "url": "https://loja.example/img/moka-6.jpg"},
                ]
            )
        ),
    ),
    case(
        "a picture on http among two: that one left out",
        item(media=[{"type": "image", "url": "http://loja.example/img/old.jpg"}, PIC]),
        listed(item(media=[{"type": "image", "url": "http://loja.example/img/old.jpg"}, PIC]), ["media_entry_dropped"], media=[PIC]),
    ),
    case(
        "a picture's alt of 201 characters: the picture kept without it",
        item(media=[dict(PIC, alt="a" * 201)]),
        listed(item(media=[dict(PIC, alt="a" * 201)]), ["media_alt_dropped"], media=[{"type": "image", "url": PIC["url"]}]),
    ),
    case(
        "eleven pictures: the first ten",
        item(media=[{"type": "image", "url": "https://loja.example/img/%d.jpg" % i} for i in range(11)]),
        listed(
            item(media=[{"type": "image", "url": "https://loja.example/img/%d.jpg" % i} for i in range(11)]),
            ["media_entry_dropped"],
            media=[{"type": "image", "url": "https://loja.example/img/%d.jpg" % i} for i in range(10)],
        ),
    ),
    case("media missing: none", item(media=DROP), listed(item(media=DROP), ["media_dropped"])),
    case("a description of 5,000 characters", item(description="a" * 5000), listed(item(description="a" * 5000))),
    case(
        "a description of 5,000 characters, half of them emoji",
        item(description=EMOJI_5000),
        listed(item(description=EMOJI_5000)),
        note="a character is a Unicode code point: 5,000 of them here, 7,500 UTF-16 code units",
    ),
    case("a description of 5,001 characters: left out", item(description="a" * 5001), listed(item(description="a" * 5001), ["description_dropped"])),
    case(
        "a description of 5,001 characters, an emoji the last",
        item(description="a" * 5000 + "\U0001F355"),
        listed(item(description="a" * 5000 + "\U0001F355"), ["description_dropped"]),
    ),
    case(
        "a name of 150 characters, emoji among them",
        item(name="\U0001F355" * 150),
        listed(item(name="\U0001F355" * 150)),
    ),
    case("a name of 151 characters", item(name="n" * 151), unreadable("/name")),
    case("a SKU of 65 characters: left out", item(sku="S" * 65), listed(item(sku="S" * 65), ["sku_dropped"])),
    case("brand missing: null", item(brand=DROP), listed(item(brand=DROP), ["brand_dropped"])),
    case(
        "three members that only add, each left out alone, in the registry's order",
        item(weight={"value": 1, "unit": "st"}, url="http://loja.example/p", sku="S" * 65),
        listed(item(weight={"value": 1, "unit": "st"}, url="http://loja.example/p", sku="S" * 65), ["sku_dropped", "url_dropped", "weight_unit"]),
    ),
    case("price_model missing", item(price_model=DROP), unreadable("/price_model")),
    case(
        "a member it does not know is left out, and the rest kept",
        item(image_url="https://loja.example/img/moka-6.jpg", colour_hex="#c0c0c0"),
        listed(item(image_url="https://loja.example/img/moka-6.jpg", colour_hex="#c0c0c0")),
    ),
]

# --- prices ----------------------------------------------------------------------------------------

EUR = lambda v: {"value": v, "currency": "EUR"}  # noqa: E731
GBP = lambda v: {"value": v, "currency": "GBP"}  # noqa: E731

HAIRCUT = dict(
    SINGLE,
    id="CUT",
    sku=None,
    name="Haircut",
    description=None,
    gtin=None,
    no_gtin=True,
    brand=None,
    url=None,
    media=[],
    fulfil_methods=DROP,
    shipping_profile=DROP,
    weight=DROP,
    return_policy=DROP,
    price=EUR(2500),
    condition="new",
)


def svc(**changes):
    return item(**dict(HAIRCUT, **changes))


MODELS = [
    case("fixed", svc(), listed(svc())),
    case("from: cuts from 25", svc(price_model="from"), listed(svc(price_model="from"))),
    case(
        "range: repairs 40 to 120",
        svc(name="Repair", price_model="range", price=EUR(4000), price_max=EUR(12000)),
        listed(svc(name="Repair", price_model="range", price=EUR(4000), price_max=EUR(12000))),
    ),
    case("quote: on request, no price", svc(name="Wedding cake", price_model="quote", price=None), listed(svc(name="Wedding cake", price_model="quote", price=None))),
    case("quote with a price", svc(price_model="quote"), held(svc(), ["price_with_quote"])),
    case("fixed with no price", svc(price=None), held(svc(), ["price_missing"])),
    case("from with no price", svc(price_model="from", price=None), held(svc(), ["price_missing"])),
    case("from with a top price", svc(price_model="from", price_max=EUR(9000)), held(svc(), ["price_max_not_range"])),
    case("fixed with a top price", svc(price_max=EUR(9000)), held(svc(), ["price_max_not_range"])),
    case("range with no top", svc(price_model="range"), held(svc(), ["price_max_missing"])),
    case("range whose top is its bottom", svc(price_model="range", price_max=EUR(2500)), held(svc(), ["price_max_not_above"])),
    case("range whose top is below", svc(price_model="range", price_max=EUR(2000)), held(svc(), ["price_max_not_above"])),
    case(
        "range whose top is in another currency",
        svc(price_model="range", price_max=GBP(9000)),
        held(svc(), ["currency_mismatch"]),
    ),
    case(
        "quote with a price and a top: both named",
        svc(price_model="quote", price_max=EUR(9000)),
        held(svc(), ["price_with_quote", "price_max_not_range"]),
    ),
    case("a top price of 0", svc(price_model="range", price_max=EUR(0)), unreadable("/price_max/value")),
    case("a price_model it does not know", svc(price_model="per_hour"), unreadable("/price_model")),
    case("a was price above a fixed price", svc(list_price=EUR(3000)), listed(svc(list_price=EUR(3000)))),
    case("a was price beside from: dropped", svc(price_model="from", list_price=EUR(3000)), listed(svc(price_model="from", list_price=EUR(3000)), ["list_price_not_fixed"])),
    case(
        "a was price beside quote: dropped",
        svc(price_model="quote", price=None, list_price=EUR(3000)),
        listed(svc(price_model="quote", price=None, list_price=EUR(3000)), ["list_price_not_fixed"]),
    ),
    case("a was price equal to the price: dropped", svc(list_price=EUR(2500)), listed(svc(list_price=EUR(2500)), ["list_price_not_above"])),
    case("a was price in another currency: dropped", svc(list_price=GBP(3000)), listed(svc(list_price=GBP(3000)), ["list_price_currency"])),
    case("a was price of 0: dropped", svc(list_price=EUR(0)), listed(svc(list_price=EUR(0)), ["list_price_dropped"])),
    case(
        "a unit price with no reference: dropped",
        svc(unit_price={"measure": {"value": 1, "unit": "kg"}}),
        listed(svc(unit_price={"measure": {"value": 1, "unit": "kg"}}), ["unit_price_dropped"]),
    ),
    case(
        "a unit price beside range: dropped",
        svc(price_model="range", price_max=EUR(9000), unit_price={"measure": {"value": 1, "unit": "kg"}, "reference": {"value": 1, "unit": "kg"}}),
        listed(
            svc(price_model="range", price_max=EUR(9000), unit_price={"measure": {"value": 1, "unit": "kg"}, "reference": {"value": 1, "unit": "kg"}}),
            ["unit_price_not_fixed"],
        ),
    ),
    case(
        "a unit price in grams per ounce: dropped",
        svc(unit_price={"measure": {"value": 500, "unit": "g"}, "reference": {"value": 1, "unit": "oz"}}),
        listed(svc(unit_price={"measure": {"value": 500, "unit": "g"}, "reference": {"value": 1, "unit": "oz"}}), ["unit_mismatch"]),
    ),
    case("tax not included on this offer", svc(tax_included=False), listed(svc(tax_included=False))),
]

UNITS = {
    "mg": ("mass_metric", 1), "g": ("mass_metric", 1000), "kg": ("mass_metric", 1000000),
    "oz": ("mass_imperial", 1), "lb": ("mass_imperial", 16),
    "ml": ("volume_metric", 1), "cl": ("volume_metric", 10), "l": ("volume_metric", 1000), "cbm": ("volume_metric", 1000000),
    "cm": ("length_metric", 1), "m": ("length_metric", 100),
    "in": ("length_imperial", 1), "ft": ("length_imperial", 12), "yd": ("length_imperial", 36),
    "sqm": ("area_metric", 1), "sqft": ("area_imperial", 1), "ct": ("count", 1),
}


def three_decimals(n):
    s = jnum(n)
    if s.startswith("-"):
        return False
    whole, _, frac = s.partition(".")
    return whole.isdigit() and len(frac) <= 3 and (frac == "" or frac.isdigit())


def unit_price(price, up):
    m, r = UNITS.get(up["measure"]["unit"]), UNITS.get(up["reference"]["unit"])
    if not m or not r:
        return {"problem": "unit_unknown"}
    if m[0] != r[0]:
        return {"problem": "unit_mismatch"}
    if not three_decimals(up["measure"]["value"]):
        return {"problem": "unit_measure"}
    q = Fraction(price["value"]) * up["reference"]["value"] * r[1] / (Fraction(jnum(up["measure"]["value"])) * m[1])
    amount = (2 * q.numerator + q.denominator) // (2 * q.denominator)  # a half up
    return {"amount": amount, "currency": price["currency"]}


def up_case(name, price, measure, reference, note=None):
    up = {"measure": {"value": measure[0], "unit": measure[1]}, "reference": {"value": reference[0], "unit": reference[1]}}
    c = {"name": name, "price": price, "unit_price": up, "expect": unit_price(price, up)}
    if note:
        c["note"] = note
    return c


UNIT_PRICES = [
    up_case("500 g at 4.50, per kg", EUR(450), (500, "g"), (1, "kg")),
    up_case("330 ml at 1.99, per litre", GBP(199), (330, "ml"), (1, "l"), "603.03, so 603"),
    up_case("0.75 l at 12.99, per litre", EUR(1299), (0.75, "l"), (1, "l")),
    up_case("six 330 ml cans at 5.49, per litre", GBP(549), (1980, "ml"), (1, "l"), "the measure is the whole pack: 6 × 330 ml"),
    up_case("70 cl at 15.99, per litre", EUR(1599), (70, "cl"), (1, "l")),
    up_case("half a minor unit rounds up", EUR(1), (2, "g"), (1, "g"), "0.5, so 1"),
    up_case("one and a half rounds up", EUR(3), (2, "g"), (1, "g"), "1.5, so 2"),
    up_case("15.25 oz at 4.49, per ounce", {"value": 449, "currency": "USD"}, (15.25, "oz"), (1, "oz")),
    up_case("15.25 oz at 4.49, per pound", {"value": 449, "currency": "USD"}, (15.25, "oz"), (1, "lb")),
    up_case("1 kg at KWD 2.500, per 100 g", {"value": 2500, "currency": "KWD"}, (1, "kg"), (100, "g"), "KWD has three decimals"),
    up_case("400 g at JPY 398, per 100 g", {"value": 398, "currency": "JPY"}, (400, "g"), (100, "g"), "JPY has none: 99.5, so 100"),
    up_case("120 tablets at 8.99, per 100", EUR(899), (120, "ct"), (100, "ct")),
    up_case("25 m of cable at 19.99, per 10 m", EUR(1999), (25, "m"), (10, "m")),
    up_case("6 ft at 12.00, per yard", {"value": 1200, "currency": "USD"}, (6, "ft"), (1, "yd")),
    up_case("2.5 sqm at 49.90, per sqm", EUR(4990), (2.5, "sqm"), (1, "sqm")),
    up_case("grams per ounce never mix", EUR(450), (500, "g"), (1, "oz")),
    up_case("grams per litre never mix", EUR(450), (500, "g"), (1, "l")),
    up_case("a unit it does not know", GBP(450), (1, "pint"), (1, "l")),
    up_case("a measure with four decimals", EUR(450), (0.3333, "kg"), (1, "kg")),
]
assert UNIT_PRICES[0]["expect"] == {"amount": 900, "currency": "EUR"}
assert UNIT_PRICES[1]["expect"]["amount"] == 603
assert UNIT_PRICES[5]["expect"]["amount"] == 1 and UNIT_PRICES[6]["expect"]["amount"] == 2


def was_price(list_price, history):
    h = sorted(history, key=lambda p: t(p["at"]))
    if not h:
        return {"shown": False, "why": "list_price_never_seen"}
    if h[-1]["value"] >= list_price:
        return {"shown": False, "why": "list_price_not_above"}
    # The reduction began at the first of the last run of prices below it; with none before that run, the
    # record never saw the price at or above it, and the reduction's start is not known.
    k = len(h) - 1
    while k > 0 and h[k - 1]["value"] < list_price:
        k -= 1
    if k == 0:
        return {"shown": False, "why": "list_price_never_seen"}
    start = t(h[k]["at"])
    window = start - timedelta(days=30)
    if t(h[0]["at"]) > window:
        return {"shown": False, "why": "list_price_history_short"}
    for i in range(k):
        if t(h[i + 1]["at"]) > window and h[i]["value"] < list_price:
            return {"shown": False, "why": "list_price_sold_below"}
    return {"shown": True, "since": h[k]["at"]}


def wp(name, list_price, points, expect_why=None, note=None):
    history = [{"at": a, "value": v} for a, v in points]
    got = was_price(list_price, history)
    if expect_why == "shown":
        assert got["shown"], (name, got)
    elif expect_why:
        assert got.get("why") == expect_why, (name, got)
    c = {"name": name, "list_price": list_price, "history": history, "expect": got}
    if note:
        c["note"] = note
    return c


D0 = "2026-09-01T00:00:00.000Z"
CUT = "2026-10-20T00:00:00.000Z"
WAS = [
    wp("at 20.00 since 1 September, 15.00 from 20 October", 2000, [(D0, 2000), (CUT, 1500)], "shown"),
    wp("the price now is the was price", 2000, [(D0, 2000)], "list_price_not_above"),
    wp("the price now is above it", 2000, [(D0, 2000), (CUT, 2100)], "list_price_not_above"),
    wp("no record at all", 2000, [], "list_price_never_seen"),
    wp("recorded from 1 October only", 2000, [("2026-10-01T00:00:00.000Z", 2000), (CUT, 1500)], "list_price_history_short"),
    wp("recorded from exactly 30 days before", 2000, [("2026-09-20T00:00:00.000Z", 2000), (CUT, 1500)], "shown"),
    wp("recorded from a minute short of 30 days", 2000, [("2026-09-20T00:01:00.000Z", 2000), (CUT, 1500)], "list_price_history_short"),
    wp(
        "18.00 for four days inside the 30",
        2000,
        [(D0, 2000), ("2026-10-01T00:00:00.000Z", 1800), ("2026-10-05T00:00:00.000Z", 2000), (CUT, 1500)],
        "list_price_sold_below",
    ),
    wp(
        "18.00 in August, before the 30 days, counts for nothing",
        2000,
        [("2026-08-01T00:00:00.000Z", 1800), ("2026-08-15T00:00:00.000Z", 2000), (CUT, 1500)],
        "shown",
    ),
    wp(
        "a further cut keeps the reduction's start",
        2000,
        [(D0, 2000), (CUT, 1500), ("2026-10-27T00:00:00.000Z", 1200)],
        "shown",
        "since stays 20 October",
    ),
    wp("a was price below the price before: allowed", 1800, [(D0, 2000), (CUT, 1500)], "shown"),
    wp(
        "a was price it never had",
        2500,
        [(D0, 2000), (CUT, 1500)],
        "list_price_never_seen",
        "below 25.00 throughout: the record never saw it at or above, however long the record runs",
    ),
    wp(
        "a sale already running when the record began",
        2000,
        [(D0, 1500), ("2026-10-25T00:00:00.000Z", 1400)],
        "list_price_never_seen",
        "a reader's first read of a shop mid-sale: never shown for this reduction",
    ),
    wp(
        "back at the was price for 30 days, then a new reduction: shown",
        2000,
        [("2026-08-01T00:00:00.000Z", 1500), ("2026-09-15T00:00:00.000Z", 2000), (CUT, 1500)],
        "shown",
        "the reduction that began on 20 October is a new one",
    ),
    wp(
        "a dip that ends a day inside the 30",
        2000,
        [("2026-08-01T00:00:00.000Z", 2000), ("2026-09-19T00:00:00.000Z", 1900), ("2026-09-21T00:00:00.000Z", 2000), (CUT, 1500)],
        "list_price_sold_below",
    ),
    wp(
        "a dip that ends as the 30 days begin",
        2000,
        [("2026-08-01T00:00:00.000Z", 2000), ("2026-09-19T00:00:00.000Z", 1900), ("2026-09-20T00:00:00.000Z", 2000), (CUT, 1500)],
        "shown",
    ),
    wp("one price, below it, recorded today", 2000, [(CUT, 1500)], "list_price_never_seen"),
    wp(
        "the record given out of order",
        2000,
        [(CUT, 1500), (D0, 2000)],
        "shown",
        "a reader orders it by time",
    ),
]

# --- options ---------------------------------------------------------------------------------------


def variant(vid, position, size, material="Aluminium", **changes):
    return item(
        **dict(
            dict(
                id=vid,
                name="Moka pot, %s, %s" % (size, material.lower()),
                group={"id": "MOKA", "title": "Moka pot", "position": position},
                options=[{"key": "size", "name": "Size", "value": size}, {"key": "material", "name": "Material", "value": material}],
            ),
            **changes,
        )
    )


def group_case(name, items, expect, note=None):
    c = {"name": name, "items": items, "expect": expect}
    if note:
        c["note"] = note
    return c


def grp(state, members, problems=(), held=(), title="Moka pot", gid="MOKA"):
    return {"id": gid, "title": title, "state": state, "problems": list(problems), "members": members, "held": list(held)}


THREE = [variant("MOKA-3-ALU", 1, "3 cups"), variant("MOKA-6-ALU", 2, "6 cups"), variant("MOKA-9-ALU", 3, "9 cups")]
TEE = {
    "id": "TEE",
    "state": "listed",
    "sku": None,
    "name": "T-shirt",
    "description": None,
    "group": {"id": "TEE", "title": "T-shirt", "position": 1},
    "options": [{"key": "size", "name": "Size", "value": "S"}],
    "price_model": "fixed",
    "price": {"value": 1500, "currency": "EUR"},
    "availability": "on_sale",
    "gtin": None,
    "no_gtin": True,
    "brand": None,
    "mpn": None,
    "condition": "new",
    "url": None,
    "media": [],
    "updated_at": "2026-11-02T09:12:00.000Z",
    "hash": "0000000000000000",
}


def repeat(template, count):
    """The i-th copy (from 0): id and the first option's value with i in three digits, position i + 1."""
    out = []
    for i in range(count):
        it = copy.deepcopy(template)
        it["id"] = "%s-%03d" % (template["id"], i)
        it["group"]["position"] = i + 1
        it["options"][0]["value"] = "%s%03d" % (template["options"][0]["value"], i)
        out.append(it)
    return out


big = repeat(TEE, 252)
big_sorted = sorted(big, key=lambda it: (it["group"]["position"], it["id"]))

GROUPS = [
    group_case("three sizes: one product", THREE, [grp("grouped", ["MOKA-3-ALU", "MOKA-6-ALU", "MOKA-9-ALU"])]),
    group_case(
        "in order of position, then id",
        [variant("MOKA-9-ALU", 1, "9 cups"), variant("MOKA-3-ALU", 2, "3 cups"), variant("MOKA-6-ALU", 1, "6 cups")],
        [grp("grouped", ["MOKA-6-ALU", "MOKA-9-ALU", "MOKA-3-ALU"])],
    ),
    group_case(
        "options in another order are the same keys",
        [
            variant("MOKA-3-ALU", 1, "3 cups"),
            variant(
                "MOKA-6-ALU",
                2,
                "6 cups",
                options=[{"key": "material", "name": "Material", "value": "Aluminium"}, {"key": "size", "name": "Size", "value": "6 cups"}],
            ),
        ],
        [grp("grouped", ["MOKA-3-ALU", "MOKA-6-ALU"])],
    ),
    group_case("one variant is a group too", [variant("MOKA-6-ALU", 1, "6 cups")], [grp("grouped", ["MOKA-6-ALU"])]),
    group_case(
        "a title that differs: each its own product",
        [variant("MOKA-3-ALU", 1, "3 cups"), variant("MOKA-6-ALU", 2, "6 cups", group={"id": "MOKA", "title": "Moka Pot", "position": 2})],
        [grp("ungrouped", ["MOKA-3-ALU", "MOKA-6-ALU"], ["group_title_differs"])],
    ),
    group_case(
        "a variant with a key the others lack",
        [
            variant("MOKA-3-ALU", 1, "3 cups"),
            variant(
                "MOKA-6-ALU",
                2,
                "6 cups",
                options=[
                    {"key": "size", "name": "Size", "value": "6 cups"},
                    {"key": "material", "name": "Material", "value": "Aluminium"},
                    {"key": "color", "name": "Colour", "value": "Silver"},
                ],
            ),
        ],
        [grp("ungrouped", ["MOKA-3-ALU", "MOKA-6-ALU"], ["group_options_differ"])],
    ),
    group_case(
        "one key, two names",
        [
            variant("MOKA-3-ALU", 1, "3 cups"),
            variant(
                "MOKA-6-ALU",
                2,
                "6 cups",
                options=[{"key": "size", "name": "Cups", "value": "6 cups"}, {"key": "material", "name": "Material", "value": "Aluminium"}],
            ),
        ],
        [grp("ungrouped", ["MOKA-3-ALU", "MOKA-6-ALU"], ["group_option_name_differs"])],
    ),
    group_case(
        "two variants alike in every value",
        [variant("MOKA-6-ALU", 1, "6 cups"), variant("MOKA-6-ALU-B", 2, "6 cups")],
        [grp("ungrouped", ["MOKA-6-ALU", "MOKA-6-ALU-B"], ["group_duplicate_variant"])],
    ),
    group_case(
        "colour in one variant, color in another: one key",
        [
            variant("MOKA-3-ALU", 1, "3 cups", options=[{"key": "size", "name": "Size", "value": "3 cups"}, {"key": "colour", "name": "Colour", "value": "Silver"}]),
            variant("MOKA-6-ALU", 2, "6 cups", options=[{"key": "size", "name": "Size", "value": "6 cups"}, {"key": "color", "name": "Colour", "value": "Silver"}]),
        ],
        [grp("grouped", ["MOKA-3-ALU", "MOKA-6-ALU"])],
        "each item is read first (readCatalogueItemV2), which takes colour as color",
    ),
    group_case(
        "values compared exactly: Aluminium and aluminium differ",
        [variant("MOKA-6-ALU", 1, "6 cups"), variant("MOKA-6-alu", 2, "6 cups", material="aluminium")],
        [grp("grouped", ["MOKA-6-ALU", "MOKA-6-alu"])],
    ),
    group_case(
        "two groups of one business, in order of id",
        [
            variant("MOKA-6-ALU", 1, "6 cups"),
            item(
                id="CUP-RED",
                name="Espresso cup, red",
                group={"id": "CUP", "title": "Espresso cup", "position": 1},
                options=[{"key": "color", "name": "Colour", "value": "Red"}],
            ),
            item(**SINGLE),
        ],
        [grp("grouped", ["CUP-RED"], title="Espresso cup", gid="CUP"), grp("grouped", ["MOKA-6-ALU"])],
        "a product with no group is in none",
    ),
    dict(
        group_case(
            "252 variants: the last two held",
            None,
            [grp("grouped", [it["id"] for it in big_sorted[:250]], ["group_too_large"], [it["id"] for it in big_sorted[250:]], title="T-shirt", gid="TEE")],
            "positions run past 250: the 251st and 252nd are held",
        ),
        items=None,
        repeat={"count": 252, "item": TEE},
    ),
]
for g in GROUPS:
    if g.get("items") is None:
        del g["items"]

# --- version 1 -------------------------------------------------------------------------------------

V1_AVAIL = {"in_stock": "in_stock", "limited": "in_stock", "out_of_stock": "out_of_stock", "on_sale": "on_sale"}


def utf16_len(s):
    return len(s.encode("utf-16-le")) // 2


def cut(s, n):
    """At most n characters: Unicode code points, as a Python str counts them."""
    return s[:n]


def v1_of(it, as_of):
    if len(it["id"]) > 64:
        return None
    gone = {"id": it["id"], "state": "withdrawn", "updated_at": it["updated_at"]}
    if it["state"] == "withdrawn":
        return gone
    if (
        it["price_model"] != "fixed"
        or it["price"] is None
        or it["availability"] not in V1_AVAIL
        or "age_restricted" in it
        or "tax_included" in it
        or ("available_until" in it and t(it["available_until"]) <= t(as_of))
    ):
        return gone
    images = [m for m in it["media"] if m["type"] == "image"]
    body = {
        "id": it["id"],
        "state": "listed",
        "sku": it["sku"],
        "name": it["name"],
        "description": None if it["description"] is None else cut(it["description"], 1000),
        "price": {"value": it["price"]["value"], "currency": it["price"]["currency"]},
        "availability": V1_AVAIL[it["availability"]],
        "gtin": it["gtin"],
        "no_gtin": it["no_gtin"],
    }
    if "multipack" in it:
        body["multipack"] = it["multipack"]
    body.update(
        {
            "brand": it["brand"],
            "mpn": it["mpn"],
            "condition": it["condition"],
            "url": it["url"],
            "image_url": images[0]["url"] if images else None,
        }
    )
    body["updated_at"] = it["updated_at"]
    body["hash"] = item_hash(body)
    return body


def v1_case(name, it, note=None, expect_state=None):
    got = v1_of(it, AS_OF)
    if expect_state is not None:
        assert (got["state"] if got else None) == expect_state, (name, got)
    c = {"name": name, "v2": it, "v1": got}
    if note:
        c["note"] = note
    return c


EMOJI_DESC = "a" * 999 + "\U0001F355" + "b" * 10
assert len(cut(EMOJI_DESC, 1000)) == 1000 and utf16_len(cut(EMOJI_DESC, 1000)) == 1001
V1 = [
    v1_case("a variant: its own offer, by its own name", item(), expect_state="listed"),
    v1_case("few left reads as in stock", item(availability="limited"), expect_state="listed"),
    v1_case("on sale, no count", item(availability="on_sale"), expect_state="listed"),
    v1_case("out of stock", item(availability="out_of_stock"), expect_state="listed"),
    v1_case("a pre-order: withdrawn", item(availability="preorder", available_from="2026-12-01T00:00:00.000Z"), expect_state="withdrawn"),
    v1_case("a back-order: withdrawn", item(availability="backorder"), expect_state="withdrawn"),
    v1_case("made to order: withdrawn", item(availability="made_to_order"), expect_state="withdrawn"),
    v1_case("from: withdrawn", svc(price_model="from"), expect_state="withdrawn"),
    v1_case("range: withdrawn", svc(price_model="range", price=EUR(4000), price_max=EUR(12000)), expect_state="withdrawn"),
    v1_case("quote: withdrawn", svc(price_model="quote", price=None), expect_state="withdrawn"),
    v1_case(
        "age-restricted: withdrawn",
        item(**SINGLE, age_restricted={"min_age": 18, "kind": "alcohol", "check": "id_at_handover"}),
        expect_state="withdrawn",
    ),
    v1_case("past its last day: withdrawn", item(available_until="2026-11-01T00:00:00.000Z"), expect_state="withdrawn"),
    v1_case("a season still on", item(available_until="2026-12-24T23:59:59.000Z"), expect_state="listed"),
    v1_case(
        "its own tax, whatever the catalogue's: withdrawn",
        item(tax_included=False),
        "so a change to catalogue.tax_included never changes a version 1 item",
        expect_state="withdrawn",
    ),
    v1_case("its own tax, said to include it: withdrawn too", item(tax_included=True), expect_state="withdrawn"),
    v1_case("an id of 65 characters: no version 1 item", item(id="X" * 65)),
    v1_case(
        "withdrawn with an id of 65 characters: none either",
        {"id": "X" * 65, "state": "withdrawn", "updated_at": "2026-11-02T09:11:00.000Z"},
    ),
    v1_case(
        "withdrawn",
        {"id": "MOKA-3-ALU", "state": "withdrawn", "updated_at": "2026-11-02T09:11:00.000Z"},
        expect_state="withdrawn",
    ),
    v1_case("a description of 1,200 characters: cut to 1,000", item(description="d" * 1200), expect_state="listed"),
    v1_case(
        "cut by characters: the pizza slice is the 1,000th",
        item(description=EMOJI_DESC),
        note="999 letters and a pizza slice are 1,000 code points (1,001 UTF-16 code units): a character is a code point",
        expect_state="listed",
    ),
    v1_case("only a video: no picture", item(media=[{"type": "video", "url": "https://loja.example/v/moka.mp4"}]), expect_state="listed"),
    v1_case(
        "a video, then a picture: the picture",
        item(media=[{"type": "video", "url": "https://loja.example/v/moka.mp4"}, {"type": "image", "url": "https://loja.example/img/moka-6.jpg"}]),
        expect_state="listed",
    ),
    v1_case("a pack of twelve keeps multipack", item(**SINGLE, multipack=12), expect_state="listed"),
    v1_case("a bundle is an offer like any other", item(**SINGLE, is_bundle=True, gtin=None), expect_state="listed"),
    v1_case("what it says of withdrawal is left out", item(withdrawal="perishable"), expect_state="listed"),
    v1_case(
        "the was price and the unit price are left out",
        item(
            list_price={"value": 3990, "currency": "EUR"},
            unit_price={"measure": {"value": 1, "unit": "ct"}, "reference": {"value": 1, "unit": "ct"}},
        ),
        expect_state="listed",
    ),
]

# --- policies --------------------------------------------------------------------------------------


def money(v, c="EUR"):
    return {"value": v, "currency": c}


EU_DOC = {
    "version": 1,
    "domain": "inbox.loja.example",
    "as_of": AS_OF,
    "rev": "0000000000000000",
    "shipping_profiles": [
        {
            "id": "standard",
            "name": "Standard",
            "default": True,
            "zones": [
                {
                    "name": "Mainland",
                    "destinations": [{"country": "PT"}],
                    "excluded": [{"country": "PT", "regions": ["PT-20", "PT-30"]}],
                    "services": [
                        {
                            "id": "standard",
                            "name": "Standard",
                            "carrier": "ctt",
                            "tracked": True,
                            "id_check": False,
                            "transit_days": {"min": 1, "max": 3},
                            "rate": {
                                "basis": "by_weight",
                                "unit": "kg",
                                "bands": [
                                    {"up_to": 2, "amount": money(450)},
                                    {"up_to": 10, "amount": money(750)},
                                    {"up_to": 30, "amount": money(1290)},
                                ],
                            },
                            "free_over": money(5000),
                        },
                        {
                            "id": "next_day",
                            "name": "Next day",
                            "carrier": "dpd",
                            "tracked": True,
                            "id_check": True,
                            "transit_days": {"min": 1, "max": 1},
                            "rate": {"basis": "flat", "amount": money(990)},
                        },
                    ],
                },
                {
                    "name": "Islands",
                    "destinations": [{"country": "PT", "regions": ["PT-20", "PT-30"]}],
                    "services": [
                        {
                            "id": "standard",
                            "name": "Standard",
                            "carrier": "ctt",
                            "tracked": True,
                            "id_check": False,
                            "transit_days": {"min": 3, "max": 7},
                            "rate": {"basis": "flat", "amount": money(1200)},
                        }
                    ],
                },
                {
                    "name": "Europe",
                    "destinations": [{"country": "ES"}, {"country": "FR"}, {"country": "DE"}],
                    "services": [
                        {
                            "id": "standard",
                            "name": "Standard",
                            "tracked": True,
                            "id_check": False,
                            "transit_days": {"min": 3, "max": 6},
                            "rate": {
                                "basis": "by_order_value",
                                "bands": [
                                    {"up_to": money(5000), "amount": money(1490)},
                                    {"up_to": None, "amount": money(990)},
                                ],
                            },
                            "free_over": money(15000),
                        }
                    ],
                },
                {
                    "name": "Highlands and islands",
                    "destinations": [{"country": "GB", "postal_prefixes": ["PH20", "PH21", "KA27", "KA28", "PA20", "IV", "HS", "ZE", "KW15"]}],
                    "services": [
                        {
                            "id": "tracked",
                            "name": "Tracked",
                            "carrier": "royal_mail",
                            "tracked": True,
                            "id_check": False,
                            "transit_days": {"min": 4, "max": 8},
                            "rate": {"basis": "flat", "amount": money(1500)},
                        }
                    ],
                },
                {
                    "name": "Central London",
                    "destinations": [{"country": "GB", "postal_prefixes": ["EC1", "W1", "WC2N 5"]}],
                    "services": [
                        {
                            "id": "courier",
                            "name": "Same-day courier",
                            "tracked": True,
                            "id_check": True,
                            "transit_days": {"min": 0, "max": 0},
                            "rate": {"basis": "flat", "amount": money(1200)},
                        }
                    ],
                },
                {
                    "name": "United Kingdom",
                    "destinations": [{"country": "GB"}],
                    "excluded": [{"country": "GB", "postal_prefixes": ["BT", "IM", "JE", "GY"]}],
                    "services": [
                        {
                            "id": "tracked",
                            "name": "Tracked",
                            "carrier": "royal_mail",
                            "tracked": True,
                            "id_check": False,
                            "transit_days": {"min": 3, "max": 6},
                            "rate": {"basis": "per_item", "amount": money(600)},
                        }
                    ],
                },
            ],
        },
        {
            "id": "chilled",
            "name": "Chilled, our own van",
            "zones": [
                {
                    "name": "Lisbon",
                    "destinations": [{"country": "PT", "postal_prefixes": ["1", "26", "27"]}],
                    "services": [
                        {
                            "id": "van",
                            "name": "Our van",
                            "tracked": False,
                            "id_check": True,
                            "transit_days": {"min": 0, "max": 1},
                            "rate": {"basis": "flat", "amount": money(0)},
                        }
                    ],
                }
            ],
        },
        {
            "id": "letterbox",
            "name": "Through the letterbox",
            "zones": [
                {
                    "name": "Portugal",
                    "destinations": [{"country": "PT"}],
                    "services": [
                        {
                            "id": "letterbox",
                            "name": "Letterbox",
                            "carrier": "ctt",
                            "tracked": False,
                            "id_check": False,
                            "transit_days": {"min": 2, "max": 4},
                            "rate": {"basis": "flat", "amount": money(290)},
                        }
                    ],
                }
            ],
        },
    ],
    "return_policies": [
        {
            "id": "standard",
            "name": "30 days",
            "default": True,
            "eligibility": "window",
            "window_days": 30,
            "resolutions": ["refund", "exchange"],
            "methods": ["by_post", "in_store"],
            "return_postage": "customer",
        },
        {"id": "final_sale", "name": "Final sale", "eligibility": "not_accepted", "resolutions": [], "methods": []},
        {
            "id": "credit",
            "name": "Store credit, in the shop",
            "eligibility": "window",
            "window_days": 14,
            "resolutions": ["store_credit"],
            "methods": ["in_store"],
        },
    ],
}

US_DOC = {
    "version": 1,
    "domain": "inbox.hardware.example",
    "as_of": AS_OF,
    "rev": "0000000000000000",
    "shipping_profiles": [
        {
            "id": "ground",
            "name": "Ground",
            "default": True,
            "zones": [
                {
                    "name": "Lower 48",
                    "destinations": [{"country": "US"}],
                    "excluded": [{"country": "US", "regions": ["US-AK", "US-HI"]}],
                    "services": [
                        {
                            "id": "ground",
                            "name": "Ground",
                            "carrier": "usps",
                            "tracked": True,
                            "id_check": False,
                            "transit_days": {"min": 2, "max": 5},
                            "rate": {
                                "basis": "by_weight",
                                "unit": "lb",
                                "bands": [
                                    {"up_to": 1, "amount": money(599, "USD")},
                                    {"up_to": 5, "amount": money(899, "USD")},
                                    {"up_to": None, "amount": money(1499, "USD")},
                                ],
                            },
                        },
                        {
                            "id": "freight",
                            "name": "Freight",
                            "tracked": True,
                            "id_check": False,
                            "transit_days": {"min": 5, "max": 10},
                            "rate": {"basis": "by_order_value", "bands": [{"up_to": money(50000, "USD"), "amount": money(4900, "USD")}]},
                        },
                    ],
                }
            ],
        }
    ],
    "return_policies": [
        {
            "id": "seven_days",
            "name": "7 days",
            "default": True,
            "eligibility": "window",
            "window_days": 7,
            "resolutions": ["refund"],
            "methods": ["by_post"],
            "return_postage": "business",
            "restocking_fee": {"percent": 10},
        },
        {"id": "no_returns", "name": "No returns", "eligibility": "not_accepted", "resolutions": [], "methods": []},
    ],
}


def with_rev(doc):
    doc = copy.deepcopy(doc)
    doc["rev"] = "0000000000000000"
    doc["rev"] = sha256(canonical({k: v for k, v in doc.items() if k not in ("rev", "as_of")}))[:16]
    return doc


EU_DOC = with_rev(EU_DOC)
US_DOC = with_rev(US_DOC)


def pointer(path):
    return [seg.replace("~1", "/").replace("~0", "~") for seg in path.split("/")[1:]]


def apply_patch(doc, ops):
    """RFC 6902 JSON Patch: add, replace and remove, which is all these cases use."""
    doc = copy.deepcopy(doc)
    for op in ops:
        *parents, last = pointer(op["path"])
        at = doc
        for seg in parents:
            at = at[int(seg)] if isinstance(at, list) else at[seg]
        key = int(last) if isinstance(at, list) else last
        if op["op"] == "remove":
            del at[key]
        elif op["op"] == "replace":
            assert (key < len(at)) if isinstance(at, list) else (key in at), op
            at[key] = copy.deepcopy(op["value"])
        elif op["op"] == "add":
            if isinstance(at, list):
                at.insert(key, copy.deepcopy(op["value"]))
            else:
                at[key] = copy.deepcopy(op["value"])
        else:
            raise ValueError(op)
    return doc


def read_case(name, base, patch, problems, profiles, returns, default_shipping, default_returns, note=None):
    apply_patch(EU_DOC if base == "eu" else US_DOC, patch)  # every op applies
    c = {
        "name": name,
        "doc": {"base": base, "patch": patch},
        "expect": None
        if problems is None
        else {
            "problems": [{"path": p, "code": "policies_" + code} for p, code in problems],
            "shipping_profiles": profiles,
            "return_policies": returns,
            "default_shipping_profile": default_shipping,
            "default_return_policy": default_returns,
        },
    }
    if note:
        c["note"] = note
    return c


def rep(path, value):
    return {"op": "replace", "path": path, "value": value}


def add_(path, value):
    return {"op": "add", "path": path, "value": value}


def rem(path):
    return {"op": "remove", "path": path}


SV = "/shipping_profiles/0/zones/0/services/0"
ALL_P = ["standard", "chilled", "letterbox"]
ALL_R = ["standard", "final_sale", "credit"]
S0 = "shipping_profiles[0].zones[0].services[0]"
READS = [
    read_case("a shop's document, every part reads", "eu", [], [], ALL_P, ALL_R, "standard", "standard"),
    read_case("a shop outside the EU and the UK: 7 days, and no returns", "us", [], [], ["ground"], ["seven_days", "no_returns"], "ground", "seven_days"),
    read_case("two default profiles: the first stays", "eu", [add_("/shipping_profiles/1/default", True)], [("shipping_profiles[1].default", "default_twice")], ALL_P, ALL_R, "standard", "standard"),
    read_case("two default policies: the first stays", "eu", [add_("/return_policies/2/default", True)], [("return_policies[2].default", "default_twice")], ALL_P, ALL_R, "standard", "standard"),
    read_case("an id twice: the later dropped", "eu", [rep("/shipping_profiles/1/id", "standard")], [("shipping_profiles[1]", "id_twice")], ["standard", "letterbox"], ALL_R, "standard", "standard"),
    read_case(
        "a service in two currencies: dropped",
        "eu",
        [rep(SV + "/free_over", money(5000, "GBP"))],
        [(S0, "currency_mixed")],
        ALL_P,
        ALL_R,
        "standard",
        "standard",
        "the zone keeps its next-day service",
    ),
    read_case("weight bands that fall", "eu", [rep(SV + "/rate/bands/1/up_to", 1)], [(S0, "band_order")], ALL_P, ALL_R, "standard", "standard"),
    read_case("an open band first", "eu", [rep(SV + "/rate/bands/0/up_to", None)], [(S0, "band_order")], ALL_P, ALL_R, "standard", "standard"),
    read_case("a weight band with four decimals", "eu", [rep(SV + "/rate/bands/0/up_to", 1.2345)], [(S0, "band_order")], ALL_P, ALL_R, "standard", "standard"),
    read_case("transit days the wrong way round", "eu", [rep(SV + "/transit_days", {"min": 3, "max": 1})], [(S0, "transit_order")], ALL_P, ALL_R, "standard", "standard"),
    read_case("a carrier it does not know: the carrier alone", "eu", [rep(SV + "/carrier", "pigeon_post")], [(S0 + ".carrier", "carrier_unknown")], ALL_P, ALL_R, "standard", "standard"),
    read_case(
        "a profile whose only service is dropped",
        "eu",
        [
            rep("/shipping_profiles/1/zones/0/services/0/rate", {"basis": "flat", "amount": money(500, "GBP")}),
            add_("/shipping_profiles/1/zones/0/services/0/free_over", money(5000)),
        ],
        [
            ("shipping_profiles[1].zones[0].services[0]", "currency_mixed"),
            ("shipping_profiles[1].zones[0]", "zone_empty"),
            ("shipping_profiles[1]", "profile_empty"),
        ],
        ["standard", "letterbox"],
        ALL_R,
        "standard",
        "standard",
    ),
    read_case("a profile that does not read", "eu", [rem("/shipping_profiles/1/zones")], [("shipping_profiles[1]", "unreadable")], ["standard", "letterbox"], ALL_R, "standard", "standard"),
    read_case(
        "free over nothing does not read",
        "eu",
        [rep(SV + "/free_over", money(0))],
        [("shipping_profiles[0]", "unreadable")],
        ["chilled", "letterbox"],
        ALL_R,
        None,
        "standard",
        "a profile reads or not as a whole, and no other is ever made the default: an offer naming none has no shipping known",
    ),
    read_case(
        "a window with no days",
        "eu",
        [rem("/return_policies/0/window_days")],
        [("return_policies[0]", "window_days_missing")],
        ALL_P,
        ["final_sale", "credit"],
        "standard",
        None,
        "an offer that names standard is then held (return_policy_unknown), never shown another policy",
    ),
    read_case("days beside unlimited: the days alone", "eu", [rep("/return_policies/2/eligibility", "unlimited")], [("return_policies[2].window_days", "window_days_unused")], ALL_P, ALL_R, "standard", "standard"),
    read_case("returns taken, by no method", "eu", [rep("/return_policies/2/methods", [])], [("return_policies[2]", "terms_missing")], ALL_P, ["standard", "final_sale"], "standard", "standard"),
    read_case("by post, no one pays the postage", "eu", [rem("/return_policies/0/return_postage")], [("return_policies[0]", "postage_missing")], ALL_P, ["final_sale", "credit"], "standard", None),
    read_case(
        "terms on no returns: dropped",
        "eu",
        [rep("/return_policies/1/resolutions", ["refund"]), add_("/return_policies/1/return_postage", "customer")],
        [("return_policies[1]", "not_accepted_terms")],
        ALL_P,
        ALL_R,
        "standard",
        "standard",
    ),
    read_case("a document of another version", "eu", [rep("/version", 2)], None, None, None, None, None, "it does not read at all (policies_document_unreadable)"),
    read_case(
        "a postcode prefix with a space",
        "eu",
        [rep("/shipping_profiles/0/zones/4/destinations/0/postal_prefixes/2", "WC2N  5")],
        [("shipping_profiles[0]", "unreadable")],
        ["chilled", "letterbox"],
        ALL_R,
        None,
        "standard",
        "at most one space, between the outward code and the inward",
    ),
]

# Shipping quotes: an independent implementation of quote_shipping.
NG = {"g": 10**9, "kg": 10**12, "oz": 28349523125, "lb": 453592370000}


OUTWARD_INWARD = ("GB", "IM", "JE", "GY")


def postcode_of(country, pc):
    p = re.sub(r"[\s-]", "", pc.upper())
    if country in OUTWARD_INWARD and re.fullmatch(r"[A-Z0-9]{2,4}[0-9][A-Z]{2}", p):
        return p[:-3] + " " + p[-3:]
    return p


def prefix_matches(country, pc, prefix):
    if country not in OUTWARD_INWARD:
        return pc.replace(" ", "").startswith(prefix.replace(" ", ""))
    if " " in prefix:
        return pc.startswith(prefix)
    outward = pc.split(" ")[0]
    if not outward.startswith(prefix):
        return False
    rest = outward[len(prefix):]
    return rest == "" or rest[0].isdigit() != prefix[-1].isdigit()


def place_in(dest, e):
    if dest["country"].upper() != e["country"]:
        return False
    if "regions" not in e and "postal_prefixes" not in e:
        return True
    region = (dest.get("region") or "").upper()
    if region and region in e.get("regions", []):
        return True
    pc = postcode_of(e["country"], dest.get("postal_code") or "")
    return pc != "" and any(prefix_matches(e["country"], pc, p) for p in e.get("postal_prefixes", []))


def amounts(rate):
    if rate["basis"] in ("flat", "per_item"):
        return [rate["amount"]]
    if rate["basis"] == "by_weight":
        return [b["amount"] for b in rate["bands"]]
    return [m for b in rate["bands"] for m in ([b["amount"], b["up_to"]] if b["up_to"] else [b["amount"]])]


def quote(doc, inp):
    defaults = [p["id"] for p in doc["shipping_profiles"] if p.get("default")]
    pid = inp.get("shipping_profile") or (defaults[0] if defaults else None)
    prof = next((p for p in doc["shipping_profiles"] if p["id"] == pid), None)
    if not prof:
        return {"profile": None, "zone": None, "services": [], "why": "no_profile"}
    dest = inp["destination"]
    zone = next(
        (z for z in prof["zones"] if any(place_in(dest, e) for e in z["destinations"]) and not any(place_in(dest, e) for e in z.get("excluded", []))),
        None,
    )
    if not zone:
        return {"profile": prof["id"], "zone": None, "services": [], "why": "not_shipped_there"}
    out = []
    for s in zone["services"]:
        base = {
            "id": s["id"],
            "name": s["name"],
            "carrier": s.get("carrier"),
            "tracked": s["tracked"],
            "id_check": s["id_check"],
            "transit_days": s["transit_days"],
        }
        cur = amounts(s["rate"])[0]["currency"]

        def no(why):
            return dict(base, fee=None, why=why)

        def fee(v):
            return dict(base, fee={"value": v, "currency": cur})

        lines = inp["lines"]
        if not s["id_check"] and any(l.get("age_restricted") for l in lines):
            out.append(no("id_check"))
            continue
        if any(l["price"]["currency"] != cur for l in lines):
            out.append(no("currency"))
            continue
        worth = sum(l["price"]["value"] * l["quantity"] for l in lines)
        units = sum(l["quantity"] for l in lines)
        band_fee = None
        if s["rate"]["basis"] == "by_weight":
            if any(not l.get("weight") for l in lines):
                out.append(no("weight_missing"))
                continue
            if any(l["weight"]["unit"] not in NG for l in lines):
                out.append(no("weight_unit"))
                continue
            total = sum(Fraction(jnum(l["weight"]["value"])) * NG[l["weight"]["unit"]] * l["quantity"] for l in lines)
            unit = NG[s["rate"]["unit"]]
            band = next((b for b in s["rate"]["bands"] if b["up_to"] is None or total <= Fraction(jnum(b["up_to"])) * unit), None)
            if band is None:
                out.append(no("too_heavy"))
                continue
            band_fee = band["amount"]["value"]
        if "free_over" in s and worth >= s["free_over"]["value"]:
            out.append(fee(0))
            continue
        b = s["rate"]["basis"]
        if b == "flat":
            out.append(fee(s["rate"]["amount"]["value"]))
        elif b == "per_item":
            out.append(fee(s["rate"]["amount"]["value"] * units))
        elif b == "by_weight":
            out.append(fee(band_fee))
        else:
            band = next((x for x in s["rate"]["bands"] if x["up_to"] is None or worth <= x["up_to"]["value"]), None)
            out.append(fee(band["amount"]["value"]) if band else no("over_bands"))
    return {"profile": prof["id"], "zone": zone["name"], "services": out}


def line(value, qty=1, weight=None, cur="EUR", age=False):
    l = {"price": {"value": value, "currency": cur}, "quantity": qty}
    if weight:
        l["weight"] = {"value": weight[0], "unit": weight[1]}
    if age:
        l["age_restricted"] = True
    return l


def q(name, doc_name, lines, dest, profile=None, check=None, note=None):
    inp = {"lines": lines, "destination": dest}
    if profile:
        inp["shipping_profile"] = profile
    got = quote(EU_DOC if doc_name == "eu" else US_DOC, inp)
    if check:
        check(got)
    c = {"name": name, "doc": doc_name, "input": inp, "expect": got}
    if note:
        c["note"] = note
    return c


def fees(*vals):
    def check(got):
        assert [s["fee"]["value"] if s["fee"] else s["why"] for s in got["services"]] == list(vals), got

    return check


LISBON = {"country": "PT", "postal_code": "1100-148"}
QUOTES = [
    q("one pot to Lisbon, 0.65 kg", "eu", [line(2990, 1, (0.65, "kg"))], LISBON, check=fees(450, 990)),
    q("two at 1.5 kg: 3 kg", "eu", [line(1990, 2, (1.5, "kg"))], LISBON, check=fees(750, 990)),
    q("40 kg: too heavy for the standard rate", "eu", [line(1990, 4, (10, "kg"))], LISBON, check=fees("too_heavy", 990)),
    q("goods worth 59.80: standard free over 50", "eu", [line(2990, 2, (0.65, "kg"))], LISBON, check=fees(0, 990)),
    q("a line with no weight", "eu", [line(2990, 1, (0.65, "kg")), line(500, 1)], LISBON, check=fees("weight_missing", 990)),
    q(
        "a line with no weight, and goods over 50: still no weight",
        "eu",
        [line(5990, 1)],
        LISBON,
        check=fees("weight_missing", 990),
        note="a weight rate must know it can carry the basket before free_over",
    ),
    q(
        "1,500 g and a pound: 1.95359237 kg, the first band",
        "eu",
        [line(1000, 1, (1500, "g")), line(1000, 1, (1, "lb"))],
        LISBON,
        check=fees(450, 990),
    ),
    q(
        "1,550 g and a pound: 2.00359237 kg, the second",
        "eu",
        [line(1000, 1, (1550, "g")), line(1000, 1, (1, "lb"))],
        LISBON,
        check=fees(750, 990),
    ),
    q("exactly 2 kg is the first band", "eu", [line(1000, 4, (0.5, "kg"))], LISBON, check=fees(450, 990)),
    q("the Azores, by region", "eu", [line(2990, 1, (0.65, "kg"))], {"country": "PT", "region": "PT-20"}, check=fees(1200)),
    q(
        "Portugal with no region: the first zone that has it",
        "eu",
        [line(2990, 1, (0.65, "kg"))],
        {"country": "PT"},
        check=fees(450, 990),
        note="a region it was not told matches no entry that names regions",
    ),
    q("Spain, goods 49.90", "eu", [line(4990, 1)], {"country": "ES"}, check=fees(1490)),
    q("Spain, goods 50.00: the top of the first band", "eu", [line(5000, 1)], {"country": "ES"}, check=fees(1490)),
    q("Spain, goods 50.10", "eu", [line(5010, 1)], {"country": "ES"}, check=fees(990)),
    q("Spain, goods 150.00: free", "eu", [line(5000, 3)], {"country": "ES"}, check=fees(0)),
    q("London, three items at 6.00 each", "eu", [line(1500, 2), line(800, 1)], {"country": "GB", "postal_code": "SW1A 1AA"}, check=fees(1800)),
    q("Belfast is excluded", "eu", [line(1500, 1)], {"country": "GB", "postal_code": "BT1 1AA"}),
    q("the United States: not shipped there", "eu", [line(1500, 1)], {"country": "US"}),
    q("a line in pounds sterling to Spain", "eu", [line(1500, 1, cur="GBP")], {"country": "ES"}, check=fees("currency")),
    q("chilled to Lisbon, by our van: free", "eu", [line(1290, 2)], LISBON, profile="chilled", check=fees(0)),
    q("chilled to Porto: not shipped there", "eu", [line(1290, 2)], {"country": "PT", "postal_code": "4000-001"}, profile="chilled"),
    q("a profile it does not have", "eu", [line(1290, 1)], LISBON, profile="overnight"),
    q("two 12 oz bags: 1.5 lb", "us", [line(1299, 2, (12, "oz"), "USD")], {"country": "US", "region": "US-CA"}, check=fees(899, 4900)),
    q("80 lb: the open band", "us", [line(9999, 4, (20, "lb"), "USD")], {"country": "US"}, check=fees(1499, 4900)),
    q("goods of 600 dollars: past freight's last band", "us", [line(30000, 2, (1, "lb"), "USD")], {"country": "US"}, check=fees(899, "over_bands")),
    q("Hawaii is excluded", "us", [line(1299, 1, (12, "oz"), "USD")], {"country": "US", "region": "US-HI"}),
    q(
        "a bottle of wine to Lisbon: only the service that checks ID",
        "eu",
        [line(1290, 1, (1.3, "kg"), age=True)],
        LISBON,
        check=fees("id_check", 990),
    ),
    q(
        "wine and a pot together: the basket goes as its wine must",
        "eu",
        [line(1290, 1, (1.3, "kg"), age=True), line(2990, 1, (0.65, "kg"))],
        LISBON,
        check=fees("id_check", 990),
    ),
    q("wine by the letterbox: no service may take it", "eu", [line(1290, 1, age=True)], LISBON, profile="letterbox", check=fees("id_check")),
    q("Perth, PH2 0AB: the mainland", "eu", [line(1500, 1)], {"country": "GB", "postal_code": "PH2 0AB"}, check=fees(600)),
    q("Newtonmore, PH20 1AA: the Highlands", "eu", [line(1500, 1)], {"country": "GB", "postal_code": "PH20 1AA"}, check=fees(1500)),
    q("Kilmarnock, KA2 7AA: the mainland", "eu", [line(1500, 1)], {"country": "GB", "postal_code": "KA2 7AA"}, check=fees(600)),
    q("Arran, KA27 8AA: the islands", "eu", [line(1500, 1)], {"country": "GB", "postal_code": "KA27 8AA"}, check=fees(1500)),
    q("Paisley, written pa20aa: the mainland", "eu", [line(1500, 1)], {"country": "GB", "postal_code": "pa20aa"}, check=fees(600), note="PA2 0AA, never PA20"),
    q("Dunoon, PA20 0AA: the Highlands", "eu", [line(1500, 1)], {"country": "GB", "postal_code": "PA20 0AA"}, check=fees(1500)),
    q("Inverness, IV1 1AA: a whole area", "eu", [line(1500, 1)], {"country": "GB", "postal_code": "IV1 1AA"}, check=fees(1500)),
    q("Clerkenwell, EC1A 1BB: EC1 has it", "eu", [line(1500, 1)], {"country": "GB", "postal_code": "EC1A 1BB"}, check=fees(1200)),
    q("North Kensington, W10 5AA: never W1", "eu", [line(1500, 1)], {"country": "GB", "postal_code": "W10 5AA"}, check=fees(600)),
    q("Trafalgar Square, WC2N 5DU: a prefix with a space", "eu", [line(1500, 1)], {"country": "GB", "postal_code": "WC2N 5DU"}, check=fees(1200)),
    q("Charing Cross, WC2N 6NE: not that prefix", "eu", [line(1500, 1)], {"country": "GB", "postal_code": "WC2N 6NE"}, check=fees(600)),
]
assert QUOTES[16]["expect"]["why"] == "not_shipped_there" and QUOTES[21]["expect"]["why"] == "no_profile"

# --- signatures ------------------------------------------------------------------------------------

CANON = []


def canon(name, value, note=None):
    c = {"name": name, "value": value, "canonical": canonical(value), "sha256": sha256(canonical(value))}
    if note:
        c["note"] = note
    CANON.append(c)


def canon_text(name, text, note=None):
    """A value given as the JSON text a body carries: numbers judged by their value, never their digits."""
    value = json.loads(text)
    c = {"name": name, "text": text, "canonical": canonical(value), "sha256": sha256(canonical(value))}
    if note:
        c["note"] = note
    CANON.append(c)


canon("members sorted by name", {"state": "listed", "id": "a", "Z": 1, "_": 2, "a": 3})
canon("nested, and arrays in their own order", {"b": [3, 1, 2], "a": {"y": None, "x": [{"k": 2, "j": 1}]}})
canon("null is written; true and false", {"description": None, "no_gtin": False, "is_bundle": True})
canon("integers, and up to three decimals", {"value": 4500, "neg": -1, "zero": 0, "w": 0.65, "m": 15.25, "x": 0.001, "big": 1000000})
canon("<, > and & as themselves", {"name": "Fish & chips <large>"}, "Go's encoding/json escapes these unless told not to")
canon("U+2028 and U+2029 as themselves", {"name": "line para end"}, "Go's encoding/json escapes these always")
canon("quotes, backslashes and control characters", {"s": 'a "b" \\ c\n\t\r\b\f\u0001\u001f\u007f'})
canon("non-ASCII as UTF-8", {"name": "Café moído, 250 g", "emoji": "\U0001F355", "jp": "抹茶"})
canon_text(
    "numbers as text: by value, never their digits",
    '{"w":2.50,"x":1.0,"y":1e3,"z":0.6500,"p":3490.0,"n":-0.0}',
    "2.50 is 2.5, 1.0 is 1, 1e3 is 1000, 0.6500 is 0.65, 3490.0 is 3490, -0.0 is 0: a reader that keeps a number's own text (Go's json.Number) is not canonical",
)
canon_text("escapes in the text are the characters", '{"name":"Caf\\u00e9 \\u003cb\\u003e"}', "written back as Café <b>, unescaped")
canon(
    "names compared as UTF-16 code units",
    {"ﬁ": 1, "\U0001F355": 2, "z": 3},
    "U+1F355 is D83C DF55 in UTF-16, below U+FB01; by code point it would come after",
)

HASHES = []


def h(name, it, note=None):
    c = {"name": name, "item": it, "hash": item_hash(it)}
    if note:
        c["note"] = note
    HASHES.append(c)


h("a variant, every field", item())
h("a member absent is not null", item(description=DROP, shipping_profile=DROP), "description absent, not null: another hash")
h("description null", item(description=None))
h("a member the reader does not know counts", item(colour_hex="#c0c0c0"), "taken over the item as it came")
h("a version 1 item", V1[0]["v1"])
assert HASHES[1]["hash"] != HASHES[2]["hash"]
_text = compact(item()).replace('"value":3490,', '"value":3490.0,').replace('"value":0.65,', '"value":0.6500,')
assert "3490.0" in _text and "0.6500" in _text
HASHES.append(
    {
        "name": "an item given as body text: 3490.0 and 0.6500 hash as 3490 and 0.65",
        "text": _text,
        "hash": item_hash(json.loads(_text)),
        "note": "parsed first, numbers by their value: the hash of a variant, every field",
    }
)
assert HASHES[-1]["hash"] == HASHES[0]["hash"]

page = {
    "version": 2,
    "domain": "inbox.loja.example",
    "as_of": AS_OF,
    "catalogue": {
        "count": 3,
        "updated_at": "2026-11-02T09:12:00.000Z",
        "tax_included": True,
        "rev": "3b0c51d0a7e4b8c3",
        "policies_rev": EU_DOC["rev"],
    },
    "items": [
        THREE[0],
        THREE[1],
        THREE[2],
        {"id": "MOKA-12-ALU", "state": "withdrawn", "updated_at": "2026-11-02T09:11:00.000Z"},
    ],
    "next_cursor": None,
}
ASKED_IDS = ["MOKA-6-ALU", "gid://shop/ProductVariant/4471", "O'NEILL-6", "A!(B)*"]


def ids_param(ids):
    """Each id percent-encoded but for RFC 3986's unreserved characters, hex in upper case, joined by a comma."""
    return ",".join(urllib.parse.quote(i, safe="-._~") for i in ids)


assert ids_param(ASKED_IDS) == "MOKA-6-ALU,gid%3A%2F%2Fshop%2FProductVariant%2F4471,O%27NEILL-6,A%21%28B%29%2A"
items_answer = {"version": 2, "items": [THREE[1]], "missing": ASKED_IDS[1:]}
policies_body = dict(EU_DOC, domain="inbox.loja.example")
api_page = dict(copy.deepcopy(page), domain="loja.example")


def signed(name, kind, url, body_obj, rev, domain="inbox.loja.example", ids=None, note=None):
    """A body signed as served. domain: the member's registered domain, which iss and a page's domain name."""
    body = compact(body_obj)
    payload = {"iss": domain, "url": url, "body_sha256": sha256(body), "as_of": AS_OF, "rev": rev}
    hj, pj, token = jws(HEADER, payload)
    c = {"name": name, "kind": kind, "domain": domain, "url": url}
    if ids is not None:
        c["ids"] = ids
    c.update({"body": body, "body_sha256": payload["body_sha256"], "header": HEADER, "header_json": hj, "payload": payload, "payload_json": pj, "jws": token})
    if note:
        c["note"] = note
    return c


PAGE_URL = "https://inbox.loja.example/v1/catalogue/changes?version=2&limit=500"
SIGNED = [
    signed("a version 2 page", "page", PAGE_URL, page, "3b0c51d0a7e4b8c3"),
    signed(
        "products by id, ids with ':', '/', \"'\" and '!()*' in them",
        "items",
        "https://inbox.loja.example/v1/catalogue/items?version=2&ids=" + ids_param(ASKED_IDS),
        items_answer,
        "3b0c51d0a7e4b8c3",
        ids=ASKED_IDS,
        note="as_of is when it answered and rev the catalogue's then: the answer's body carries neither",
    ),
    signed("the policies document", "policies", "https://inbox.loja.example/v1/catalogue/policies", policies_body, EU_DOC["rev"]),
    signed(
        "a feed on the business's API host",
        "page",
        "https://api.loja.example/v1/catalogue/changes?version=2&limit=500",
        api_page,
        "3b0c51d0a7e4b8c3",
        domain="loja.example",
        note="iss and the page's domain are the member's registered domain, the host of its /.well-known/agent-inbox.json, never the feed's host",
    ),
]
GOOD = SIGNED[0]


def refused(name, code, url=None, body=None, token=None, domain="inbox.loja.example", kind="page", note=None):
    c = {
        "name": name,
        "kind": kind,
        "domain": domain,
        "url": url or GOOD["url"],
        "body": body if body is not None else GOOD["body"],
        "jws": token or GOOD["jws"],
        "code": code,
    }
    if note:
        c["note"] = note
    return c


def resign(header=None, payload=None):
    return jws(header or HEADER, payload or GOOD["payload"])[2]


sig = GOOD["jws"].split(".")
flipped = sig[0] + "." + sig[1] + "." + b64u(bytes([unb64u(sig[2])[0] ^ 1]) + unb64u(sig[2])[1:])
REFUSED = [
    refused("the body changed in transit", "body_mismatch", body=GOOD["body"].replace('"count":3', '"count":4')),
    refused(
        "the body pretty-printed again",
        "body_mismatch",
        body=json.dumps(page, ensure_ascii=False, indent=2),
        note="body_sha256 is over the bytes as served, after any content-coding is removed, never a re-serialised copy",
    ),
    refused("another address asked", "url_mismatch", url="https://inbox.loja.example/v1/catalogue/changes?version=2&limit=500&after=MA"),
    refused("signed for another domain", "iss_mismatch", domain="inbox.other.example"),
    refused("a receipt's typ", "bad_typ", token=resign(header={"alg": "EdDSA", "typ": "sdi-receipt+jws", "kid": KID})),
    refused("another alg", "bad_alg", token=resign(header={"alg": "ES256", "typ": "sdi-catalogue+jws", "kid": KID})),
    refused("a key the manifest does not publish", "unknown_key", token=resign(header={"alg": "EdDSA", "typ": "sdi-catalogue+jws", "kid": "not-a-published-key"})),
    refused("one bit of the signature flipped", "bad_signature", token=flipped),
    refused(
        "a receipt's typ, and the body changed: bad_typ first",
        "bad_typ",
        body=GOOD["body"].replace('"count":3', '"count":4'),
        token=resign(header={"alg": "EdDSA", "typ": "sdi-receipt+jws", "kid": KID}),
    ),
    refused(
        "signed for another domain, and the body changed: iss_mismatch first",
        "iss_mismatch",
        domain="inbox.other.example",
        body=GOOD["body"].replace('"count":3', '"count":4'),
    ),
    refused(
        "another address asked, and the body changed: url_mismatch first",
        "url_mismatch",
        url="https://inbox.loja.example/v1/catalogue/changes?version=2&limit=500&after=MA",
        body=GOOD["body"].replace('"count":3', '"count":4'),
    ),
    refused("a page whose signed as_of is not its own", "as_of_mismatch", token=resign(payload=dict(GOOD["payload"], as_of="2026-11-02T09:00:00.000Z"))),
    refused("a page whose signed rev is not its own", "rev_mismatch", token=resign(payload=dict(GOOD["payload"], rev="ffffffffffffffff"))),
    refused(
        "a page signed as of another time and another rev: as_of_mismatch first",
        "as_of_mismatch",
        token=resign(payload=dict(GOOD["payload"], as_of="2026-11-02T09:00:00.000Z", rev="ffffffffffffffff")),
    ),
    refused(
        "a policies document whose signed rev is not its own",
        "rev_mismatch",
        kind="policies",
        url=SIGNED[2]["url"],
        body=SIGNED[2]["body"],
        token=jws(HEADER, dict(SIGNED[2]["payload"], rev="ffffffffffffffff"))[2],
    ),
    refused(
        "a feed on the API host, read as if the host were the member",
        "iss_mismatch",
        domain="api.loja.example",
        url=SIGNED[3]["url"],
        body=SIGNED[3]["body"],
        token=SIGNED[3]["jws"],
    ),
]

# --- write -----------------------------------------------------------------------------------------

policies_for_checks = EU_DOC

write(
    "catalogue-signature.json",
    {
        "$comment": "Catalogue version 2 (protocol §4.18): canonical JSON (RFC 8785) as an item's hash is taken over, each value (or the JSON text a body carries, parsed first: numbers by their value) with its canonical text and SHA-256; items (or an item's body text) and their hash; and Catalogue-Signature, a compact JWS (EdDSA, typ sdi-catalogue+jws) over {iss, url, body_sha256, as_of, rev}. Ed25519 is deterministic: signing payload_json under header_json with key.private_jwk reproduces jws byte for byte. The key is RFC 8037 A.1, as in receipts.json; rfc8037 is that RFC's own A.4 example, to check an Ed25519 implementation first. Each signature: its kind (page, items or policies), domain (the member's registered domain, which iss and a page's or document's domain name), the url asked and signed, byte for byte (ids: the ids products by id were asked for), and the body as served. refused: what a reader refuses, and the code: bad_alg, bad_typ, unknown_key, bad_signature, iss_mismatch, url_mismatch, body_mismatch, then for a page or the policies document as_of_mismatch and rev_mismatch, the first that applies in that order. Written by packages/spec/scripts/gen-catalogue-vectors.py (Python's standard library, its own Ed25519). MIT.",
        "key": {
            "kid": KID,
            "public_jwk": {"kty": "OKP", "crv": "Ed25519", "x": X_B64, "kid": KID},
            "private_jwk": {"kty": "OKP", "crv": "Ed25519", "x": X_B64, "d": D_B64},
        },
        "rfc8037": {"header_json": '{"alg":"EdDSA"}', "payload": "Example of Ed25519 signing", "jws": RFC_JWS},
        "canonical": CANON,
        "hashes": HASHES,
        "signatures": SIGNED,
        "refused": REFUSED,
    },
)
write(
    "catalogue-checks.json",
    {
        "$comment": "Catalogue version 2 (protocol §4.18): one item read alone (readCatalogueItemV2) at as_of, each with the reader's verdict: listed, with the problems that dropped a member and, when it is not the item as it came, the item as kept (members it does not know left out, a member that only adds and does not read left out or set to its none, option keys and an age's kind read through vocab/option-keys.json and vocab/age-kinds.json, fulfil_methods once each, the hash as it came); held, with every problem named and, for unreadable, path: a JSON Pointer to the first member that does not read, in the order the schema lists them; or withdrawn, and why. Problems and drops come each once, in the order CATALOGUE_V2_PROBLEMS lists them. with_policies: read with policies, the document a page's items name (catalogue-policies.json's first); without it, no profile or policy id is checked. site: the registrable domains of the business's own site, which url must be on. A character is a Unicode code point. Codes written by hand; hashes by packages/spec/scripts/gen-catalogue-vectors.py. MIT.",
        "as_of": AS_OF,
        "policies": policies_for_checks,
        "cases": CHECKS,
    },
)
write(
    "catalogue-prices.json",
    {
        "$comment": "Catalogue version 2 (protocol §4.18): price models (models, read as catalogue-checks.json reads, at as_of), unit prices (unitPriceOf: the amount per reference in the price's minor units, a half up, or the problem), and the 'was' price rule (wasPriceOf: the EU's rule, everywhere: below it now, and at or above it for the whole 30 days before the reduction began; history is every price recorded, each from at until the next). Codes written by hand; amounts and windows worked out by packages/spec/scripts/gen-catalogue-vectors.py with exact fractions. MIT.",
        "as_of": AS_OF,
        "models": MODELS,
        "unit_price": UNIT_PRICES,
        "was_price": WAS,
    },
)
write(
    "catalogue-options.json",
    {
        "$comment": "Catalogue version 2 (protocol §4.18): a business's product groups (readCatalogueGroups) from its listed items (or repeat: count copies of item, the i-th, from 0, with its id and its first option's value followed by i in three digits, and group.position i + 1), each read first as catalogue-checks.json reads one,: grouped, one product, its variants in order of position then id, at most 250, those past held; or ungrouped, each variant a product of its own, with the problems. Every variant names the same keys, each key by one name, under one title, and no two alike in every value, compared exactly. Written by hand; hashes by packages/spec/scripts/gen-catalogue-vectors.py. MIT.",
        "cases": GROUPS,
    },
)
write(
    "catalogue-v1.json",
    {
        "$comment": "Catalogue version 2 (protocol §4.18): the version 1 item a producer serves a reader of version 1 for each version 2 item (catalogueItemV1Of), at as_of; null: no version 1 item at all (an id over 64 characters). Version 1 says only what it can say truly, so an offer it cannot is withdrawn there, and nothing but as_of (against available_until, where the producer gives the item a new position) changes what it says: an offer with its own tax_included is withdrawn whatever the catalogue's. The description is cut to 1,000 characters, Unicode code points. Worked out, hashes included, by packages/spec/scripts/gen-catalogue-vectors.py's own implementation. MIT.",
        "as_of": AS_OF,
        "cases": V1,
    },
)
write(
    "catalogue-policies.json",
    {
        "$comment": "Catalogue version 2 (protocol §4.18): the policies document. reads: a document read part by part (readCataloguePolicies), given as one of documents with an RFC 6902 JSON Patch applied: the problems at their paths, the ids kept and the defaults; expect null when it does not read at all. quotes: a basket's shipping to a place (quoteShipping) under eu or us, the documents of the first two reads: the profile, the zone and each service's fee, or null with why. An age-restricted line goes only by a service marked id_check; a British postcode matches by outward code (PH2 is never PH20). Problems written by hand; the documents' rev and every fee worked out by packages/spec/scripts/gen-catalogue-vectors.py, weights exactly in nanograms. MIT.",
        "documents": {"eu": EU_DOC, "us": US_DOC},
        "reads": READS,
        "quotes": QUOTES,
    },
)
print(
    "signature: %d canonical, %d hashes, %d signed, %d refused; checks %d; prices %d models, %d unit, %d was; options %d; v1 %d; policies %d reads, %d quotes"
    % (len(CANON), len(HASHES), len(SIGNED), len(REFUSED), len(CHECKS), len(MODELS), len(UNIT_PRICES), len(WAS), len(GROUPS), len(V1), len(READS), len(QUOTES))
)
