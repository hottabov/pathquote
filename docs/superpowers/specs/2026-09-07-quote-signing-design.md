# Quote Signing — Design

Date: 2026-09-07
Status: Approved (design), pending implementation plan
Branch: `feat/quote-signing`

## Problem

A finalized quote today ends at a downloaded PDF. To get it accepted, the
manager emails the file, the client prints it, signs it by hand, scans it, and
emails it back. Every step is manual, every step can stall, and the returned
artifact is a photograph of a piece of paper with no record of who signed it or
when.

Nothing in the application knows whether a quote was ever accepted. There is no
status beyond DRAFT/FINAL, no record of the client having opened it, and no way
to tell an accepted quote from an ignored one.

## Decisions

| # | Decision |
|---|---|
| D1 | Signatures carry **commercial** weight, not legal e-signature weight. Audit trail (time, IP, user agent) and an immutable signed PDF, but no certificate of completion and no cryptographic signing. No third-party provider. |
| D2 | The signed artifact is **archived PDF bytes plus a SHA-256**, generated once at completion — not re-rendered on demand from a live template. |
| D3 | The client reaches the quote through a **single-click tokenised link**. No second magic-link email, no access code. |
| D4 | Signing requires FINAL. A completed (SIGNED) quote can never be reopened. |
| D5 | The manager's signature is **saved on their profile** and copied — never referenced — onto each quote at signing time. |
| D6 | v1 includes decline, viewed-tracking, and revoke. It excludes auto-reminders (no scheduler exists) and clone-to-revision (no such feature exists today). |
| D7 | Completion semantics follow DocuSign: after the client confirms, neither party can undo. Before confirmation, the client may re-sign freely. |

## Existing groundwork

The feature is smaller than it looks because four pieces already exist:

- `src/components/sheet/sections/signatures.tsx` already renders two empty
  signature rules ("Purchaser" / "Pathfinder") at the foot of every quote. This
  feature fills them in; it does not add a new block.
- `QuotationSheet` is a pure component already shared by the in-app preview and
  the Gotenberg PDF route. The client-facing page becomes its third consumer —
  one rendering path, not two.
- Transactional email is wired (Resend via Nodemailer), and
  `resolveReplyTo(document.author, …)` in `src/lib/email/reply-to.ts` was written
  for exactly this case. See `docs/email-sending-setup.md`, which names quote
  emails as post-v1.
- Every document-editing action is already guarded by `status: "DRAFT"` in its
  `where` clause, with a transactional re-check in
  `src/lib/actions/documents/_internal.ts`. **FINAL already means immutable.**

Note also that D2 partially resolves a problem raised in
`2026-09-07-quote-documentation-design.md`: FINAL quotes currently render legal
text live from the database, so editing a clause retroactively rewrites an old
quote's PDF. Archiving bytes at completion fixes this for signed quotes.

## Data model

Migration `z35_quote_signing` (z34 was taken by parallel work on the same
branch).

```prisma
enum SigningStatus {
  NOT_SENT   // default; "author signed but not yet sent" is NOT_SENT plus a
             // Signature(AUTHOR) row, not a distinct enum value
  SENT
  VIEWED
  SIGNED
  DECLINED
}

enum SignerRole { AUTHOR CLIENT }

model Signature {
  id          String     @id @default(cuid())
  documentId  String
  document    Document   @relation(fields: [documentId], references: [id], onDelete: Cascade)
  role        SignerRole
  imageUrl    String     // /api/files/<uuid>.png — a frozen copy
  signerName  String     // printed under the rule
  signerEmail String?
  signedAt    DateTime   @default(now())
  ip          String?
  userAgent   String?

  @@unique([documentId, role])
}

model SigningRequest {
  id            String    @id @default(cuid())
  documentId    String
  document      Document  @relation(fields: [documentId], references: [id], onDelete: Cascade)
  // Nullable and SET NULL: `email` below is the audit record, so the link to
  // the contact row is a convenience. RESTRICT was rejected — it made any
  // contact who had ever been sent a quote permanently undeletable, surfacing
  // as an unhandled foreign-key error in `deleteContact`.
  contactId     String?
  contact       Contact?  @relation(fields: [contactId], references: [id], onDelete: SetNull)
  email         String    // frozen at send time
  tokenHash     String    @unique  // SHA-256; the token itself is never stored
  expiresAt     DateTime  // frozen at send time — see "Link validity" below
  sentAt        DateTime  @default(now())
  firstViewedAt DateTime?
  revokedAt     DateTime?
  declinedAt    DateTime?
  declineReason String?
  declineIp     String?

  @@index([documentId])
}
```

