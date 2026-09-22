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

## Rule 2 — an ACT import sets a real owner, or none

Clients imported from ACT! are per-manager there and stay per-manager here.
The importer's only job for scope is to map each ACT owner to a PathQuote
`User` and set `Company.ownerId` to it; region visibility then follows with no
extra field.

When an owner cannot be resolved, leave `ownerId` null. Such a company is
visible to admins only (`{ owner: { regionId } }` matches no row whose owner is
null) — which is the correct, visible, fixable state. Never:

- guess an owner (it silently files a client into the wrong region's view);
- fall back to the importing admin (same, plus it looks deliberate);
- add a `regionId` column to `Company` to avoid needing an owner (two sources
  of truth that drift, and the schema comment explains why the column was
  refused in the first place).

## Rule 3 — a regional manager needs a region

Both filters fail closed on a missing region (`{ regionId: "" }` /
`{ owner: { regionId: "" } }`), and `requireRegion` sends the user to
`/no-region`. So a regional manager without a region is not dangerous, just
useless. `scripts/create-user.ts` refuses to create one; the admin user form
does not, because an admin can see and fix the region on the same screen.
