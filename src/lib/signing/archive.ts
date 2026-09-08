/**
 * Naming and digesting the archived signed PDF. Pure, so both halves of the
 * "these bytes are what the client saw" claim are testable without touching
 * a disk.
 */
import { createHash, randomUUID } from "node:crypto";

/** The digest stored in `Document.signedPdfSha256`. Not a security control
 * -- nobody untrusted can write to the uploads directory -- but the thing
 * that turns "here is a PDF" into "here is the PDF, and here is how you
 * check nothing has touched it since". */
export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A random name, matching the uuid shape `saveUpload` already writes, so
 * the archived PDFs sit alongside uploads without a second naming scheme.
 * The document number is deliberately NOT in the filename: it would put a
 * customer-identifying string on disk for no gain, and the mapping already
 * lives in `Document.signedPdfName`. */
export function signedPdfFilename(): string {
  return `${randomUUID()}.pdf`;
}
