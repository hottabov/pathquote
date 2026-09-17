# Implementation notes — pathquote-revisions-send

Companion to `pathquote-revisions-send-spec.md`. The spec was written somewhat
greenfield (it talks about a `Quote`/`QuoteStatus` model, dotted `{{client.x}}`
tokens, `POST /api/...` routes, and a typed name+email signing form). The real
repo already implements much of this, differently and deliberately. This file
records how each spec item maps onto the actual code, the forks resolved, and
what is done vs. still pending.

## Terminology map (spec → repo)

| Spec | Repo |
|---|---|
| `Quote` | `Document` |
| `QuoteStatus` (linear enum) | `DocumentStatus {DRAFT,FINAL}` × `SigningStatus {NOT_SENT,SENT,VIEWED,SIGNED,DECLINED}` (two orthogonal axes) |
| owner / creator | `Document.authorId` |
| manager signature | `Signature` row, role `AUTHOR` |
| client signature | `Signature` row, role `CLIENT` |
| `POST /api/quotes/[id]/...` mutations | `"use server"` actions in `src/lib/actions/*` |

## Status model — DECISION: keep the two-axis model

The repo's schema comments explicitly warn against extending `DocumentStatus`
(that is why `SigningStatus` was added as a separate axis). Rather than replace
it with the spec's linear enum — a large, risky rewrite of finalize, signing,
scope and every UI badge — the spec's statuses are **derived**:

```
DRAFT          = status DRAFT
FINALIZED      = status FINAL + signingStatus NOT_SENT
SENT           = status FINAL + signingStatus SENT | VIEWED
CLIENT_SIGNED  = status FINAL + signingStatus SIGNED
ACCEPTED       = CLIENT_SIGNED + Document.acceptedAt set
CANCELLED      = unchanged (not modelled here)
```

Spec columns that already exist as derivable state, so they are **not** added
as duplicate columns (derive instead):

- `managerSignedAt/ById` → the AUTHOR `Signature` row (`signedAt`, and its
  presence is the ACCEPTED gate).
- `clientSignedAt/Name/Email/Ip` → the CLIENT `Signature` row
  (`signedAt`, `signerName`, `signerEmail`, `ip`).

## Mutations — DECISION: server actions, not REST routes

Every quote mutation in this repo is a `"use server"` function in
`src/lib/actions/*` (`finalizeDocument`, `unfinalizeDocument`, `signAsClient`,
…). The spec's `POST /api/quotes/[id]/unfinalize|void-signature|send` become
server actions in `src/lib/actions/`. PDF/stream endpoints stay GET routes
under `src/app/api/quotes/[documentId]/…` (matching `quotation-pdf`,
`signed-pdf`). "In the style of the existing routes" (spec §4) *is* server
actions here.

## Token resolver — DECISION: reuse the engine, register flat tokens

The existing resolver is `substitutePlaceholders` / `substituteWithReport`
(`src/lib/quotation-data.ts`), driven by `src/lib/quote-variables.ts`. Its
pattern only matches **flat** identifiers (`/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g`)
— it does not match the dotted `{{client.firstName}}` the spec's email
template uses. Resolution: reuse the engine, but the email token set is
registered as flat names (e.g. `clientFirstName`, `quoteLabel`, `signLink`) in
a new email-scope token list, exactly like the existing category/document
scopes. `OMIT` already gives the spec's "strip the whole line if a token
doesn't resolve" behaviour. (The alternative — broadening the shared regex to
allow dots — was rejected as too blast-radius-y for a shared pattern.)

## Audit table — QuoteEvent added, superseding the old "no audit table" call

The signing feature deliberately chose **not** to have an audit table (it
spread the trail across `SigningRequest`+`Signature` timestamps; see the
"D12" note referenced in `unfinalizeDocument`). This spec supersedes that for
this workflow: `voidSignature` requires a mandatory `reason` that has nowhere
else to live, and the unsent-changes flow needs a durable event record. So
`QuoteEvent` is added as specced. Flagged here because it reverses an earlier
documented decision.

## Email templates — stored in the existing `Setting` table

Admin-editable subject/body templates go in the `Setting` key/JSON table via
`updateSetting` (add keys to `ALLOWED_SETTING_KEYS` + a zod schema + a getter
with a `DEFAULT_*` constant fallback in `queries/settings.ts`) — the exact
pattern already used for `quote.validityDays`, `signing.linkValidityDays`, etc.
Code constants are the fallback.

## Company / manager / client data sources

- Company/org placeholders come from `Region` (`entityName`, `entityLegalId`,
  `entityAddress`, `footerText`, `logoUrl`, bank details) — **there is no
  `website` field** on Region; `{{company.website}}` resolves to empty/omit.
- Manager placeholders come from `User` (`name`, `email`, `phone`) — **there
  is no job-title field** on User; `{{manager.title}}` omits.
- Client contact from `Contact` (`firstName`, `lastName`, `email`) via
  `Document.contact`/`Document.company`; the send-time address is frozen on
  `SigningRequest.email`.

## Signing page (§8) — the described bug does not exist yet

