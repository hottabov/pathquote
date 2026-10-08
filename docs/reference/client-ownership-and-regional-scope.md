# Client ownership and regional scope

`REGIONAL_MANAGER` (added 2026-09-22) sees its region's rows. The two filters
live in `src/lib/scope.ts` and answer "which region" differently, on purpose:

| Model | Filter | Why |
| --- | --- | --- |
| `Document` | `{ regionId }` | The column is frozen at creation from the author's own region (`createDraft`). A quote stays with the region whose currency, tax and discount caps priced it, even after its author moves. It is also the indexed column. |
| `Company` | `{ owner: { regionId } }` | `Company` has no region and must not get one (see the comment on `model Company`). A client belongs to the manager who looks after them — an Australian manager sells into Europe and that buyer is still their client, quoted out of Australia. |

## Rule 1 — a departing manager keeps their region

When someone leaves, deactivate the account (`setUserActive`) and, if their
clients should change hands, reassign them (`reassignUserCompanies`). **Do not
blank their `regionId`.** Their clients' visibility to their own regional
manager is computed through that column: clear it and every client still owned
by the leaver disappears from the regional manager's list while looking
perfectly correct to an admin. Their quotes are unaffected — `Document.regionId`
is the quote's own column — which makes the failure partial and therefore harder
to spot.

Reassignment within a region changes nothing anyone sees. Reassignment across
regions moves the clients to the other region's view, immediately and with no
second column to keep in step. That is the payoff for deriving the region
instead of copying it.

## Rule 2 — an ACT! import sets no owner, and a country grant is what reveals it

This rule said the opposite until 2026-10-08: that the importer should map each
ACT! record manager to a PathQuote `User` and set `Company.ownerId`. That was
refused once the data was measured, and the reasoning is worth keeping.

A PathQuote company is usually *derived* from the free-text company name on an
ACT! contact — only about 2.5% of contacts link to a real ACT! Company record.
So one PathQuote company can stand behind several ACT! contacts, under several
different record managers. `Company.actRecordManagerId` records whichever
contact the sync processed last and says so in its own schema comment. Choosing
an owner from it would be picking arbitrarily, and the column would then read as
fact. Never:

- guess an owner (it silently files a client into the wrong region's view);
- fall back to the importing admin (same, plus it looks deliberate);
- add a `regionId` column to `Company` to avoid needing an owner (two sources of
  truth that drift, and the schema comment explains why the column was refused).

So imported companies have no owner, and ownership alone would make the whole
import admin-only. Visibility comes from a **country grant** instead:
`User.visibleCountries`, matched against `Company.country`.

| Grant | Means |
| --- | --- |
| `[]` (the default) | no country grant — ownership alone, i.e. today's rule |
| `["US", "CA"]` | plus every company in those countries |
| `["*"]` | plus every company, whatever its country |

An empty grant deliberately does **not** mean "all": the column defaults to `[]`,
so that reading would hand every new user the entire client base on the day the
migration ran. A company whose `country` is null, or still holds pre-ISO free
text, matches no grant and stays owner-and-admin-only — it hides a row rather
than leaking one.

**An admin sets a grant in the web interface:** Settings, Users, the user, then
the **Contacts visibility** card (below Catalogue visibility). It lists every
country that has clients with how many, plus any country the user was already
granted even if it has none yet (shown with a count of 0, so a save cannot
silently erase it). "Show clients from all countries" stores `["*"]`. The card
is not offered for an ADMIN or DEVELOPER, who see every client by role.

That card sits directly under Catalogue visibility and **works the same way**: a
tick *shows* (the catalogue card used to be the other way round and was
inverted to match; its stored rows are still a deny-list). A
live sentence restates what the current selection does ("This manager will see
the 4,432 clients in 2 countries, plus any they own"). Nothing ticked is a
warning, not a neutral state: the user then sees only the clients they own, and
an imported client is owned by nobody. A REGIONAL_MANAGER keeps its region arm
(Rule 1) in addition to whatever is ticked.

The operator path, for fixing a grant without a browser, is
`npm run user:countries -- <email> <US,CA | '*' | none>`. Both paths validate
through `resolveCountryCodes` in `src/lib/country-grant.ts`, so they accept and
refuse the same input.

A session picks up a change within `REVALIDATE_INTERVAL_MS` or at next sign-in,
and fails closed until it does.

The editor's per-country counts count a company only when its stored `country`
is exactly that ISO code, because `country IN (...)` is an exact match. A company
whose country is null, blank or free text ("United States", "usa") is reported in
a separate note as unreachable by any grant, not folded into a country's number.

## Rule 2a — a grant widens reading and editing, never deleting

`src/lib/scope.ts` has three helpers now, not two:

| Helper | Scopes | Grant applies |
| --- | --- | --- |
| `companyWhereForUser` | reads and edits | yes |
| `companyOwnedWhereForUser` | `deleteCompany`, `deleteContact` | no |
| `documentWhereForUser` | quotes | not applicable |

These filters are the app's write boundary as well as its read boundary, so
widening one widens editing through it. That is wanted for editing — somebody has
to be able to fix an imported client's address, and no manager owns one — and not
wanted for deleting. Correcting an address is a daily act; deleting a client is
rare and irreversible, and `Document.company` is `onDelete: Restrict`, so the
companies actually at risk are the quote-less ones, which is most of a fresh
import.

Hence the split. If you find yourself "fixing" the inconsistency by pointing a
delete at `companyWhereForUser`, this is the rule you are removing.

## Rule 3 — a regional manager needs a region

Both filters fail closed on a missing region (`{ regionId: "" }` /
`{ owner: { regionId: "" } }`), and `requireRegion` sends the user to
`/no-region`. So a regional manager without a region is not dangerous, just
useless. `scripts/create-user.ts` refuses to create one; the admin user form
does not, because an admin can see and fix the region on the same screen.