Added to `Document`:

```prisma
signingStatus   SigningStatus @default(NOT_SENT)
signedPdfName   String?       // filename under the uploads directory
signedPdfSha256 String?
completedAt     DateTime?
signatures      Signature[]
signingRequests SigningRequest[]
```

Added to `User`:

```prisma
signatureUrl String?   // the saved signature, drawn once in Account
```

### Why these shapes

**`signingStatus` is a separate column, not new `DocumentStatus` values.** Every
`status === "FINAL"` check across finalize, pricing and the PDF route stays
correct untouched. Signing is an orthogonal axis.

**Only the token hash is stored.** A database dump grants access to no quote.
The token exists in the email and the URL, nowhere else.

**One `SigningRequest` row per send.** A resend inserts a new row and revokes the
previous one, so send history is preserved without a separate event table. A
third `SigningEvent` model was considered and dropped: `sentAt`,
`firstViewedAt`, `revokedAt`, `declinedAt` and `Signature.signedAt` already carry
the full trail.

**The author's signature is copied, not referenced.** If `Signature.imageUrl`
pointed at `User.signatureUrl`, a manager redrawing their signature next year
would silently rewrite it on every quote they ever signed.

### Link validity

New setting key `signing.linkValidityDays`, default **30**, following the
existing `quote.validityDays` pattern for its plumbing: a `cache`-wrapped
getter in `src/lib/queries/settings.ts`, a Zod schema in
`src/lib/validation/settings.ts`, a new case in `updateSetting` (already
`requireAdmin`), and a field on the Settings page. It does NOT follow that
pattern's 365-day ceiling, though: capped at **90** instead, because a signing
link is a bearer credential sitting in an inbox (and in every forwarded copy
of that email), not a document-validity window — a year of exposure is a
different risk than a year of quote validity, and the 365 bound is
`quote.validityDays`'s own answer to the latter question, not this one.

The resolved value is **frozen into `SigningRequest.expiresAt` at send time**.
Reading it live would let an admin lowering the setting from 30 to 7
retroactively kill every outstanding client link — the same reason
`finalizeDocument` freezes `Document.validityDays` onto the document.

## State machine

| From | Event | To |
|---|---|---|
| `NOT_SENT` | author signs | `NOT_SENT` + `Signature(AUTHOR)` |
| `NOT_SENT` + `Signature(AUTHOR)` | manager sends | `SENT` |
| `SENT` | client opens (first time) | `VIEWED` |
| `SENT` \| `VIEWED` | client signs | unchanged + `Signature(CLIENT)` |
| `SENT` \| `VIEWED` | client confirms send | `SIGNED` ✦ terminal |
| `SENT` \| `VIEWED` | client declines | `DECLINED` |
| `SENT` \| `VIEWED` | manager revokes | `NOT_SENT` |
| `SIGNED` | anything | refused |

Confirming requires a `Signature(CLIENT)` to exist. Declining stays available
right up until confirmation, including after the client has drawn a signature —
a drawn but unconfirmed signature commits them to nothing.

Both signatures use the same asymmetry: **a signature row exists before the act
that commits it.** The author signs, then presses Send. The client signs, then
confirms. Neither adds an enum value, and both give the signer a free window to
change their mind.

**Preconditions for Send** — all three, or the button is disabled with the reason
shown: `status === FINAL`, a `Signature(AUTHOR)` exists, and
`document.contact.email` is non-empty.

**The only new lock:**

```ts
// unfinalizeDocument (already ADMIN-only)
if (document.signingStatus === "SIGNED") {
  return { error: "A signed quote cannot be reopened. Create a new quote instead." };
}
```

