#!/usr/bin/env python3
"""
Normalise United States country spellings in the Act! database.

John asked for `USA` to become `United States`, which is the spelling the rest
of the database already uses: 8,119 contacts against 23. The same pass also
catches `US`, `U.S.A.` and the lowercase `united states`, because leaving three
of the four variants behind would mean doing this again.

Scope, measured on the 2026-08-19 export: roughly 29 contacts, 10 home
addresses, and 40 of the 125 company records. Small enough to watch go past.

Addresses are nested objects in the API, and a partial write to one risks
blanking the siblings, so every record is read in full, the country field
alone is changed, and the whole object is written back. PATCH also silently
rejects a body without `id` -- 400 with an empty response -- so `id` is always
included.

Run this BEFORE the first full sync into PathQuote. Every write bumps the
record's `edited` timestamp, which is the delta cursor; doing it afterwards
would make the next sync re-pull all eighty for no reason. Writes also
replicate to the managers' laptops, so out of hours is kinder.

Usage:
    python3 act-fix-country-usa.py                 # dry run, changes nothing
    python3 act-fix-country-usa.py --apply         # writes
    python3 act-fix-country-usa.py --apply --csv out.csv

Credentials come from the environment:
    ACT_BASE=https://actapi.pathfindercut.com/act.web.api
    ACT_DB=Pathfinder
    ACT_USER='Marketing'
    ACT_PASS='...'
"""

import argparse
import base64
import csv
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

CANONICAL = "United States"

# Spellings replaced by CANONICAL. Compared case-insensitively with
# punctuation and spaces removed, so "U.S.A." and "u s a" both match.
VARIANTS = {"usa", "us", "usofa", "unitedstatesofamerica", "unitedstates"}

# Address objects on each entity whose "country" is normalised.
CONTACT_ADDRESSES = ("businessAddress", "homeAddress")
COMPANY_ADDRESSES = ("address", "billingAddress", "shippingAddress")

PAGE = 200


def squash(value):
    """Fold a country string for comparison: lowercase, no punctuation or space."""
    return "".join(ch for ch in (value or "").lower() if ch.isalnum())


def needs_fix(value):
    """True when the value is a US spelling other than the canonical one."""
    if not value or value == CANONICAL:
        return False
    return squash(value) in VARIANTS


class Act:
    def __init__(self, base, database, user, password):
        self.base = base.rstrip("/")
        self.database = database
        creds = base64.b64encode(f"{user}:{password}".encode()).decode()
        self.token = self._request(
            "GET", "/authorize", headers={"Authorization": f"Basic {creds}"}, raw=True
        ).strip('"')

    def _request(self, method, path, body=None, headers=None, raw=False):
        url = self.base + path
        data = json.dumps(body).encode() if body is not None else None
        head = {"Act-Database-Name": self.database, "Content-Type": "application/json"}
        if headers:
            head.update(headers)
        else:
            head["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(url, data=data, headers=head, method=method)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                text = resp.read().decode()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode() or "(empty body)"
            raise SystemExit(f"{method} {path} -> HTTP {exc.code}\n{detail}") from None
        if raw:
            return text
        return json.loads(text) if text else None

    def page(self, collection):
        """Yield every record in a collection, a page at a time."""
        skip = 0
        while True:
            query = urllib.parse.urlencode({"$top": PAGE, "$skip": skip})
            payload = self._request("GET", f"/api/{collection}?{query}")
            rows = payload.get("value", payload) if isinstance(payload, dict) else payload
            if not rows:
                return
            yield from rows
            if len(rows) < PAGE:
                return
            skip += PAGE

    def patch(self, collection, record):
        return self._request("PATCH", f"/api/{collection}/{record['id']}", body=record)


def plan(record, address_fields):
    """Return the country changes this record needs, as (field, old, new)."""
    changes = []
    for field in address_fields:
        address = record.get(field)
        if isinstance(address, dict) and needs_fix(address.get("country")):
            changes.append((field, address["country"], CANONICAL))
    return changes


def sweep(act, collection, address_fields, label_of, apply_changes, writer):
    scanned = changed = 0
    for record in act.page(collection):
        scanned += 1
        changes = plan(record, address_fields)
        if not changes:
            continue
        changed += 1
        label = label_of(record)
        for field, old, new in changes:
            print(f"  {label}  {field}: {old!r} -> {new!r}")
            if writer:
                writer.writerow([collection, record["id"], label, field, old, new])
        if apply_changes:
            body = dict(record)
            for field, _, _ in changes:
                body[field] = dict(record[field], country=CANONICAL)
            act.patch(collection, body)
    return scanned, changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write the changes")
    parser.add_argument("--csv", help="also record every change to this file")
    args = parser.parse_args()

    missing = [k for k in ("ACT_BASE", "ACT_DB", "ACT_USER", "ACT_PASS") if not os.environ.get(k)]
    if missing:
        raise SystemExit("missing environment: " + ", ".join(missing))

    act = Act(
        os.environ["ACT_BASE"],
        os.environ["ACT_DB"],
        os.environ["ACT_USER"],
        os.environ["ACT_PASS"],
    )

    handle = open(args.csv, "w", newline="") if args.csv else None
    writer = csv.writer(handle) if handle else None
    if writer:
        writer.writerow(["entity", "id", "label", "field", "old", "new"])

    if not args.apply:
        print("DRY RUN -- nothing is written. Add --apply when the list looks right.\n")

    print("contacts")
    c_scanned, c_changed = sweep(
        act, "contacts", CONTACT_ADDRESSES,
        lambda r: (r.get("fullName") or "?") + " / " + (r.get("company") or "-"),
        args.apply, writer,
    )
    print(f"  {c_changed} of {c_scanned} need changing\n")

    print("companies")
    co_scanned, co_changed = sweep(
        act, "companies", COMPANY_ADDRESSES,
        lambda r: r.get("name") or "?",
        args.apply, writer,
    )
    print(f"  {co_changed} of {co_scanned} need changing\n")

    if handle:
        handle.close()
        print(f"written to {args.csv}")

    if not args.apply and (c_changed or co_changed):
        print("Re-run with --apply to write these changes.")


if __name__ == "__main__":
    sys.exit(main())
