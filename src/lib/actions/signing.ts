"use server";

import { db } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { revalidateDocument } from "@/lib/revalidate";
import { documentWhereForUser } from "@/lib/scope";
import { idSchema } from "@/lib/validation/documents";
import { saveUpload, UploadValidationError } from "@/lib/uploads";
import { parseSignatureDataUrl } from "@/lib/signing/data-url";
import {
  canAuthorSign,
  canRevoke,
  canSendToClient,
  signatureRolesClearedBy,
  ALREADY_IN_FLIGHT,
  type SigningStatus,
} from "@/lib/signing/state";
import { readMySavedSignatureBytes } from "@/lib/signing/saved-signature";
import { generateSigningToken, hashSigningToken } from "@/lib/signing/token";
import { addDays } from "@/lib/signing/link";
import { getSigningLinkValidityDays } from "@/lib/queries/settings";
import { buildSigningInviteEmail, buildRevokedEmail } from "@/lib/email/signing";
import { resolveReplyTo } from "@/lib/email/reply-to";
import { createAppMailTransport, mailFromAddress } from "@/lib/email/transport";
import { formatMoney, formatDateAU } from "@/lib/format";
import { NOT_FOUND_ERROR, type ActionResult } from "./_shared";

export type { ActionResult };

/**
 * Applies the author's signature to a FINAL quote.
 *
 * `dataUrl` is either a freshly drawn signature or, when the manager accepts
 * their saved one, the literal string "saved" -- in which case bytes come
 * from `readMySavedSignatureBytes` (src/lib/signing/saved-signature.ts) and
 * are written as a *new* upload. Copying rather than referencing is the
 * whole point: a manager who redraws their saved signature next year must
 * not retroactively change what a customer already signed (see the
 * `imageUrl` doc comment on the `Signature` model in schema.prisma).
 *
 * That guarantee used to be enforced by a regex over this file's own source
 * text (tests/signature-freeze.test.ts) and was defeated in one edit: assign
 * the saved-signature column to an intermediate variable, then write that
 * variable into `imageUrl`. The fix is structural rather than a tighter
 * regex: this file never selects, reads, or names that column at all --
 * `readMySavedSignatureBytes` returns bytes or a reason and nothing
 * URL-shaped, so there is nothing left here for a future edit to assign into
 * `imageUrl`. The guard is now simply that the identifier does not occur in
 * this file (see that test's own header comment).
 *
 * Scoped and shaped like `finalizeDocument`/`unfinalizeDocument`
 * (src/lib/actions/finalize.ts): `requireSession` for the same
 * redirect-to-login a page-adjacent action wants, `idSchema` to validate the
 * id before it reaches a query, and `documentWhereForUser` so a manager may
 * only sign their own document while an admin may sign any -- including
 * putting their own name in the AUTHOR slot rather than the salesperson's,
 * confirmed intended by the reviewer, the same admin bypass
 * `finalizeDocument` documents on its own override-logging. `NOT_FOUND_ERROR`
 * rather than a distinct message for "wrong scope" so a manager can never
 * tell a foreign document from one that doesn't exist.
 */
