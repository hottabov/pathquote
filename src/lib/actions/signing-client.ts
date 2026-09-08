"use server";

/**
 * Everything a visitor holding a signing token — and nothing else — may do:
 * draw a signature, confirm it, or decline. There is no session here and
 * there must never be one: this module is reachable from the public `/sign`
 * route (see src/app/(sign)/layout.tsx's own doc comment on why that route
 * group calls no `auth()`), so every export re-resolves the token itself via
 * `loadLiveRequest` rather than trusting a documentId, a role, or anything
 * else the client claims.
 *
 * Every refusal below returns the identical `UNAVAILABLE` string. A visitor
 * poking at a dead or foreign token must learn nothing about whether a live
 * one exists for someone else — the same reasoning `LinkProblem` (src/
 * components/signing/link-problem.tsx) already applies to the page itself.
 */
import { mkdir, writeFile, unlink } from "fs/promises";
import path from "path";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { uploadsDir, saveUpload, UploadValidationError, IMAGE_URL_PATTERN, resolveUploadPath } from "@/lib/uploads";
import { parseSignatureDataUrl } from "@/lib/signing/data-url";
import { hashSigningToken } from "@/lib/signing/token";
import { resolveLinkState } from "@/lib/signing/link";
import { canComplete, canDecline, signatureRolesClearedBy, type SigningStatus } from "@/lib/signing/state";
import { sha256Hex, signedPdfFilename } from "@/lib/signing/archive";
import { getDocumentForSigning, type DocumentForSigning } from "@/lib/queries/signing";
import { getQuoteDocumentsForRegion } from "@/lib/queries/quote-documents";
import { buildQuotationData } from "@/lib/quotation-data";
import { renderQuotationHtml, htmlToPdf, fileImageResolver, buildFooterHtml } from "@/lib/pdf";
import { buildCompletionEmailForClient, buildCompletionEmailForAuthor } from "@/lib/email/signing";
import { resolveReplyTo } from "@/lib/email/reply-to";
import { createAppMailTransport, mailFromAddress } from "@/lib/email/transport";
import type { ActionResult } from "./_shared";

export type { ActionResult };

/** The one message every access refusal on this route returns — see this
 * file's header comment for why it must never vary by reason. */
const UNAVAILABLE = "This quote is no longer available for signing.";

/**
 * Returned only when a *legitimate, in-flight* completion attempt fails for
 * an operational reason (Gotenberg is down, the archive write failed) —
 * never for an invalid or dead token, which always gets `UNAVAILABLE`
 * above. Distinct wording is safe here specifically because, by the time
 * this can be returned, `loadLiveRequest` has already proven the token is
 * live: there is nothing left to leak. Matches invariant #2 in the design:
 * the PDF renders before any row is touched, so a caller seeing this message
 * is guaranteed nothing changed and a retry is meaningful.
 */
const COULD_NOT_COMPLETE = "This quote couldn't be completed. Nothing has changed — please try again.";

/** Every value `SigningStatus` can hold, used below to derive the exact
 * status sets `canComplete`/`canDecline` (src/lib/signing/state.ts) permit a
 * transition from — the same "ask the rule, don't repeat it" convention
 * `sendQuoteForSignature`/`revokeSigningLink` already use for
 * `SENDABLE_SIGNING_STATUSES`/`REVOCABLE_SIGNING_STATUSES`
 * (src/lib/actions/signing.ts). */
const ALL_SIGNING_STATUSES: SigningStatus[] = ["NOT_SENT", "SENT", "VIEWED", "SIGNED", "DECLINED"];
const COMPLETABLE_SIGNING_STATUSES: SigningStatus[] = ALL_SIGNING_STATUSES.filter((status) =>
  canComplete(status, true)
);
const DECLINABLE_SIGNING_STATUSES: SigningStatus[] = ALL_SIGNING_STATUSES.filter(canDecline);

