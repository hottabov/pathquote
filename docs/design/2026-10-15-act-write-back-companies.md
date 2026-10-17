# ACT! write-back: companies

**Status:** design, decided 2026-10-15 with Vadym; ACT!'s behaviour verified
live 2026-10-16 (§3). Extends
`docs/superpowers/specs/2026-10-10-act-write-back.md` (the quote write-back,
live since 2026-10-13) and replaces its §4 "company creation follows Stage 3".

## 1. Why

The first live quote (Q-AU-2026-002, Danam (Fiji) Pte Limited) created the
contact Sangeeta Kant in ACT! with "Danam (Fiji) Pte Limited" as plain text in
the contact's Company field. No Company record, so no business or shipping
address in ACT!, and nothing to hang the opportunity on but the contact.
Vadym: every contact PathQuote sends must end up linked to a real ACT! Company
that carries PathQuote's addresses.

The old spec deferred this because PathQuote cannot tell whether a company
already exists in ACT! (it has never read `/api/companies`) and blind creates
would duplicate companies ACT! already has by the thousand. The decisions below
answer that with a lookup before every create.

## 2. Decisions (Vadym, 2026-10-15)

| # | Question | Decision |
|---|---|---|
| C1 | Find or create? | **Look up by name; one match → use it; none → create; several → see C4.** Never create blind. |
| C2 | Addresses on a company PathQuote writes | PathQuote main address (`street/city/state/postcode/country`) → ACT! **business address** (`address`). Delivery address → ACT! **`shippingAddress`**; when `deliverySameAsMain`, the main address goes there too. Billing address untouched. |
| C3 | Company already in ACT! | **Overwrite from PathQuote**: business and shipping address are written from PathQuote every time the quote's company is written, also on a company PathQuote did not create. PathQuote is the master for these two addresses. (Overrides old spec §6 "shipping only, needs a merge base".) The name is still never written (old spec §6b). |
| C4 | Several companies with that name | **Narrow by country** (PathQuote `Company.country` vs the ACT! business address country). Exactly one left → use it. Still several, or none of them in that country → the quote is **held for an administrator**, who picks the company on the quote page (or chooses "create a new one"). |
| C5 | Contacts already in ACT! (imported) with the company as text only | **Link them** to the found/created company **when the ACT! contact has no associated company**. A contact already associated with a company is left as it is. |
| O1 | Who owns what PathQuote writes (2026-10-16) | The quote author's ACT! user, linked by hand in Settings → Users (distributors are Inactive ACT! users with no email). An author not linked → the login (`ACT_USER`, John Hollo). No separate service-account owner. |

Derived from those, not asked:

- **An associated contact is the strongest evidence.** If the quote's ACT! contact already has exactly one associated company, that company *is* the quote's company in ACT!: store it, skip the name lookup. Several associated → narrow by country as C4, else hold. (C5 says such a contact is not relinked; using its company keeps the deal, the contact and the company consistent.)
- **`Company.actCompanyId` set → use it**, no lookup (the ~126 imported companies with a real ACT! company, and every one this feature finds or creates).
- The **opportunity** and **History** are linked to the company (both bodies already carry `companies` when `companyActId` is known). An opportunity created before the company was known — Danam's — is associated afterwards.
- Unchanged: one opportunity per deal, contact first, ex-tax amounts, every create looked up before it is sent, POST never retried.

## 3. What ACT! does (verified live, 2026-10-16)

Probed with `npm run act:company-probe` on production (read-only part on
"Flynt Amtex Inc."; write part on test quote Q-US-2026-001, company
"enricotest", contact Tamara Testing, author Enrico Zamarra):

1. **Lookup.** `GET /api/companies?$filter=name eq '…'` is honoured and
   case-insensitive; `startswith(name,'…')` and `contains(name,'…')` work
   too. Names differ between PathQuote and ACT! by punctuation and legal
   form ("Flynt Amtex Inc" in PathQuote, "Flynt Amtex Inc." in ACT!), so
   `eq` alone misses real matches. **Rule:** ask ACT! with `startswith` on the
   name's first word (two words when the first is shorter than 4
   characters), `$top` LOOKUP_TOP, then keep the rows whose
   `normaliseCompanyName` (src/lib/act/company-key.ts: case, punctuation and
   legal form folded) equals the PathQuote name's. A full page is refused, as
   every lookup.
2. **The contact–company link is an ASSOCIATION.** ACT!'s own linked contacts
   have `companyID` "" and `company` as text; the company is in
   `GET /api/contacts/{id}/associated-companies`. Linking = `PUT
   /api/contacts/{contactId}/associated-companies/{companyId}` (200, read back
   associated; `company` text and `companyID` unchanged). `companyID` is not
   used.
