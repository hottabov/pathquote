"use server";

import { readFile } from "node:fs/promises";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { revalidateDocument } from "@/lib/revalidate";
import { documentWhereForUser } from "@/lib/scope";
import { IMAGE_URL_PATTERN, resolveUploadPath, saveUpload, UploadValidationError } from "@/lib/uploads";
import { parseSignatureDataUrl } from "@/lib/signing/data-url";
import { NOT_FOUND_ERROR, type ActionResult } from "./_shared";

export type { ActionResult };

/**
 * Applies the author's signature to a FINAL quote.
 *
 * `dataUrl` is either a freshly drawn signature or, when the manager accepts
 * their saved one, the literal string "saved" -- in which case bytes are
 * read from disk (see the saved-signature branch below) and written as a
 * *new* upload. Copying rather than referencing is the whole point: a
 * manager who redraws their saved signature next year must not
 * retroactively change what a customer already signed (see the `imageUrl`
 * doc comment on the `Signature` model in schema.prisma, and
 * tests/signature-freeze.test.ts, which fails the build on any line that
 * would break this guarantee).
 *
 * Scoped and shaped like `finalizeDocument`/`unfinalizeDocument`
 * (src/lib/actions/finalize.ts): `requireSession` for the same
 * redirect-to-login a page-adjacent action wants, `documentWhereForUser` so a
 * manager may only sign their own document while an admin may sign any, and
 * `NOT_FOUND_ERROR` rather than a distinct message for "wrong scope" so a
 * manager can never tell a foreign document from one that doesn't exist.
 */
export async function signQuoteAsAuthor(documentId: string, dataUrl: string): Promise<ActionResult> {
  const session = await requireSession();

  const document = await db.document.findFirst({
    where: { id: documentId, status: "FINAL", ...documentWhereForUser(session.user) },
    select: { id: true, signingStatus: true },
  });
  if (!document) return { error: NOT_FOUND_ERROR };
  if (document.signingStatus !== "NOT_SENT" && document.signingStatus !== "DECLINED") {
    return { error: "This quote can no longer be signed." };
  }

  // `ip`/`userAgent` are never recorded for this role: the author signs
  // inside a session that already identifies them, unlike the client's
  // unauthenticated row (a later task), where those two columns carry the
  // whole audit trail.
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { name: true, email: true, signatureUrl: true },
  });
  if (!user) return { error: NOT_FOUND_ERROR };

  let bytes: Buffer;
  if (dataUrl === "saved") {
    const savedUrl = user.signatureUrl;
    if (!savedUrl) return { error: "You have no saved signature yet." };

    // Validated against IMAGE_URL_PATTERN (src/lib/uploads.ts) instead of a
    // bare `.replace("/api/files/", "")` on the stored value: a `.replace`
    // that finds no match is a silent no-op, so a corrupted or hand-edited
    // column would turn into a filename-shaped string built from whatever
    // was actually stored, rather than being rejected outright. Matching
    // first means a malformed value is refused here, with a message that
    // says so, before anything reaches the filesystem. The pattern is fully
    // anchored (`^...$`), so a successful match's own text is the whole
    // validated string, and slicing the known `/api/files/` prefix off
    // *that* -- rather than off the original, unvalidated value -- is what
    // "extracted from the match" means below.
    const match = savedUrl.match(IMAGE_URL_PATTERN);
    if (!match) return { error: "Your saved signature could not be read." };
    const savedFilename = match[0].slice("/api/files/".length);

    const path = resolveUploadPath(savedFilename);
    if (!path) return { error: "Your saved signature could not be read." };
    bytes = await readFile(path);
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
  // PNG check (parseSignatureDataUrl's magic-number test, or having once
  // been written by saveUpload itself in the "saved" branch above), but
  // saveUpload's own sniffImageType is the actual trust boundary and is free
  // to disagree on a malformed edge case.
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
    update: { imageUrl, signedAt: new Date() },
  });

  revalidateDocument(document.id);
  return {};
}