/**
 * Best-effort delete of the file behind a CLIENT signature's superseded
 * `imageUrl`, called only from `signAsClient` below, only after the upsert
 * that repointed the row has committed. Resolves the stored value the same
 * validated way `readSavedSignatureBytes` (src/lib/signing/saved-signature.ts)
 * does: match against `IMAGE_URL_PATTERN`, slice the matched text's own
 * `/api/files/` prefix, and hand the remainder to `resolveUploadPath` --
 * rather than a bare string-slice on the raw column value, so a malformed or
 * hand-edited value is skipped instead of being turned into a path fragment
 * `path.join` would otherwise accept.
 *
 * Never throws and never changes what its caller returns: a redraw that
 * successfully repointed the row must not fail, or appear to fail, because
 * the old file was already gone, sitting on a different volume, or hit a
 * permissions error. A failure here is logged and otherwise swallowed --
 * matching how this codebase already treats best-effort filesystem cleanup
 * (`clearMySignature`'s revalidation, the orphan-tolerant reasoning `saveUpload`
 * itself documents), even though, unlike `clearMySignature`
 * (src/lib/actions/users.ts), this delete is not itself optional: a saved
 * profile signature may already have been *copied* onto one or more issued
 * quotes (`signQuoteAsAuthor`, src/lib/actions/signing.ts) by the time it's
 * cleared, so `clearMySignature` keeps its file because it has no way to know
 * whether anything still points at it. A CLIENT signature is never copied
 * anywhere -- this document's row is its only referent -- and that referent
 * just moved, so the old file is unreachable the moment the upsert commits.
 */
async function deleteSupersededClientImage(imageUrl: string): Promise<void> {
  const match = imageUrl.match(IMAGE_URL_PATTERN);
  if (!match) {
    console.error("[signing] superseded CLIENT signature has a malformed imageUrl, skipping delete", imageUrl);
    return;
  }
  const filename = match[0].slice("/api/files/".length);
  const filePath = resolveUploadPath(filename);
  if (!filePath) {
    console.error("[signing] could not resolve path for superseded CLIENT signature, skipping delete", imageUrl);
    return;
  }
  try {
    await unlink(filePath);
  } catch (error) {
    console.error("[signing] failed to delete superseded CLIENT signature file", filePath, error);
  }
}

/** Thrown inside a `$transaction` below when its status-guarded claim
 * matches nothing — another request (a second tab, a double-tap, a manager's
 * concurrent revoke) already moved the document out of the status this call
 * observed a moment earlier in `loadLiveRequest`. Caught outside the
 * transaction and mapped to `UNAVAILABLE`, exactly like
 * `AlreadyClaimedError`/`RevokeLostRaceError` in src/lib/actions/signing.ts. */
class LostRaceError extends Error {}

/** First `x-forwarded-for` hop, or `null` behind a proxy that strips it.
 * Shared by every write below that records who was on the other end of an
 * unauthenticated request — see `Signature.ip`'s own doc comment on why that
 * column stays nullable rather than blocking a signature on a missing
 * header. */
function clientIp(head: Headers): string | null {
  return (
    head
      .get("x-forwarded-for")
      ?.split(",")[0]
      ?.trim() || null
  );
}

type LiveSigningRequest = {
  requestId: string;
  documentId: string;
  /** `SigningRequest.email` — the address the invite was actually sent to,
   * frozen at send time. Used (not `Contact.email`, which is nullable and
   * can change) as both the CLIENT signature's `signerEmail` and the
   * completion email's recipient, so a contact record edited after the
   * invite went out can never redirect where the signed copy is sent. */
  email: string;
  signerName: string;
  signingStatus: SigningStatus;
  hasClientSignature: boolean;
  /** The full safe-to-show document (see `getDocumentForSigning`'s own doc
   * comment on why this is the one document read this whole route may make)
   * — reused by `renderSignedPdf` below so the archived PDF comes from the
   * exact same query the client's page and PDF route already render from,
   * rather than a second, differently-scoped read. */
  document: DocumentForSigning["document"];
};

/**
 * Re-resolves `token` from scratch: hashes it, loads the document it names,
 * and returns `null` unless `resolveLinkState` says the link is currently
 * `live`. This is the one gate every export below goes through — nothing in
 * this module ever branches on a `documentId` or a status the *client*
 * supplied, only on what this fresh read says right now.
 *
 * `signerName` falls back to the email address when the linked `Contact` has
 * been deleted (`SigningRequest.contactId` is `onDelete: SetNull` — see its
 * own doc comment in prisma/schema.prisma) or has no first name recorded,
 * matching the `[firstName, lastName].filter(Boolean).join(" ")` convention
 * used throughout (see `contactFullName`, src/lib/sheet-data.ts).
 */