export async function signQuoteAsAuthor(documentId: string, dataUrl: string): Promise<ActionResult> {
  const session = await requireSession();

  const parsedId = idSchema.safeParse(documentId);
  if (!parsedId.success) return { error: NOT_FOUND_ERROR };

  const document = await db.document.findFirst({
    where: { id: parsedId.data, status: "FINAL", ...documentWhereForUser(session.user) },
    select: { id: true, signingStatus: true },
  });
  if (!document) return { error: NOT_FOUND_ERROR };
  // The precondition lives in src/lib/signing/state.ts, beside every other
  // signing transition rule, rather than as a hand-written check here -- see
  // that function's own doc comment for why NOT_SENT and DECLINED are the
  // two allowed statuses. `SignButton` (src/components/builder/sign-button.tsx)
  // gates its own visibility on the same function so the two can never
  // disagree.
  if (!canAuthorSign(document.signingStatus)) {
    return { error: "This quote can no longer be signed." };
  }

  // `ip`/`userAgent` are never recorded for this role: the author signs
  // inside a session that already identifies them, unlike the client's
  // unauthenticated row (a later task), where those two columns carry the
  // whole audit trail.
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { name: true, email: true },
  });
  if (!user) return { error: NOT_FOUND_ERROR };

  let bytes: Buffer;
  if (dataUrl === "saved") {
    const saved = await readMySavedSignatureBytes(session.user.id);
    if (!saved.ok) return { error: saved.reason };
    bytes = saved.bytes;
  } else {
    const parsed = parseSignatureDataUrl(dataUrl);
    if (!parsed.ok) return { error: "That signature could not be read. Please draw it again." };
    bytes = parsed.bytes;
  }

  const file = new File([new Uint8Array(bytes)], "signature.png", { type: "image/png" });

  // saveUpload returns just the filename, not a URL (see its own doc
  // comment in src/lib/uploads.ts) -- every other caller builds the
  // `/api/files/<name>` URL itself (see saveMySignature,
  // src/lib/actions/users.ts), and this one must too, or Signature.imageUrl
  // would resolve relative to whatever page renders it instead of through
  // the same ImageResolver every other stored image URL goes through (see
  // `signatureFor` in src/lib/quotation-data.ts). Wrapped the same way
  // saveMySignature wraps its own call: the bytes have already passed one
  // PNG check (parseSignatureDataUrl's magic-number test, or
  // readMySavedSignatureBytes reading back a file `saveUpload` itself once
  // wrote), but saveUpload's own sniffImageType is the actual trust boundary
  // and is free to disagree on a malformed edge case.
  let filename: string;
  try {
    filename = await saveUpload(file, ["png"]);
  } catch (error) {
    if (error instanceof UploadValidationError) return { error: error.message };
    throw error;
  }
  const imageUrl = `/api/files/${filename}`;

  await db.signature.upsert({
    where: { documentId_role: { documentId: document.id, role: "AUTHOR" } },
    create: {
      documentId: document.id,
      role: "AUTHOR",
      imageUrl,
      signerName: user.name ?? user.email,
      signerEmail: user.email,
    },
    // A re-sign is a complete re-freeze, not just a refreshed image: every
    // other freezing event in this codebase recomputes all of its frozen
    // fields together (see `entitySnapshot` and the commission columns in
    // `finalizeDocument`, src/lib/actions/finalize.ts), so `signerName`/
    // `signerEmail` update alongside `imageUrl`/`signedAt` here too --
    // otherwise a re-sign after a profile rename would keep the old name
    // next to a brand-new image.
    update: {
      imageUrl,
      signerName: user.name ?? user.email,
      signerEmail: user.email,
      signedAt: new Date(),
    },
  });

  revalidateDocument(document.id);
  return {};
}

// --- sendQuoteForSignature helpers ------------------------------------------

/**
 * The exact set of `signingStatus` values `canSendToClient`
 * (src/lib/signing/state.ts) permits a send from, derived by asking that
 * function itself -- for every status in the type, with the other three
 * inputs fixed to values that already pass -- rather than repeating
 * `["NOT_SENT", "DECLINED"]` as a second literal here, where it could
 * silently drift from that function's own rule (e.g. if DECLINED were ever
 * retired as a sendable status). Used below as the `where` of the
 * status-guarded claim that replaces the plain revoke-then-insert.
 */
const ALL_SIGNING_STATUSES: SigningStatus[] = ["NOT_SENT", "SENT", "VIEWED", "SIGNED", "DECLINED"];
const SENDABLE_SIGNING_STATUSES: SigningStatus[] = ALL_SIGNING_STATUSES.filter(
  (signingStatus) =>
    canSendToClient({
      documentStatus: "FINAL",
      signingStatus,
      hasAuthorSignature: true,
      contactEmail: "probe@example.com",
    }).ok
);

/** Thrown inside `sendQuoteForSignature`'s `$transaction` when the
 * status-guarded claim below matches nothing -- another request already
 * moved the document out of a sendable status between the pre-check
 * (`canSendToClient`, above the transaction) and the claim itself. Caught
 * outside the transaction and mapped to the same `ALREADY_IN_FLIGHT` message
 * the pre-check would have returned, so a manager sees one consistent
 * explanation whichever path refused. */
class AlreadyClaimedError extends Error {}

