# Phase 2a: who sees an imported client, and how they find one

**Status:** design, not ready to implement. Three decisions below need answers, and one of them needs data nobody has extracted yet.

**Why now:** phase 1 put ~11,600 contacts and several thousand companies into PathQuote. Both problems here are consequences of that, measured on the real data rather than anticipated.

---

## The two problems

They look separate and are not.

### 1. A manager sees none of it

`companyWhereForUser` (`src/lib/scope.ts:67`) scopes a plain `MANAGER` to `{ ownerId: user.id }`. The sync sets no `Company.ownerId` — the column is nullable and nothing writes it. So every imported company is invisible to every manager, and visible only to an `ADMIN`, whose filter is `{}`.

`REGIONAL_MANAGER` is `{ owner: { regionId } }`, which has the same problem for the same reason.

Phase 1 imported `Contact.actAccountMgr`, `User.actUserId`, `User.actAccountMgr` and `User.visibleCountries` precisely so this could be switched on without a re-import. Nothing reads any of them yet.

### 2. The client picker preloads everything

`listClientPickerCompanies` (`src/lib/queries/documents-pickers.ts:44`) loads every visible company with every one of its contacts, and the picker filters in the browser. Its own comment says why:

> preloaded whole so the picker itself filters in the browser rather than round-tripping per keystroke … companies are a small enough list per manager that a client-side filter beats a per-keystroke server round trip

That assumption held when the table had two rows. It does not now.

Note what is *not* slow: filtering 12,000 strings in JS on each keystroke is a few milliseconds and nobody will notice. The cost is the initial load of the builder page, paid on every open:

| | |
|---|---|
| ~12,000 companies × ~130 B JSON | ~1.5 MB |
| ~11,600 contacts × ~110 B JSON | ~1.3 MB |
| total in the RSC payload | ~2.5–3 MB, ~700 KB gzipped |

Plus two Postgres queries (Prisma splits `include` into companies, then contacts via `companyId IN (…)` with twelve thousand ids) and an in-memory sort, because `Company` has no index on `name` — only `industryId` and the phase-1 ACT! columns.

The SQL is tens of milliseconds. The serialisation, transfer and browser parse are the half-second to several seconds.

**These are one problem.** Fixing visibility shrinks the list: a US manager scoped to US companies sees a few thousand, not twelve, and the existing preload might survive that. An admin still sees everything, so server-side search is needed regardless — but how urgently depends on the visibility rule.

### 2b. A side effect worth catching here

The picker auto-selects a company's contact as `contacts[0]`, relying on the ordering `isPrimary desc, firstName asc` to put the primary first (`src/components/builder/client-section.tsx:144`). The sync sets no `isPrimary`, so for an imported company the ordering falls through to `firstName asc` and the auto-selected contact is whoever is alphabetically first. Not wrong, but arbitrary, and it will look like a bug to whoever hits it.

---

## Decisions needed

### D1. What makes an imported company visible to a manager?

The design spec says Account Mgr plus Country. Four shapes:

**(a) Backfill `Company.ownerId`.** Map each contact's `actRecordManagerId` to a PathQuote `User` via `User.actUserId`, and set the company's owner from it. Nothing in `scope.ts` changes.
*Against:* a derived company has contacts under several managers, and `actRecordManagerId` is already documented as last-writer-wins. Picking one owner is picking arbitrarily, and the column then looks authoritative when it is not.

**(b) Country only.** `Company.country IN user.visibleCountries`.
*For:* one indexed column, no join, cheap, and it mirrors how the ACT! Sync Sets are actually drawn.
*Against:* a manager who owns an account outside their countries loses it.

**(c) Account Mgr only.** Visible when some contact has `actAccountMgr = user.actAccountMgr`.
*Against:* an `EXISTS` subquery per company row, and it leaves the 713 company-only clients invisible to everyone, because they have no contact at all.

**(d) Country OR Account Mgr.** What the spec describes.
*Against:* an OR across a column and a subquery, which no single index serves — the shape the phase-1 review already flagged when it argued against adding an index on `actAccountMgr` speculatively.

**Recommendation: (d), with (b) as the first increment.** Ship country-only first; it is one index and it immediately makes managers' lists usable. Add the Account Mgr arm when someone actually loses an account to it. Do not do (a) — it writes a guess into a column that reads as fact.

Either way `Company.country` needs an index, and the legacy free-text rows in it need sorting out first (`prisma/schema.prisma:718` admits pre-migration rows may not be ISO).

### D2. Does the picker keep preloading?

**(a) Keep the preload, rely on D1 to shrink the list.** No new code paths. Risks a slow builder page for admins forever, and quietly degrades as the client base grows.

**(b) Server-side search always, one path for everyone.**

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Company_name_trgm" ON "Company" USING gin (name gin_trgm_ops);
```

with `where: { name: { contains: query, mode: "insensitive" } }`, `take: 20`, and a 150–200 ms debounce. Trigram rather than a prefix index because three letters should find `PT Noitex`, not only names starting with them. `postgres:16-alpine` ships `pg_trgm`.

**Recommendation: (b).** One path, predictable at any size, and it removes the preload's hidden assumption instead of re-tuning it. The work is a server action plus turning the combobox async — the component already debounces a query string, so the change is narrower than it sounds.

**Before deciding, measure.** Import into `pq_rehearsal`, open the builder as an admin with DevTools → Network, and read the real document size and time to interactive. If it is half a second, D2 can wait behind D1. If it is three, it cannot. Guessing here is how the current comment got written.

### D3. Should the sync mark a primary contact?

Pick the first contact per company as `isPrimary`, or leave every imported contact non-primary and let the picker's arbitrary auto-select stand? Marking one is a small change in the worker; it also writes an opinion ACT! does not hold.

---

## Blocking input

**The manager → countries table, from the twelve ACT! Sync Sets.** D1 cannot be implemented without it, in any of its shapes. This has been outstanding since the infrastructure work and is worth extracting while John still remembers the reasoning behind each set.

Until it exists, `User.visibleCountries` is empty for everyone, and an empty grant means a manager sees nothing — the same place we are now.

---

## Sketch, once D1–D3 are answered

1. Index and clean `Company.country`; decide what to do with legacy free-text values.
2. Populate `User.visibleCountries` and `User.actAccountMgr` from the Sync Sets table.
3. Extend `companyWhereForUser` — pure, so the scope rule gets unit tests the way the phase-1 pure modules did, including the case of an empty grant.
4. `pg_trgm` index and a `searchClients` server action with `take`.
5. Turn the client picker's combobox async; keep the existing keyboard behaviour.
6. Decide `isPrimary`.

Steps 1–3 and 4–5 are independent and can land in either order.

## Not in this phase

Write-back to ACT!, the n8n lead pipeline, and the "Sync now" button. Contact search beyond the client picker — the quotes list and the clients page have their own queries (`src/lib/queries/clients.ts:48` is unpaginated and will want the same treatment) and should be looked at once the picker's shape is settled.