async function loadLiveRequest(token: string): Promise<LiveSigningRequest | null> {
  const found = await getDocumentForSigning(hashSigningToken(token));
  if (!found) return null;

  const state = resolveLinkState({
    expiresAt: found.expiresAt,
    revokedAt: found.revokedAt,
    declinedAt: found.declinedAt,
    signingStatus: found.document.signingStatus,
    now: new Date(),
  });
  if (state.kind !== "live") return null;

  const signerName =
    found.contact && [found.contact.firstName, found.contact.lastName].filter(Boolean).join(" ").trim()
      ? [found.contact.firstName, found.contact.lastName].filter(Boolean).join(" ")
      : found.email;

  return {
    requestId: found.id,
    documentId: found.document.id,
    email: found.email,
    signerName,
    signingStatus: found.document.signingStatus,
    hasClientSignature: found.document.signatures.some((s) => s.role === "CLIENT"),
    document: found.document,
  };
}

/**
 * Stores the client's drawn signature. Does NOT complete the quote: the
 * signature exists first, and the separate confirmation (`completeSigning`
 * below) commits it. That gap is the window in which a client may redraw,
 * or decline, having changed their mind — the thing DocuSign has no
 * equivalent of (see the design doc's D7).
 *
 * A redraw is an upsert on the same `[documentId, role]` row, not a second
 * row: `Signature`'s own `@@unique([documentId, role])` constraint makes
 * that the only option, and it's also the right one — there is exactly one
 * CLIENT signature per document, current by definition.
 */
export async function signAsClient(token: string, dataUrl: string): Promise<ActionResult> {
  const request = await loadLiveRequest(token);
  if (!request) return { error: UNAVAILABLE };

  const parsed = parseSignatureDataUrl(dataUrl);
  if (!parsed.ok) return { error: "That signature could not be read. Please draw it again." };

  const file = new File([new Uint8Array(parsed.bytes)], "signature.png", { type: "image/png" });

  // saveUpload returns a bare filename, never a URL (see its own doc comment
  // in src/lib/uploads.ts) — every caller builds the `/api/files/<name>` URL
  // itself, exactly as `signQuoteAsAuthor` (src/lib/actions/signing.ts) does
  // for the author's own signature.
  let filename: string;
  try {
    filename = await saveUpload(file, ["png"]);
  } catch (error) {
    if (error instanceof UploadValidationError) return { error: error.message };
    throw error;
  }
  const imageUrl = `/api/files/${filename}`;

  const head = await headers();
  const ip = clientIp(head);
  const userAgent = head.get("user-agent");

  // Read the row's *current* image before the upsert below repoints it --
  // never after. Reading first means a write that fails for any reason
  // leaves both the old row and the old file untouched; the delete below
  // only ever runs once the replacement has actually committed, so a failed
  // write can never leave a row pointing at a file this call already
  // removed. Scoped to CLIENT only -- an AUTHOR signature (a separate row,
  // written only by `signQuoteAsAuthor`, src/lib/actions/signing.ts) is never
  // read or touched by this query.
  const outgoing = await db.signature.findUnique({
    where: { documentId_role: { documentId: request.documentId, role: "CLIENT" } },
    select: { imageUrl: true },
  });

  await db.signature.upsert({
    where: { documentId_role: { documentId: request.documentId, role: "CLIENT" } },
    create: {
      documentId: request.documentId,
      role: "CLIENT",
      imageUrl,
      signerName: request.signerName,
      signerEmail: request.email,
      ip,
      userAgent,
    },
    // A redraw refreshes every captured field, not just the image -- an old
    // ip/userAgent sitting next to a brand-new signature would misattribute
    // who actually drew it.
    update: {
      imageUrl,
      signerName: request.signerName,
      signerEmail: request.email,
      signedAt: new Date(),
      ip,
      userAgent,
    },
  });

  // Nothing bounds how many times an unauthenticated visitor holding one
  // valid, unrevoked token can redraw -- `saveUpload` above always writes a
  // fresh randomly-named file, and without this, the upsert's repoint would
  // leave the previous one behind forever. `outgoing` is `null` the first
  // time a CLIENT signs (nothing to delete yet); on every redraw after that
  // it names exactly the file this upsert just stopped pointing at, deleted
  // only now that the replacement is committed (see `deleteSupersededClientImage`'s
  // own doc comment for why this differs from `clearMySignature`).
  if (outgoing?.imageUrl) {
    await deleteSupersededClientImage(outgoing.imageUrl);
  }

  revalidatePath(`/sign/${token}`);
  return {};
}