type ResolvedAuthUrl = { ok: true; baseUrl: string } | { ok: false; error: string };

/**
 * Resolves and validates `AUTH_URL` before a token is generated or any row
 * is touched.
 *
 * Unvalidated, `${process.env.AUTH_URL}/sign/${token}` is a dead link
 * nobody can fix once it exists: unset, the emailed link contains the
 * literal string "undefined"; with a trailing slash it gets a double slash.
 * Either is discovered only when the client clicks -- after the only
 * credential they will ever receive has already been sent. Checking first
 * costs nothing on failure: no token generated, no row written, no email
 * sent.
 */
function resolveSigningBaseUrl(): ResolvedAuthUrl {
  const raw = process.env.AUTH_URL;
  if (!raw || raw.trim() === "") {
    console.error("[signing] AUTH_URL is not set");
    return { ok: false, error: "Signing links are not configured (AUTH_URL is missing). Contact an admin." };
  }

  // A trailing slash (or several) would otherwise survive into
  // `${baseUrl}/sign/${token}` as a doubled slash.
  const baseUrl = raw.trim().replace(/\/+$/, "");

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    console.error("[signing] AUTH_URL is not a valid absolute URL", { value: raw });
    return { ok: false, error: "Signing links are misconfigured (AUTH_URL is invalid). Contact an admin." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    console.error("[signing] AUTH_URL is not an http(s) URL", { value: raw });
    return { ok: false, error: "Signing links are misconfigured (AUTH_URL is invalid). Contact an admin." };
  }

  return { ok: true, baseUrl };
}

/**
 * Issues a signing link and emails it to the document's contact.
 *
 * The token is generated here, hashed into the row, and then exists only in
 * the email — there is no way to recover it afterwards, which is why a
 * resend issues a new one rather than re-sending the old.
 *
 * `expiresAt` is computed once, from the setting, and frozen. Resolving an
 * existing link never reads the setting again.
 *
 * Deviations from the plan's original sketch, checked against the real
 * code:
 *  - `requireSession` (redirects to /login), matching `signQuoteAsAuthor`
 *    right above, rather than a bare `auth()` + manual null check.
 *  - The mail transport is `createAppMailTransport()` + `transport.sendMail`
 *    + `mailFromAddress()` (src/lib/email/transport.ts) — there is no
 *    exported `sendMail({ to, ...mail })` helper. Same shape
 *    `submitSupportMessage` (src/lib/actions/support.ts) already uses,
 *    including its "rejected/pending" check for a silently-refused send.
 *  - The base URL is `process.env.AUTH_URL` — this is Auth.js v5
 *    (`AUTH_URL`/`AUTH_TRUST_HOST` in .env.example), not v4's
 *    `NEXTAUTH_URL`, which is set nowhere in this codebase. Read and
 *    validated once, up front, by `resolveSigningBaseUrl` (above) rather
 *    than interpolated straight into the link.
 *  - Formatters are `formatMoney`/`formatDateAU` from src/lib/format.ts —
 *    there is no `formatLongDate`. `formatDateAU` (DD/MM/YYYY) is reused
 *    rather than introducing a second date format, matching the quote
 *    sheet's own convention.
 *  - `SigningRequest.contactId` is nullable, so `contactId`/`email` are read
 *    into local `const`s and checked once here — `canSendToClient` already
 *    guarantees they are present by the time this point is reached (it
 *    refuses with `NO_CONTACT_EMAIL` otherwise), but that guarantee isn't
 *    visible to the type checker across the function boundary.
 */
