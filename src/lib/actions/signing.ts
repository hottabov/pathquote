"use server";

import { db } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { revalidateDocument } from "@/lib/revalidate";
import { documentWhereForUser } from "@/lib/scope";
import { idSchema } from "@/lib/validation/documents";
import { saveUpload, UploadValidationError } from "@/lib/uploads";
import { parseSignatureDataUrl } from "@/lib/signing/data-url";
import { canAuthorSign } from "@/lib/signing/state";
import { readMySavedSignatureBytes } from "@/lib/signing/saved-signature";
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