/**
 * Renders the archived PDF from the exact same data the client's own page
 * renders from (`getDocumentForSigning` → `buildQuotationData` →
 * `renderQuotationHtml`), so the bytes written to disk here are what the
 * client was just looking at, signature included — not a second,
 * independently-assembled document that happens to show the same numbers.
 *
 * This is the same three-call pipeline
 * `/api/quotes/[documentId]/quotation-pdf/route.ts` uses for the
 * *authenticated* download (`buildQuotationData` with `fileImageResolver`,
 * `renderQuotationHtml`, `htmlToPdf` with `buildFooterHtml`) — reused rather
 * than re-implemented so a manager who later opens that route on this same
 * FINAL, SIGNED document gets back the identical bytes this function
 * archived. The one deliberate difference is the document read: that route
 * calls `getDocumentForBuilder` (session-scoped, commission fields
 * included), which this unauthenticated action must never touch (see
 * `getDocumentForSigning`'s own header comment) — `renderSignedPdf` is
 * therefore handed the already-fetched, commission-free document that
 * `loadLiveRequest` read a moment earlier, rather than re-deriving a
 * document from a bare id the way the plan's own sketch of this helper was
 * named (`renderSignedPdf(documentId)`). There is no unauthenticated-safe
 * query by documentId to call instead — `getDocumentForSigning` only takes a
 * token hash — so threading the already-verified document through is the
 * correct fix, not a shortcut.
 */
async function renderSignedPdf(document: DocumentForSigning["document"]): Promise<Buffer> {
  const quoteDocuments = await getQuoteDocumentsForRegion(document.regionId);
  const data = buildQuotationData(document, quoteDocuments, { resolveImage: fileImageResolver });
  const html = await renderQuotationHtml(data);
  return htmlToPdf(html, buildFooterHtml(document.number));
}

/**
 * The point of no return.
 *
 * The PDF is rendered BEFORE the transaction opens (invariant #2 of the
 * design): it is a network call to Gotenberg and has no business holding a
 * database transaction open while Chromium rasterizes a page. If it throws,
 * the transaction never starts — the quote stays exactly as it was (VIEWED
 * or SENT, signature intact) and `COULD_NOT_COMPLETE` tells the client a
 * retry is meaningful, because nothing happened yet.
 *
 * Completion itself is a status-guarded `updateMany`
 * (`COMPLETABLE_SIGNING_STATUSES`), the same idiom `sendQuoteForSignature`
 * and `revokeSigningLink` (src/lib/actions/signing.ts) use for exactly this
 * reason: only a write takes the row lock that orders concurrent callers, so
 * a second tab or a double-tap that loses the race is told nothing changed
 * (`UNAVAILABLE`) rather than silently producing a second archived PDF and
 * overwriting `signedPdfName`/`signedPdfSha256` with different bytes.
 *
 * The emails are sent AFTER the transaction commits (invariant #3), and each
 * is wrapped in its own try/catch inside `sendCompletionEmails` — the client
 * pressed the button and the quote IS signed by the time either send is
 * attempted, so a mail failure is logged loudly (the swallowed-failure trap
 * documented in docs/email-sending-setup.md) rather than rolled back into a
 * lie in the other direction.
 */