export async function sendQuoteForSignature(documentId: string): Promise<ActionResult> {
  const session = await requireSession();

  const parsedId = idSchema.safeParse(documentId);
  if (!parsedId.success) return { error: NOT_FOUND_ERROR };

  // Checked before the document is even loaded: a misconfigured environment
  // should fail loudly here, not after a token has been generated, a row
  // written, and an email sent with an unrecoverable link in it.
  const resolvedAuthUrl = resolveSigningBaseUrl();
  if (!resolvedAuthUrl.ok) return { error: resolvedAuthUrl.error };

  const document = await db.document.findFirst({
    where: { id: parsedId.data, ...documentWhereForUser(session.user) },
    select: {
      id: true,
      number: true,
      status: true,
      signingStatus: true,
      total: true,
      currency: true,
      contactId: true,
      contact: { select: { id: true, email: true, firstName: true, lastName: true } },
      author: { select: { name: true, email: true, active: true } },
      region: { select: { entityName: true } },
      signatures: { where: { role: "AUTHOR" }, select: { id: true } },
    },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  const verdict = canSendToClient({
    documentStatus: document.status,
    signingStatus: document.signingStatus,
    hasAuthorSignature: document.signatures.length > 0,
    contactEmail: document.contact?.email ?? null,
  });
  if (!verdict.ok) return { error: verdict.reason };

  // Guaranteed non-null by the verdict above; re-checked here only so the
  // type checker (which cannot see across that function boundary) narrows
  // them for the writes below.
  const contactId = document.contactId;
  const contactEmail = document.contact?.email;
  if (!contactId || !contactEmail) return { error: NOT_FOUND_ERROR };

  const days = await getSigningLinkValidityDays();
  const token = generateSigningToken();
  const now = new Date();
  const expiresAt = addDays(now, days);

  // Captured before the transaction below touches the row, so a failed send
  // (caught further down) can restore exactly what was there -- NOT_SENT or
  // DECLINED, the only two values `canSendToClient` would have let through.
  const previousStatus = document.signingStatus;

  let requestId: string;
  try {
    requestId = await db.$transaction(async (tx) => {
      // Claim the document first, atomically. The revoke-then-insert below
      // has no row lock of its own, and under Postgres's default READ
      // COMMITTED two concurrent sends could each pass the `canSendToClient`
      // check above and each create a live `SigningRequest` -- defeating the
      // guarantee that issuing a link kills the previous one.
      // `tokenHash`'s unique constraint doesn't help, since the two tokens
      // differ. This status-guarded `updateMany` is the same idiom
      // `assertStillDraft` (src/lib/actions/documents/_internal.ts) and
      // `finalizeDocument`'s own concurrent-finalize guard
      // (src/lib/actions/finalize.ts) use for exactly this: only a write
      // takes the row lock that orders concurrent callers against each
      // other, and `count === 0` means this call lost the race.
      const claimed = await tx.document.updateMany({
        where: { id: document.id, signingStatus: { in: SENDABLE_SIGNING_STATUSES } },
        data: { signingStatus: "SENT" },
      });
      if (claimed.count === 0) throw new AlreadyClaimedError();

      // Any earlier request is dead the moment a new one is issued.
      await tx.signingRequest.updateMany({
        where: { documentId: document.id, revokedAt: null },
        data: { revokedAt: now },
      });
      const created = await tx.signingRequest.create({
        data: {
          documentId: document.id,
          contactId,
          email: contactEmail,
          tokenHash: hashSigningToken(token),
          expiresAt,
        },
        select: { id: true },
      });
      return created.id;
    });
  } catch (error) {
    if (error instanceof AlreadyClaimedError) return { error: ALREADY_IN_FLIGHT };
    throw error;
  }

  const mail = buildSigningInviteEmail({
    url: `${resolvedAuthUrl.baseUrl}/sign/${token}`,
    quoteNumber: document.number ?? "",
    total: formatMoney(document.total, document.currency),
    authorName: document.author.name ?? document.author.email,
    entityName: document.region.entityName,
    expiresOn: formatDateAU(expiresAt),
    replyTo: resolveReplyTo(document.author, process.env.EMAIL_REPLY_TO),
  });

  // Deliberately outside the transaction that issued the link: a mail
  // transport call has no place holding a DB transaction open. Failures are
  // surfaced rather than swallowed -- the trap documented in
  // docs/email-sending-setup.md, where a swallowed AuthError made "sent" a
  // lie -- and are no longer left standing either, see the catch below.
  try {
    const transport = createAppMailTransport();
    const result = await transport.sendMail({
      to: contactEmail,
      from: mailFromAddress(),
      replyTo: mail.replyTo,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });

    const failed = [...(result.rejected ?? []), ...(result.pending ?? [])].filter(Boolean);
    if (failed.length) {
      throw new Error(`Email (${failed.join(", ")}) could not be sent`);
    }
  } catch (error) {
    console.error("[signing] invite email failed", error);
    // The link was issued but never delivered, so leaving it live would
    // block the retry behind a Revoke button that does not exist yet -- and
    // would advertise a credential nobody received. Undo the issue instead.
    // Any request that was already live stays revoked: the manager chose to
    // replace it, and re-arming it here would resurrect a link they had
    // decided to kill.
    await db.$transaction(async (tx) => {
      await tx.signingRequest.update({ where: { id: requestId }, data: { revokedAt: new Date() } });
      await tx.document.update({ where: { id: document.id }, data: { signingStatus: previousStatus } });
    });
    return { error: "The quote could not be emailed. Nothing was sent — try again." };
  }

  revalidateDocument(document.id);
  return {};
}

// --- revokeSigningLink -------------------------------------------------------

/**
 * The exact set of `signingStatus` values `canRevoke` (src/lib/signing/state.ts)
 * permits a revoke from, derived by asking that function itself over
 * `ALL_SIGNING_STATUSES` (declared above, next to `SENDABLE_SIGNING_STATUSES`)
 * rather than repeating `["SENT", "VIEWED"]` as a second literal here, where
 * it could silently drift from that function's own rule. Used below as the
 * `where` of the status-guarded claim that replaces the unconditional
 * revoke.
 */
const REVOCABLE_SIGNING_STATUSES: SigningStatus[] = ALL_SIGNING_STATUSES.filter(canRevoke);

/** The message a manager sees both when the pre-check finds no live link and
 * when the guarded claim inside the transaction loses its race (below) --
 * one wording for both refusals, so which path caught it is invisible to the
 * user. */
const NO_LIVE_LINK_TO_REVOKE = "There is no live link to revoke.";

/** Thrown inside `revokeSigningLink`'s `$transaction` when the status-guarded
 * claim below matches nothing -- the client's own completion or decline
 * (`completeSigning`/`declineSigning`, not yet implemented; a later task)
 * already moved the document out of SENT/VIEWED between the pre-check
 * (`canRevoke`, above the transaction) and the claim itself. Caught outside
 * the transaction and mapped to `NO_LIVE_LINK_TO_REVOKE`, the same message
 * the pre-check would have returned -- mirroring `AlreadyClaimedError`
 * above. */
class RevokeLostRaceError extends Error {}

/**
 * Kills every live link for a quote and returns it to NOT_SENT. This is
 * DocuSign's Void, with DocuSign's restriction: `canRevoke` (src/lib/signing/state.ts)
 * refuses once the quote is SIGNED, because a signed quote is not something
 * either party can take back.
 *
 * The client is told, matching DocuSign's void notification: a dead link
 * with no explanation reads as a broken website. That courtesy email is
 * deliberately allowed to fail without failing the revoke -- the opposite
 * ordering from `sendQuoteForSignature` above. There, a failed send undoes
 * the issue, because nothing had happened yet that the manager wanted. Here,
 * the link is already dead by the time any mail is attempted, which is the
 * part that mattered; a failed notice is logged, not surfaced as a failed
 * revoke. Each recipient is mailed independently inside its own try/catch so
 * one rejection can never stop the others from being tried.
 *
 * Scoped and shaped like `sendQuoteForSignature`/`signQuoteAsAuthor` above:
 * `requireSession`, `idSchema`, `documentWhereForUser` so a manager may only
 * revoke their own document while an admin may revoke any, and
 * `NOT_FOUND_ERROR` rather than a distinct "wrong scope" message.
 *
 * Two revokes racing each other converge harmlessly and need no guard: every
 * write here moves toward the same terminal state regardless of which
 * transaction runs first, and a second revoke arriving after the first has
 * committed simply matches zero rows and updates nothing (the one visible
 * side effect being a client who could receive the courtesy email below
 * twice -- already the class of failure this function tolerates, see the
 * paragraph above, not one worth a claim for).
 *
 * The race that *does* matter is against the client's own outcome. Once
 * `completeSigning`/`declineSigning` exist (a later task, presumably beside
 * `sendQuoteForSignature` in this file or in a sibling `signing-client.ts`),
 * a revoke loaded while the document was still VIEWED can commit *after*
 * the client has completed or declined it. Written unconditionally, this
 * function's own writes would stomp SIGNED (or DECLINED) back to NOT_SENT
 * and -- worse -- the `tx.signature.deleteMany` below would delete the
 * CLIENT signature the client had just legitimately confirmed. The
 * status-guarded `updateMany` claim below is what makes the client's outcome
 * win that race: if the document has already left SENT/VIEWED by the time
 * this transaction runs, the claim matches zero rows, nothing else in the
 * transaction executes, and this call reports the same "no live link"
 * outcome the pre-check would have. Same idiom `sendQuoteForSignature`'s own
 * concurrent-send guard above uses, for the same underlying reason: only a
 * write takes the row lock that orders concurrent callers against each
 * other.
 */
export async function revokeSigningLink(documentId: string): Promise<ActionResult> {
  const session = await requireSession();

  const parsedId = idSchema.safeParse(documentId);
  if (!parsedId.success) return { error: NOT_FOUND_ERROR };

  const document = await db.document.findFirst({
    where: { id: parsedId.data, ...documentWhereForUser(session.user) },
    select: {
      id: true,
      number: true,
      signingStatus: true,
      author: { select: { name: true, email: true, active: true } },
      signingRequests: {
        where: { revokedAt: null },
        select: { id: true, email: true },
      },
    },
  });
  if (!document) return { error: NOT_FOUND_ERROR };
  if (!canRevoke(document.signingStatus)) {
    return { error: NO_LIVE_LINK_TO_REVOKE };
  }

  const recipients = document.signingRequests.map((request) => request.email);

  try {
    await db.$transaction(async (tx) => {
      // Claim the document first, atomically -- see this function's own doc
      // comment for the race this guards against. Ordered before either
      // write below so a lost claim leaves every other row untouched:
      // nothing past this point runs unless this call actually owns the
      // transition.
      const claimed = await tx.document.updateMany({
        where: { id: document.id, signingStatus: { in: REVOCABLE_SIGNING_STATUSES } },
        data: { signingStatus: "NOT_SENT" },
      });
      if (claimed.count === 0) throw new RevokeLostRaceError();

      // Only reached once the claim above has succeeded, so a lost race can
      // never delete a signature the client just confirmed. The client may
      // have drawn a signature without confirming it. Left in place, the
      // next send would open already showing "Signed" with the confirm
      // button enabled, for a client who never saw that quote. The author's
      // signature survives: the document stays FINAL and unchanged, so it is
      // still a signature of exactly this text. Which roles an event clears
      // is decided once, in `signatureRolesClearedBy`, beside the other
      // transition rules -- not re-derived here.
      await tx.signature.deleteMany({
        where: { documentId: document.id, role: { in: signatureRolesClearedBy("revoke") } },
      });

      // Request revocation is bookkeeping layered on the already-claimed
      // status change, so it runs last: it is not what orders concurrent
      // callers against each other -- only a write matched by the
      // status-guarded `where` above (the claim) does that.
      await tx.signingRequest.updateMany({
        where: { documentId: document.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  } catch (error) {
    if (error instanceof RevokeLostRaceError) return { error: NO_LIVE_LINK_TO_REVOKE };
    throw error;
  }

  const mail = buildRevokedEmail({
    quoteNumber: document.number ?? "",
    authorName: document.author.name ?? document.author.email,
    replyTo: resolveReplyTo(document.author, process.env.EMAIL_REPLY_TO),
  });

  // Deliberately outside the transaction that revoked the link, matching
  // `sendQuoteForSignature`: a mail transport call has no place holding a DB
  // transaction open. Unlike that function, nothing here is rolled back on
  // failure -- see the doc comment above for why.
  const transport = createAppMailTransport();
  for (const to of recipients) {
    try {
      const result = await transport.sendMail({
        to,
        from: mailFromAddress(),
        replyTo: mail.replyTo,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      const failed = [...(result.rejected ?? []), ...(result.pending ?? [])].filter(Boolean);
      if (failed.length) throw new Error(`Email (${failed.join(", ")}) could not be sent`);
    } catch (error) {
      console.error("[signing] revocation email failed", error);
    }
  }

  revalidateDocument(document.id);
  return {};
}