In every other state unfinalize is permitted, but with side effects, because the
content is about to change and everything referencing it becomes false: revoke
all live `SigningRequest` rows, delete `Signature(AUTHOR)`, reset
`signingStatus` to `NOT_SENT`.

**Revoke** is the same minus the unfinalize: kill live links, return to
`NOT_SENT`, document stays FINAL. It is DocuSign's Void, with DocuSign's
restriction — unavailable once SIGNED.

**Concurrency** uses the repository's existing status-guarded `updateMany`
idiom rather than `findFirst` + `update`:

```ts
const claimed = await tx.document.updateMany({
  where: { id, signingStatus: { in: ["SENT", "VIEWED"] } },
  data: { signingStatus: "SIGNED" },
});
if (claimed.count === 0) return { error: "Already completed" };
```

Two open tabs or a double-tap on a phone cannot produce two completions;
`@@unique([documentId, role])` is the second line of defence.

**DECLINED is not terminal but is not editable.** The document stays FINAL. To
revise, an admin unfinalizes (permitted) or a manager writes a new quote.

## Security

**Token.** 32 bytes from `crypto.randomBytes`, base64url (43 characters). Stored
as `sha256(token)`, which is also the lookup key. Brute-forcing 256 bits is not a
threat model, so no rate limiting is added — there is no Redis in the project and
it would defend against nothing.