export async function completeSigning(token: string): Promise<ActionResult> {
  const request = await loadLiveRequest(token);
  if (!request) return { error: UNAVAILABLE };
  if (!canComplete(request.signingStatus, request.hasClientSignature)) {
    return { error: UNAVAILABLE };
  }

  let pdf: Buffer;
  try {
    pdf = await renderSignedPdf(request.document);
  } catch (error) {
    console.error("[signing] archived PDF render failed", error);
    return { error: COULD_NOT_COMPLETE };
  }

  const name = signedPdfFilename();
  // Mirrors saveUpload's own mkdir -- this write bypasses saveUpload (the
  // bytes are a PDF, not one of its accepted image types), so it takes on
  // that same "the directory may not exist yet" responsibility itself.
  // Captured in its own local rather than re-joined later: the catch below
  // must delete exactly the file this call just wrote, never a path
  // re-derived from `name` or from anything else.
  const filePath = path.join(/* turbopackIgnore: true */ uploadsDir(), name);
  await mkdir(uploadsDir(), { recursive: true });
  await writeFile(filePath, pdf);

  // A second tab, or a double-tap on a phone, that loses the claim below
  // lands here having already written an archived PDF nobody will ever point
  // to. Rendering and writing before the claim is still correct -- refusing
  // to write until *after* the claim would mean holding the transaction open
  // across the Gotenberg call this function exists to keep out of it -- but
  // the orphan that ordering can produce is no longer left behind: the catch
  // below deletes `filePath`, the exact local path just written above, the
  // moment the claim comes back empty.
  try {
    await db.$transaction(async (tx) => {
      const result = await tx.document.updateMany({
        where: { id: request.documentId, signingStatus: { in: COMPLETABLE_SIGNING_STATUSES } },
        data: {
          signingStatus: "SIGNED",
          signedPdfName: name,
          signedPdfSha256: sha256Hex(pdf),
          completedAt: new Date(),
        },
      });
      if (result.count === 0) throw new LostRaceError();
    });
  } catch (error) {
    if (error instanceof LostRaceError) {
      // No row was ever updated to point at `name`, so the PDF this call
      // just rendered and wrote is referenced by nothing -- best-effort
      // delete it rather than leave a permanent orphan. Never lets a
      // filesystem failure change what the client is told: logged and
      // swallowed, exactly like `deleteSupersededClientImage` above.
      //
      // This closes the ordinary races this function was built to survive
      // (a stray double-tap, two open tabs) but not a determined holder of
      // one live token calling this repeatedly -- each such call still
      // renders a fresh PDF via Gotenberg before losing its own claim, so
      // repeated Gotenberg load is an operational concern (rate limiting,
      // e.g.) this function cannot solve alone.
      try {
        await unlink(filePath);
      } catch (unlinkError) {
        console.error("[signing] failed to delete orphaned PDF after lost completion race", filePath, unlinkError);
      }
      return { error: UNAVAILABLE };
    }
    throw error;
  }

  await sendCompletionEmails({
    documentId: request.documentId,
    clientEmail: request.email,
    clientName: request.signerName,
    pdf,
  });

  revalidatePath(`/sign/${token}`);
  return {};
}

/**
 * The client saying no. Available right up to completion — including after
 * they have drawn a signature, which commits them to nothing (`canDecline`,
 * src/lib/signing/state.ts) — and, like completion, guarded by a
 * status-guarded `updateMany` rather than an unconditional write.
 *
 * That guard matters more here than it looks: without it, a decline that
 * merely lost a race against a `completeSigning` which had *already
 * committed* would silently overwrite `signingStatus` from `SIGNED` back to
 * `DECLINED` — corrupting a completed quote's status because of a stale
 * tab. The claim below makes the earlier write win: once the document has
 * left SENT/VIEWED, this call's `updateMany` matches nothing and the whole
 * transaction aborts before the `SigningRequest` bookkeeping runs.
 *
 * The CLIENT `Signature` row (if the client drew one before changing their
 * mind) is deleted as part of declining, not kept around. Reasoning mirrors
 * `signatureRolesClearedBy`'s own comment on the "revoke" case
 * (src/lib/signing/state.ts): `canSendToClient` allows resending straight
 * from DECLINED, and a surviving CLIENT row would make that resend's page
 * open already showing "Signed" with Send enabled, for a document the
 * client — this time around — never actually looked at.
 */
export async function declineSigning(token: string, reason: string): Promise<ActionResult> {
  const request = await loadLiveRequest(token);
  if (!request) return { error: UNAVAILABLE };
  if (!canDecline(request.signingStatus)) return { error: UNAVAILABLE };

  const head = await headers();
  const declineIp = clientIp(head);
  const declineReason = reason.trim().slice(0, 2000) || null;

  try {
    await db.$transaction(async (tx) => {
      const claimed = await tx.document.updateMany({
        where: { id: request.documentId, signingStatus: { in: DECLINABLE_SIGNING_STATUSES } },
        data: { signingStatus: "DECLINED" },
      });
      if (claimed.count === 0) throw new LostRaceError();

      await tx.signature.deleteMany({
        where: { documentId: request.documentId, role: { in: signatureRolesClearedBy("revoke") } },
      });

      await tx.signingRequest.update({
        where: { id: request.requestId },
        data: { declinedAt: new Date(), declineReason, declineIp },
      });
    });
  } catch (error) {
    if (error instanceof LostRaceError) return { error: UNAVAILABLE };
    throw error;
  }

  revalidatePath(`/sign/${token}`);
  return {};
}

