#!/usr/bin/env python3
"""
Read-only diagnostic over the Act! database, answering the two questions the
first full dry run raised.

1. `no-name 713`. A contact with neither a first nor a last name is skipped by
   the mapper, and so is the company it would have created. If that contact is
   the only one carrying its company name, the company never reaches PathQuote
   at all -- which defeats the point of the sync. This counts how many are in
   that position, and prints examples so the records can be found in Act! and
   judged.

2. `industry values with no alias (7)`. Four of those seven are already in
   scripts/data/act-industries.json mapped to null, because they are not
   industries ("NIL", "Poor info"). The sync reports them anyway, which cries
   wolf. This separates genuinely unmapped spellings from deliberate nulls, with
   a contact count for each, so the mapping can be finished from real data
   rather than guessed.

Writes nothing. Reads every contact once, applying exactly the filters
src/lib/act/map.ts applies, so the counts here and the sync's agree.

Run it on the VPS -- the Act! API is IP-allowlisted to that address.

Usage:
    python3 scripts/act-diagnose.py
    python3 scripts/act-diagnose.py --examples 50
    python3 scripts/act-diagnose.py --csv /root/act-nonames.csv

Credentials come from the environment, same four as the sync:
    ACT_BASE=https://actapi.pathfindercut.com/act.web.api
    ACT_DB=Pathfinder
    ACT_USER='Marketing'
    ACT_PASS='...'
"""

import argparse
import base64
import collections
import csv
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

PAGE = 200

# Must match ACTIVE_STATUSES in src/lib/act/types.ts.
ACTIVE = {"Customer", "Prospect", "Prospect-Distributor", "Suspect"}

# Must match ACT_FIELD in src/lib/act/types.ts: Industry is a renamed stock
# user slot, not a field called "industry".
INDUSTRY_FIELD = "user6"

DATA_PATH = pathlib.Path(__file__).resolve().parent / "data" / "act-industries.json"


def env(name):
    value = os.environ.get(name)
    if not value:
        sys.exit(f"missing environment variable {name}")
    return value


def fold(value):
    """Trim, collapse runs of whitespace, lowercase.

    For industry values this is the Python twin of normalizeIndustryName in
    src/lib/validation/industries.ts, kept identical on purpose: a different
    fold here would report mappings the sync does not make.

    It is also good enough for comparing company names in this report. Note it
    is NOT the sync's company key -- that one also strips legal suffixes and
    appends the ISO country (src/lib/act/company-key.ts), so two spellings
    counted as one company here might be two in PathQuote. For "would this
    client be missing entirely" the looser fold is the conservative direction:
    it under-reports losses rather than inventing them.
    """
    return " ".join(value.split()).lower()


def text(value):
    """Trimmed string, or None. Mirrors map.ts's `text` helper, including that a
    non-string (the API sometimes sends a number) is not a name."""
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