There is currently **no `transform: scale()`** anywhere on the signing/sheet
path and no app-managed zoom. The action bar is already a correctly-positioned
`fixed` sibling of the sheet (`client-action-bar.tsx`). The mobile problem the
spec targets (a 210mm A4 sheet overflowing on a phone, no way to zoom-to-fit
and still tap the button) is real, but the fix is to **add** the custom-zoom
`.pq-sheet-viewport` + non-scaling `.pq-action-bar` structure, not to unwind a
scale wrapper that isn't there.

## Signing UX (§8.3) — DECISION: keep the drawn pad, add name/email/consent

The repo already has a full drawn-signature flow (`SignaturePad`,
`signAsClient`/`completeSigning`/`declineSigning`, completion emails to client
and author). The spec's typed name+email+consent form is layered **around**
the pad rather than replacing it: capture `Full name`, prefilled `Email` and a
consent checkbox alongside the drawn signature, persisting name/email/ip on the
CLIENT `Signature` row.

---

## Status of the work

Sandbox verification: `npx vitest run` (2037 pass) and `npx eslint` are green
for everything below. `npx tsc --noEmit` is expected to error on the new Prisma
columns/models/delegates until the maintainer runs `prisma generate` locally
(§11) — no other error class was introduced.

### Done & verified

- **Phase 1** — Schema (`prisma/schema.prisma`: `Document` + `QuoteRevision`/
  `QuoteEvent`/`QuoteEmail`), migration DDL
  (`prisma/migrations/z43_quote_revisions_send/migration.sql`), and backfill
  (`scripts/backfill-quote-revisions.ts`, dry-run/`--yes`).
- **Phase 2** — Pure, unit-tested logic: `src/lib/documents/revision-snapshot.ts`
  (`stableStringify`, `hashRevisionSnapshot`, `buildRevisionSnapshot`,
  `documentToRevisionSnapshotInput`) and `revision-plan.ts` (`planRevision`,
  `revisionLabel`). DB wiring: `finalizeDocument` now builds+hashes a snapshot,
  mints a `QuoteRevision` only when the content changed, stamps
  `revision`/`finalizedAt`, and generates the revision PDF best-effort
  post-commit (`src/lib/documents/revision.ts`). `unfinalizeDocument` widened
  to owner-or-admin with an optional reason + `hasUnsentChanges` + event.
  New actions `voidSignature` (admin, mandatory reason, keeps the signed
  revision) and `acceptQuote` (manager-signature gate).
- **Phase 3** — the above are the server actions (house style, not REST).
- **Phase 5 (logic)** — `canSendToClient` no longer gates on the author
  signature; `canAuthorSign` now allows SIGNED (manager signs after client);
  new `canAccept`. Call sites in `signing.ts`/`page.tsx` updated. Tests updated.
- **Phase 4** — `UnfinalizeButton` widened (owner + admin, hidden at SIGNED,
  shows the "already sent" warning); new `AcceptButton` and
  `VoidSignatureButton` (mandatory-reason dialog); `UnsentChangesBanner`;
  `RevisionsSection` + `EmailHistorySection` (fed by a scoped `getQuoteHistory`
  query, `src/lib/queries/quote-revisions.ts`) wired into the quote page; a
  revision-PDF route (`app/api/quotes/[documentId]/revisions/[revisionId]/pdf`).
  `getDocumentForBuilder` now surfaces `revision`/`hasUnsentChanges`/`sentAt`/
  `acceptedAt`/`signedRevisionId`.
- **Phase 6** — email builder (`src/lib/email/quote-send.ts`: flat-token fill
  §7.2, first-send/resend templates §7.3, bulletproof 600px HTML + plain-text
  §7.4; unit-tested) AND the server send `sendQuoteToClient`
  (`src/lib/actions/signing.ts`): issues the signing token like
  `sendQuoteForSignature`, sends the rich email with the frozen revision PDF
  attached, writes `QuoteEmail` + SENT event, sets `sentAt` and clears
  `hasUnsentChanges` only after the provider accepts (§7.6).

### Pending (needs browser/email + `prisma generate`)

- **Prisma**: `prisma migrate dev` (validate/regenerate z43) + `prisma
  generate`, then `tsx scripts/backfill-quote-revisions.ts --yes`.
- **Phase 6 UI**: the Send dialog (React modal — To/Cc/Bcc, subject/message
  prefilled via `renderQuoteSendDraft`, live `Preview` iframe rendered by the
  now-pure `buildQuoteSendEmail`, attachment chip) wired to `sendQuoteToClient`;
  the existing `SendToClientButton` still calls the old invite flow until this
  swap. Plus email-template `Setting` keys + admin editor (§7.3).
- **Phase 7**: signing page — custom zoom `.pq-sheet-viewport` + non-scaling
  fixed `.pq-action-bar` (the described bug doesn't exist yet — the fix is to
  *add* zoom, not unwind a scale wrapper), plus the sign modal wrapping the
  existing pad with Full name + Email + consent.
- **Phase 8**: signed per-revision PDF (`QuoteRevision.signedPdfPath`) on client
  sign + set `signedRevisionId`; post-signature emails (the repo already has
  `buildCompletionEmailForClient`/`ForAuthor` — extend to attach the signed
  PDF and notify the sales admin).
- **Per-revision token → 410**: tie `SigningRequest` to a revision; extend
  `resolveLinkState` so a token for a superseded revision returns 410 with the
  spec's message instead of the uniform 404.