**Route.** `/sign/<token>` — token in the path, not the query string, since query
strings are logged more eagerly by proxies and analytics. The route group sets
`Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, `Cache-Control: no-store`.

**One change to `src/proxy.ts`, and it is load-bearing.** `PUBLIC_PATHS` currently
holds `["/login", "/api/auth", "/api/health"]` and everything else redirects to
login. `"/sign"` must be added. This opens a new public entrance to the
application, so nothing under `/sign` may call `auth()` or share code with the
`(app)` route group.

**The real risk is data exposure, not the token.** `getDocumentForBuilder`
selects `commissionAmount`, `commissionRatePct` and `commissionBase`. Showing a
client the manager's commission is an incident, not a bug. Therefore:

- a separate `getDocumentForSigning(tokenHash)` in its own module that does not
  import `getDocumentForBuilder` and selects exactly what `buildQuotationData`
  consumes;
- a test that fails the build if any `commission*` field appears in that select,
  modelled on the existing "fail the build when a query module skips scoping"
  test.

**Images.** `/api/files/[name]` checks the session itself, so an unauthenticated
client would see no images. That route is *not* opened. Instead the signing page
uses the existing `fileImageResolver`, which inlines images as base64 data URIs —
the same resolver the PDF pipeline already uses for Gotenberg's cookie-less
Chromium. The page is heavier; the number of new public filesystem routes is
zero.

**Archived PDFs cannot be orphaned.** Document deletion is DRAFT-only
(`lifecycle.ts`), SIGNED implies FINAL, and unfinalize is blocked at SIGNED. A
signed PDF therefore only ever belongs to a document that cannot be deleted. No
cleanup job is needed.

## UI

### SignaturePad

A small in-house component wrapping `signature_pad` (~10 KB, vanilla, pointer
events, velocity-based stroke width). React wrappers around it are effectively
unmaintained; the library is used directly.

Three details decide whether it feels real:

- **Retina scaling.** The canvas backing store must be multiplied by
  `devicePixelRatio` with the context scaled to match, or signatures are visibly
  pixellated on phones. This is the single most common mistake with this library.
- **Mobile is a full-screen overlay** with `touch-action: none` on the canvas
  (otherwise the drawing gesture scrolls the page) and body scroll locked.
  Desktop is a ~600×200 area in a dialog.
- **Export** is a transparent-background PNG cropped to the stroke bounding box,
  so the signature sits on the rule instead of floating inside an empty
  rectangle.

Controls: **Clear** and **Done**; Done is disabled while the canvas is empty.

### Manager

- **Account** — a "Signature" field beside the profile photo. Drawn once, stored
  in `User.signatureUrl`, redrawable and removable.
- **Quote (FINAL)** — a **Sign** button showing the saved signature with a "Draw
  a new one" option, then **Send to client**, which names the destination address
  so a wrong contact is caught before sending rather than after.

### Client

`QuotationSheet` and nothing else above it — no navigation, no `(app)` layout, no
link back into the application. A floating "This quote is awaiting your
signature" prompt, dismissed once signed. A sticky bottom bar:

```
┌────────────────────────────────────────────┐
│  ✍ Sign      🖨 Print       ✉ Send         │
└────────────────────────────────────────────┘
```

- **Send** is disabled until signed.
- After signing, **Sign** becomes "Signed ✓" and is inert.
- **Print** serves the ordinary PDF before completion and the archived signed PDF
  after.
- **Decline** is deliberately *not* in this bar but a restrained link below the
  quote. Three large adjacent buttons, one of which irreversibly kills the deal,
  is an invitation to a stray thumb.

### Confirmation before completion

The point of no return is Send, not the signature stroke. Using the existing
`ui-kit/confirm-dialog.tsx`:

> **Send signed quote?**
> Q-AU-2026-001 for **A$248,500.00** will be sent to **&lt;author&gt;**
> (&lt;entity&gt;). A copy of the signed quote will be emailed to you.
> Once sent, the signature cannot be changed.
>
> `Send` `Cancel`

The last line is deliberate. DocuSign does not say it, which is why its forums
are full of people asking to unsign.

### After completion

"Signed &lt;date&gt;", a PDF button, and a line reading "Questions about this
quote? &lt;author name&gt;, &lt;author email&gt;" — the "contact the sender"
remedy, without making the client work out who that is.

## Email

Templates are pure functions in `src/lib/email/`, alongside `magic-link.ts` — no
Prisma, no env reads — so they are unit-testable without booting the mail stack.

| To | When | Contents |
|---|---|---|
| Client | manager sends | The link. `Reply-To` the author via `resolveReplyTo()` |
| Manager | client completes | A link into the app — they are authenticated, an attachment is redundant |
| Client | client completes | The signed PDF **as an attachment** — they have no account, and the link eventually expires |
| Client | manager revokes | "This quote is no longer current; your manager will be in touch" — matching DocuSign's void notification, so a dead link never reads as a broken site |

## Failure handling

**On `/sign`**, each refusal has its own screen: token not found, expired,
revoked, already completed (not an error — show the quote and its PDF),
declined. All render one component with different copy. A nonexistent token and
a foreign one are **never** distinguished, matching `getDocumentForBuilder`,
where a foreign document and a missing one both 404.

**Gotenberg down at completion.** The PDF is generated *before* the transaction
(it is a network call and has no business inside one). If it fails, the
transaction never starts: `signingStatus` stays `VIEWED`, the signature survives,
and the client sees "Couldn't complete — please try again". Retrying works. There
is no half-signed state.

**Email fails after commit.** The transaction has already succeeded and the quote
is SIGNED; rolling back is not an option, because the client pressed the button
and the document *is* signed. Sending therefore happens outside the transaction,
failures are logged (`[signing] completion email failed`) and the client still
sees success. This is the lesson already recorded in `docs/email-sending-setup.md`,
where `sendMagicLink` swallowed `AuthError` and reported a send that never
happened.

## Testing

Vitest, matching existing conventions.

| File | Covers |
|---|---|
| `signing-token.test.ts` | Raw token never persisted; lookup by hash only; expired and revoked tokens open nothing |
| `signing-state.test.ts` | Every transition; unfinalize refuses at SIGNED; unfinalize at SENT revokes requests and drops the author signature; double-send yields one completion |
| `signing-exposure.test.ts` | Build fails if any `commission*` field enters the signing select |
| `signing-emails.test.ts` | Four templates as pure functions: escaping, `Reply-To` resolution, no raw token in visible link text |
| `signature-freeze.test.ts` | Changing `User.signatureUrl` after signing does not alter `Signature.imageUrl` |
| `signed-pdf-hash.test.ts` | `signedPdfSha256` matches the bytes on disk |

## Out of scope

- Auto-reminders for unresponsive clients — requires a scheduler the project does
  not have.
- Clone-to-revision — no duplicate-document feature exists today; this is its own
  piece of work, not part of signing.
- Multiple or sequential signers.
- Legally binding e-signature (certificate of completion, tamper-evident PDF,
  cryptographic signing) — explicitly ruled out by D1.