3. **Create.** `POST /api/companies` with `name`, `address`,
   `shippingAddress` answers 201 with the record; both addresses read back as
   sent. Country is a Countries picklist name (actCountryValue). Addresses
   come back with `latitude`/`longitude` (number or null) — not ours, never
   compared.
4. **Opportunity–company.** `PUT
   /api/opportunities/{id}/associated-companies/{companyId}` associates it
   (read back). Whether `companies: [{id}]` on the create does the same is
   untested; the step associates explicitly and checks.
5. **Owner (recordManager).** ACT! IGNORES `recordManagerID` on create and on
   PATCH, for opportunities, contacts, companies and History alike: every
   record came back owned by the login. A PATCH of **`recordManager`: the
   user's display name** is taken on opportunity, contact and company — also
   for an **Inactive** user (Enrico Zamarra) — and the id follows. **History
   cannot be re-owned** (PATCH answered 200, owner unchanged): a History is
   always the login's. Harmless for the weekly report, which counts only Call
   Completed / E-mail Sent / Meeting Held histories and prospects by the
   CONTACT's owner.
6. An opportunity whose record manager is someone else does not show in the
   ACT! Opportunities list of the person looking (their default filter), but
   does on the contact's Opportunities tab. Accepted by Vadym.

## 4. Flow

New planner steps, in this order, before anything else that needs the company:

```
create-contact (as today) → set its owner by name (O1)
→ resolve-company      find the quote's ACT! company, or decide to create one
→ create-company       only when resolve found none → set its owner by name
→ write-company        overwrite business + shipping address (C3), every row
→ link-contact-company only when the ACT! contact has no associated company (C5)
→ create/update-opportunity → set its owner by name → associate-opportunity-company if missing
→ write-product-line → write-history (with companies) → … as today
```

**Owner by name (O1).** After each create of a contact, company or
opportunity, PATCH `{ id, recordManager: <author's ACT! display name> }`
unless the record already reads back with that `recordManager`; the name is
the one `GET /api/users` gives for User.actUserId (read once per pass, as the
service account is now). An author with no ACT! user: nothing to do — the
login owns it. Done as part of the create step, so a resumed step re-checks
and re-sends only when the owner is still wrong. A record created before this
change (Danam's contact, Q-US-2026-001's) is not revisited.

`resolve-company` order: `Company.actCompanyId` → the ACT! contact's
associated companies → name lookup (C1/C4). Its result is stored on
`Company.actCompanyId` (the PathQuote company, shared by every quote on it), so
it is decided once per company, not per quote.

A quote with no company (`Document.companyId` null) skips all company steps,
as today.

**In flight.** A company create whose answer is lost would duplicate on retry
exactly like a contact; it gets the same treatment: a marker on the PathQuote
company (`Company.actCreateInFlightAt`) set before the POST, a lookup by name
before any later create, and a hold for every quote on that company while the
marker stands unresolved.

**Held for an administrator** (C4): `ActOutbox.blockedBy = "company"`, reason
naming the candidates. The quote's ACT! card lists them (name, city, country)
with "Use this company" and "Create a new company in ACT!"; the choice is
stored on `Company.actCompanyId` (or a "create" flag) and the row released.
Managers see the hold and its sentence, as for every hold.

**Echo.** Writing a company or associating a contact bumps its `edited` in
ACT!; the inbound sync reads contacts, not companies, and the contact's
company text and `companyID` are not changed, so nothing comes back as a
change — but the owner PATCH does change the contact, and the inbound sync
must treat its own write as an echo (ActSnapshot / actSourceEditedAt, as for
every write-back). Incoming contacts carry `companyID` "", so
`src/lib/act/company-identity.ts` keeps finding the PathQuote company by its
key; `Company.actCompanyId` set by this feature does not disturb that.

## 5. Out of scope

- Writing company fields other than the two addresses (name, website, phone,
  industry, notes — old spec §6/6b stand).
- Reading all ACT! companies into PathQuote (old spec Stage 3). Only the
  per-name lookup is added.
- Relinking a contact already linked to another company.
- Backfilling companies for contacts no quote touches. Existing quotes get it
  on their next event (finalise, signature, acceptance) or an admin's "Try
  again now"; Danam is the first.

## 6. Testing on production

Same as the write-back: preflight additions (filter honoured, one known
company found), then Vadym's scenarios on test quotes, checked with
`npm run act:show-quote` (extended to print the ACT! company, its addresses
and the contact's link).
