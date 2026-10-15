# ACT! write-back: companies

**Status:** design, decided 2026-10-15 with Vadym. Extends
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
| C5 | Contacts already in ACT! (imported) with the company as text only | **Link them** to the found/created company **when the ACT! contact has no linked company**. A contact already linked to a company is left as it is. |

Derived from those, not asked:

- **A linked contact is the strongest evidence.** If the quote's ACT! contact is already linked to a company (`contact.companyID` set), that company *is* the quote's company in ACT!: store it, skip the name lookup. (C5 says such a contact is not relinked; using its company keeps the deal, the contact and the company consistent.)
- **`Company.actCompanyId` set → use it**, no lookup (the ~126 imported companies with a real ACT! company, and every one this feature finds or creates).
- The **opportunity** and **History** are linked to the company (both bodies already carry `companies` when `companyActId` is known). An opportunity created before the company was known — Danam's — is associated afterwards.
- Unchanged: one opportunity per deal, contact first, ex-tax amounts, every create looked up before it is sent, POST never retried.

## 3. What ACT! offers (swagger, RAW/ACT/swagger.json)

- `GET/POST /api/companies`, `GET/PATCH/PUT /api/companies/{companyId}`.
  Company: `name`, `address`, `billingAddress`, `shippingAddress` (each
  `line1..3, city, state, postalCode, country`), `recordManagerID`, `phone`,
  `website`, `customFields`, … `country` is a Countries picklist name, as for
  contacts (COUNTRIES_PICKLIST_ID; same mapping as `newContactBody`).
- Contact: `company` (text), `companyID` (uuid of the linked company).
- Associations: `PUT /api/contacts/{contactId}/associated-companies/{companyId}`,
  `PUT /api/companies/{companyId}/associated-contacts/{contactId}`,
  `PUT /api/opportunities/{opportunityId}/associated-companies/{companyId}`.

**Unverified, to be probed live before any code relies on it (plan Task 1):**

1. `GET /api/companies?$filter=name eq '…'` — honoured, as it is on opportunities and History? Case-insensitive?
2. Which call makes the contact's **Company field a link** (what a person sees in ACT! as a linked company): PATCH the contact with `companyID` (and `company` = name), or PUT the association? In ACT! "associated companies" is a separate many-to-many tab; the link is what C5 asks for.
3. Does `POST /api/companies` take `address`/`shippingAddress` on create, or do they need a PATCH?
4. Does `POST /api/opportunities` with `companies: [{id}]` associate the company (no live opportunity has been created with one yet)?
5. ACT! answers enums as numbers (opportunity `status`, 2026-10-13): check what else on Company comes back that way before comparing.

## 4. Flow

New planner steps, in this order, before anything else that needs the company:

```
create-contact (as today)
→ resolve-company      find the quote's ACT! company, or decide to create one
→ create-company       only when resolve found none
→ write-company        overwrite business + shipping address (C3), every row
→ link-contact-company only when the ACT! contact has no linked company (C5)
→ create/update-opportunity (now with companies) → associate-opportunity-company if missing
→ write-product-line → write-history (with companies) → … as today
```

`resolve-company` order: `Company.actCompanyId` → the ACT! contact's
`companyID` → name lookup (C1/C4). Its result is stored on
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

**Echo.** Writing a company or relinking a contact bumps its `edited` in ACT!;
the inbound sync reads contacts, not companies, and the contact's company text
is not changed, so nothing comes back as a change. Setting
`Company.actCompanyId` on a derived company keeps the inbound identity rules
consistent (`src/lib/act/company-identity.ts`: an incoming contact with that
`companyID` finds the same row by id).

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