// --- completion emails -------------------------------------------------

/**
 * Sends the two completion emails — to the client (with the archived PDF
 * attached) and to the document's author (a link back into the app) — after
 * `completeSigning`'s transaction has already committed. Each is wrapped in
 * its own try/catch and logged loudly on failure rather than surfaced or
 * rolled back: the quote IS signed by the time this runs, so a mail problem
 * here is an operational incident (see docs/email-sending-setup.md for the
 * cost of getting that ordering backwards), never a reason to tell the
 * client their completion failed.
 *
 * Takes `documentId` per the plan's own sketch, but re-reads only the
 * handful of fields these two templates need (`buildCompletionEmailForClient`
 * / `buildCompletionEmailForAuthor`, src/lib/email/signing.ts) rather than
 * the whole signing-safe document `completeSigning` already holds — this
 * query is never shown to the client, so it's free to select
 * `author.active` (needed by `resolveReplyTo`) and anything else, the exact
 * column `getDocumentForSigning` deliberately omits because that one IS
 * client-facing.
 *
 * `clientEmail`/`clientName` come from the caller's already-resolved
 * `SigningRequest` (frozen at send time — see `LiveSigningRequest.email`'s
 * own comment) rather than from `Contact`, whose email is nullable and can
 * have changed since the invite went out.
 */
async function sendCompletionEmails(input: {
  documentId: string;
  clientEmail: string;
  clientName: string;
  pdf: Buffer;
}): Promise<void> {
  const document = await db.document.findUnique({
    where: { id: input.documentId },
    select: {
      number: true,
      region: { select: { entityName: true } },
      author: { select: { name: true, email: true, active: true } },
      company: { select: { name: true } },
    },
  });
  if (!document) {
    // Cannot happen in practice -- completeSigning just committed a write to
    // this exact row inside the same request -- but this function has no
    // business throwing out of a call site that treats mail as best-effort.
    console.error("[signing] completion email failed: document vanished after commit", input.documentId);
    return;
  }

  const quoteNumber = document.number ?? "";
  const entityName = document.region.entityName;
  const authorName = document.author.name ?? document.author.email;
  const companyName = document.company?.name ?? "";
  const replyTo = resolveReplyTo(document.author, process.env.EMAIL_REPLY_TO);

  const transport = createAppMailTransport();

  try {
    const mail = buildCompletionEmailForClient({ quoteNumber, entityName, authorName, replyTo });
    const result = await transport.sendMail({
      to: input.clientEmail,
      from: mailFromAddress(),
      replyTo: mail.replyTo,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      attachments: [
        {
          filename: `${quoteNumber || "quotation"}-signed.pdf`,
          content: input.pdf,
          contentType: "application/pdf",
        },
      ],
    });
    const failed = [...(result.rejected ?? []), ...(result.pending ?? [])].filter(Boolean);
    if (failed.length) throw new Error(`Email (${failed.join(", ")}) could not be sent`);
  } catch (error) {
    console.error("[signing] completion email failed (client)", error);
  }

  // No AUTH_URL, no valid link to send -- logged and skipped rather than
  // mailing the author a message whose one call to action is a dead "/quotes/
  // undefined" URL. Deliberately not the same up-front, request-refusing
  // check `resolveSigningBaseUrl` (src/lib/actions/signing.ts) does for the
  // invite email: that guard exists to stop a token/row/send from being
  // created at all when the link would be dead. By the time this runs the
  // quote is already signed, so misconfiguration here can only cost this one
  // notification, not the completion itself.
  const rawAuthUrl = process.env.AUTH_URL?.trim();
  if (!rawAuthUrl) {
    console.error("[signing] completion email to author skipped: AUTH_URL is not set");
  } else {
    try {
      const authUrl = rawAuthUrl.replace(/\/+$/, "");
      const mail = buildCompletionEmailForAuthor({
        quoteNumber,
        clientName: input.clientName,
        companyName,
        documentUrl: `${authUrl}/quotes/${input.documentId}`,
      });
      const result = await transport.sendMail({
        to: document.author.email,
        from: mailFromAddress(),
        replyTo: mail.replyTo,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      const failed = [...(result.rejected ?? []), ...(result.pending ?? [])].filter(Boolean);
      if (failed.length) throw new Error(`Email (${failed.join(", ")}) could not be sent`);
    } catch (error) {
      console.error("[signing] completion email failed (author)", error);
    }
  }
}