class Act:
    def __init__(self, base, database, user, password):
        self.base = base.rstrip("/")
        self.database = database
        self.credentials = base64.b64encode(f"{user}:{password}".encode()).decode()
        self.token = None

    def authorize(self):
        request = urllib.request.Request(f"{self.base}/authorize")
        request.add_header("Authorization", f"Basic {self.credentials}")
        request.add_header("Act-Database-Name", self.database)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                self.token = response.read().decode().strip().strip('"')
        except urllib.error.HTTPError as error:
            sys.exit(
                f"authorize failed ({error.code}). ACT_USER must be the Act! display "
                f"name as Manage Users shows it, not a login, and the account needs "
                f"the 'Web API Access' permission."
            )

    def get(self, path):
        """GET with one re-authorisation if the token was rejected mid-run --
        the same single retry src/lib/act/client.ts does."""
        for attempt in range(2):
            if not self.token:
                self.authorize()
            request = urllib.request.Request(self.base + path)
            request.add_header("Authorization", f"Bearer {self.token}")
            request.add_header("Act-Database-Name", self.database)
            try:
                with urllib.request.urlopen(request, timeout=120) as response:
                    return json.loads(response.read().decode())
            except urllib.error.HTTPError as error:
                if error.code == 401 and attempt == 0:
                    self.token = None
                    continue
                sys.exit(f"GET {path} failed ({error.code})")
        return None

    def contacts(self):
        """Every contact, oldest edit first, a page at a time."""
        skip = 0
        while True:
            payload = self.get(
                f"/api/contacts?$top={PAGE}&$skip={skip}&$orderby=edited"
            )
            rows = payload["value"] if isinstance(payload, dict) else payload
            if not rows:
                return
            yield from rows
            if len(rows) < PAGE:
                return
            skip += PAGE


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--examples", type=int, default=25,
                        help="how many no-name contacts to print (default 25)")
    parser.add_argument("--csv", help="write every no-name contact to this file")
    args = parser.parse_args()

    aliases = json.loads(DATA_PATH.read_text())
    known = {fold(a): v for a, v in aliases["aliases"].items()}
    for name in aliases["canonical"]:
        known[fold(name)] = name

    act = Act(env("ACT_BASE"), env("ACT_DB"), env("ACT_USER"), env("ACT_PASS"))

    scanned = 0
    eligible = 0            # passes type, private and status -- before the name test
    named = 0
    nonames = []
    industries = collections.Counter()
    # Company names carried by contacts that WILL be imported, folded the same
    # way for comparison. A no-name contact whose company is in here is not a
    # loss: some other contact brings that company in.
    company_names_with_a_named_contact = set()

    for contact in act.contacts():
        scanned += 1
        if scanned % 2000 == 0:
            print(f"  {scanned} scanned", file=sys.stderr)

        if text(contact.get("contactType")) != "Contact":
            continue
        if contact.get("isPrivate") is True:
            continue
        status = text(contact.get("idStatus"))
        if status == "Personal" or not status or status not in ACTIVE:
            continue

        eligible += 1

        raw_industry = text((contact.get("customFields") or {}).get(INDUSTRY_FIELD))
        if raw_industry:
            industries[raw_industry] += 1

        company = text(contact.get("company"))
        first = text(contact.get("firstName"))
        last = text(contact.get("lastName"))

        if first or last:
            named += 1
            if company:
                company_names_with_a_named_contact.add(fold(company))
            continue

        address = contact.get("businessAddress") or {}
        nonames.append({
            "id": contact.get("id"),
            "company": company or "",
            "email": text(contact.get("emailAddress")) or "",
            "businessPhone": text(contact.get("businessPhone")) or "",
            "mobilePhone": text(contact.get("mobilePhone")) or "",
            "jobTitle": text(contact.get("jobTitle")) or "",
            "idStatus": status,
            "recordManager": text(contact.get("recordManager")) or "",
            "country": text(address.get("country")) or "",
            "edited": contact.get("edited") or "",
        })

    # --- report ---------------------------------------------------------

    print()
    print(f"scanned                        {scanned}")
    print(f"pass type/private/status       {eligible}")
    print(f"  of those, have a name        {named}")
    print(f"  of those, no name at all     {len(nonames)}")

    with_email = sum(1 for c in nonames if c["email"])
    with_phone = sum(1 for c in nonames if c["businessPhone"] or c["mobilePhone"])
    with_company = sum(1 for c in nonames if c["company"])
    with_nothing = sum(
        1 for c in nonames
        if not c["email"] and not c["businessPhone"] and not c["mobilePhone"]
    )
    no_company = sum(1 for c in nonames if not c["company"])

    # The number that decides whether this matters: a company whose only
    # contact has no name is a client PathQuote will not have at all.
    lost_companies = {
        fold(c["company"])
        for c in nonames
        if c["company"]
        and fold(c["company"]) not in company_names_with_a_named_contact
    }

    print()
    print("NO NAME -- what those records actually carry")
    print(f"  with an email                {with_email}")
    print(f"  with a phone                 {with_phone}")
    print(f"  with a company name          {with_company}")
    print(f"  with no company name         {no_company}")
    print(f"  with neither email nor phone {with_nothing}")
    print()
    print(f"  companies that reach PathQuote ONLY through a no-name contact:")
    print(f"    {len(lost_companies)}")
    print("    These are clients the sync will not create at all. Every other")
    print("    no-name contact belongs to a company some named contact brings in.")

    if nonames:
        print()
        print(f"EXAMPLES (first {min(args.examples, len(nonames))} of {len(nonames)})")
        print("  Search Act! by the company name, or by Contact ID.")
        print()
        for c in nonames[: args.examples]:
            lost = "" if fold(c["company"]) in company_names_with_a_named_contact else "  [sole contact]"
            print(f"  {c['id']}")
            print(f"    company   {c['company'] or '(none)'}{lost}")
            print(f"    email     {c['email'] or '-'}")
            print(f"    phone     {c['businessPhone'] or c['mobilePhone'] or '-'}")
            print(f"    title     {c['jobTitle'] or '-'}")
            print(f"    status    {c['idStatus']}   manager {c['recordManager'] or '-'}")

    if args.csv:
        with open(args.csv, "w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(nonames[0].keys()) if nonames else ["id"])
            writer.writeheader()
            writer.writerows(nonames)
        print()
        print(f"  all {len(nonames)} written to {args.csv}")

    # --- industries -----------------------------------------------------

    unmapped = collections.Counter()
    deliberate_null = collections.Counter()
    resolved = collections.Counter()
    for raw, count in industries.items():
        key = fold(raw)
        if key not in known:
            unmapped[raw] = count
        elif known[key] is None:
            deliberate_null[raw] = count
        else:
            resolved[raw] = count

    print()
    print("INDUSTRY VALUES on contacts that pass type/private/status")
    print(f"  distinct spellings           {len(industries)}")
    print(f"  resolve to a segment         {len(resolved)} spellings, "
          f"{sum(resolved.values())} contacts")
    print(f"  deliberate nulls in the table {len(deliberate_null)} spellings, "
          f"{sum(deliberate_null.values())} contacts")
    print(f"  NOT in the table             {len(unmapped)} spellings, "
          f"{sum(unmapped.values())} contacts")

    if unmapped:
        print()
        print("  Needs a decision -- each of these leaves a company's industry unset:")
        for raw, count in unmapped.most_common():
            print(f"    {count:5d}  {raw!r}")

    if deliberate_null:
        print()
        print("  Already known not to be industries, no action needed:")
        for raw, count in deliberate_null.most_common():
            print(f"    {count:5d}  {raw!r}")


if __name__ == "__main__":
    main()
