#!/usr/bin/env python3
"""
Correct the country spellings in Act! that PathQuote cannot resolve.

Why this matters more than tidiness: `Company.country` decides which manager
sees a client (`companyWhereForUser`, src/lib/scope.ts). A country PathQuote
cannot resolve to an ISO code is a client no country grant reveals — it sits
owner-and-admin-only with nothing on screen to explain why.

Measured on the 2026-10-08 rehearsal import: 35 distinct spellings failed across
271 contacts. Most were colloquial names the official ISO list spells out in
full ("China" against "People's Republic of China"), and those are now handled
in src/lib/countries.ts, because they are real names and will arrive again from
any source. What is left here is the part that is simply wrong in Act!, and
belongs fixed in Act! — translating a typo in PathQuote would carry it forever
while hiding it from the one person who can correct it. Same reasoning as
scripts/act-fix-country-usa.py, which this follows.

Three groups, deliberately separate:

  TYPOS         misspellings of a real country. Safe, applied by --apply.
  CITIES        a city or province in the country field. The country is not in
                doubt, but replacing the value would destroy the only location
                the record has if `city` is empty — so the city is moved into
                `city` in that case, rather than discarded. Applied by --apply.
  UNRESOLVED    regions ("North America"), continents ("Africa"), ambiguous
                truncations ("United", "P.R.") and cities that name more than
                one country ("Arad"). Printed with the full address so a person
                can decide. Never written by this script.

A blank country is counted and listed but not guessable, so it is left alone
too. There were 111 of those.

Addresses are nested objects, and a partial write to one risks blanking its
siblings, so every record is read in full, only the address fields change, and
the whole object goes back. PATCH also rejects a body without `id` -- 400 with
an empty response -- so `id` is always included.

Run this BEFORE the production import. Every write bumps `edited`, which is the
delta cursor, so doing it afterwards makes the next sync re-pull each record for
nothing. Writes also replicate to the managers' laptops, so out of hours is
kinder.

Usage:
    python3 scripts/act-fix-country-spellings.py                 # dry run
    python3 scripts/act-fix-country-spellings.py --apply         # writes
    python3 scripts/act-fix-country-spellings.py --csv out.csv

Credentials come from the environment, the same four as the sync:
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
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

PAGE = 200

# Address objects on each entity whose `country` this script inspects. Mirrors
# scripts/act-fix-country-usa.py.
CONTACT_ADDRESSES = ("businessAddress", "homeAddress")
COMPANY_ADDRESSES = ("address", "billingAddress", "shippingAddress")

# Misspellings of a real country. Keys are squashed (lowercase, alphanumeric
# only) so "Trinidad and Tabago" and "trinidad & tabago" both match. Values are
# names src/lib/countries.ts resolves -- verified, because fixing the data into
# a spelling PathQuote still cannot read would be worse than leaving it.
TYPOS = {
    "udsa": "United States",
    "yusa": "United States",
    "srulanka": "Sri Lanka",
    "lativa": "Latvia",
    "marocco": "Morocco",
    "unittedkingdom": "United Kingdom",
    "unitedkingsom": "United Kingdom",
    "trinidadandtabago": "Trinidad and Tobago",
    # A city appended to the country, so the country alone is what is wanted.
    "guatemalaguatemala": "Guatemala",
}

# A city or province sitting in the country field, where the country it belongs
# to is not in doubt. The second element is written into `city` when `city` is
# empty, so the location is moved rather than lost.
CITIES = {
    "launceston": ("Australia", "Launceston"),
    "istanbul": ("Turkey", "Istanbul"),
    "quebec": ("Canada", "Québec"),
}

# Known values this script refuses to decide. Listed with their full address in
# the report so a person can fix them in Act!.
#   - a region or continent covers many countries
#   - "United" is a truncation of either of the two commonest values in this
#     very data, and "P.R." could be Puerto Rico or P.R. China
#   - "Arad" is a city in both Romania and Israel
UNRESOLVED = {"northamerica", "westindies", "africa", "united", "pr", "arad"}


def squash(value):
    """Fold a country string for comparison: lowercase, no accents, alphanumeric
    only.

    Accents have to go, and not only for tidiness: `str.isalnum()` is true for
    "é", so without decomposing first, "Québec" folds to "québec" and never
    matches a key written "quebec". That was a real miss on this very data.
    """
    decomposed = unicodedata.normalize("NFKD", value or "")
    without_accents = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return "".join(ch for ch in without_accents.lower() if ch.isalnum())


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
    """What this record needs, as a list of dicts.

    Each entry is one address field: `kind` is "typo", "city", "unresolved" or
    "blank"; `patch` is the key/value pairs to merge into that address object,
    and is empty for anything this script will not write.
    """
    out = []
    for field in address_fields:
        address = record.get(field)
        if not isinstance(address, dict):
            continue
        raw = address.get("country")
        key = squash(raw)

        if not key:
            # Only report a blank country on an address that has something else
            # in it; an entirely empty address block is not a data problem.
            if any(address.get(k) for k in ("line1", "city", "state", "postalCode")):
                out.append({"field": field, "kind": "blank", "old": raw, "patch": {}})
            continue

        if key in TYPOS:
            out.append(
                {"field": field, "kind": "typo", "old": raw, "patch": {"country": TYPOS[key]}}
            )
        elif key in CITIES:
            country, city = CITIES[key]
            patch = {"country": country}
            # Moving, not discarding: without this the only location the record
            # carries would be overwritten.
            if not (address.get("city") or "").strip():
                patch["city"] = city
            out.append({"field": field, "kind": "city", "old": raw, "patch": patch})
        elif key in UNRESOLVED:
            out.append({"field": field, "kind": "unresolved", "old": raw, "patch": {}})
    return out


def describe(address):
    """The address on one line, so an unresolved value can be judged in context."""
    parts = [address.get(k) for k in ("line1", "city", "state", "postalCode")]
    return ", ".join(p for p in parts if p) or "(no other address)"


def sweep(act, collection, address_fields, label_of, apply_changes, writer, counts, report):
    scanned = 0
    for record in act.page(collection):
        scanned += 1
        entries = plan(record, address_fields)
        if not entries:
            continue

        label = label_of(record)
        body = dict(record)
        write_needed = False

        for entry in entries:
            counts[entry["kind"]] += 1
            field, kind, old = entry["field"], entry["kind"], entry["old"]

            if entry["patch"]:
                shown = ", ".join(f"{k}={v!r}" for k, v in entry["patch"].items())
                report[kind].append(f"  {label}\n      {field}.country {old!r} -> {shown}")
                body[field] = dict(record[field], **entry["patch"])
                write_needed = True
                if writer:
                    writer.writerow(
                        [collection, record["id"], label, kind, field, old,
                         entry["patch"].get("country", ""), entry["patch"].get("city", "")]
                    )
            else:
                where = describe(record[field])
                shown = repr(old) if old else "(blank)"
                report[kind].append(f"  {label}\n      {field}.country {shown}   address: {where}")
                if writer:
                    writer.writerow([collection, record["id"], label, kind, field, old, "", ""])

        if write_needed and apply_changes:
            act.patch(collection, body)

    return scanned


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write the typo and city fixes")
    parser.add_argument("--csv", help="also record every finding to this file")
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
        writer.writerow(
            ["entity", "id", "label", "kind", "field", "old", "new_country", "new_city"]
        )

    if not args.apply:
        print("DRY RUN -- nothing is written. Add --apply when the lists look right.\n")

    counts = {"typo": 0, "city": 0, "unresolved": 0, "blank": 0}
    report = {"typo": [], "city": [], "unresolved": [], "blank": []}

    scanned = sweep(
        act, "contacts", CONTACT_ADDRESSES,
        lambda r: (r.get("fullName") or "?") + "  /  " + (r.get("company") or "-"),
        args.apply, writer, counts, report,
    )
    scanned_companies = sweep(
        act, "companies", COMPANY_ADDRESSES,
        lambda r: r.get("name") or "?",
        args.apply, writer, counts, report,
    )

    def section(kind, title, note):
        print(f"{title}: {counts[kind]}")
        print(f"  {note}")
        if report[kind]:
            print()
            for line in report[kind]:
                print(line)
        print()

    print(f"scanned {scanned} contacts and {scanned_companies} companies\n")

    section("typo", "TYPOS", "Misspellings of a real country. --apply corrects these.")
    section(
        "city",
        "CITY IN THE COUNTRY FIELD",
        "The country is not in doubt. --apply sets it, and moves the city into "
        "`city` when `city` is empty so the location is not lost.",
    )
    section(
        "unresolved",
        "NEEDS A PERSON",
        "A region, a continent, an ambiguous truncation, or a city in more than "
        "one country. Never written by this script -- fix these in Act!, using "
        "the address shown to decide.",
    )
    section(
        "blank",
        "NO COUNTRY AT ALL",
        "An address with a street or a city but no country. Nothing to correct "
        "from, and a country cannot be invented -- but until one is set, no "
        "country grant in PathQuote reveals this client.",
    )

    if handle:
        handle.close()
        print(f"every finding written to {args.csv}")

    writable = counts["typo"] + counts["city"]
    if not args.apply and writable:
        print(f"Re-run with --apply to write the {writable} fixes above.")
    elif args.apply:
        print(f"wrote {writable} fixes.")


if __name__ == "__main__":
    sys.exit(main())
