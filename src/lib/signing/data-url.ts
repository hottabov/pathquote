/**
 * Turns the `data:image/png;base64,…` string a `SignaturePad` produces into
 * bytes the upload layer can store.
 *
 * This is the trust boundary for a signature: the string arrives from a
 * browser — for the client-facing flow (a later task), an *unauthenticated*
 * browser — so it is validated rather than decoded optimistically. PNG only,
 * because that is the one format the pad emits and the one the sheet needs;
 * allowing SVG here would accept a scriptable document that then gets
 * rendered inside every quote and PDF that carries it (see src/lib/uploads.ts's
 * AVATAR_TYPES / DOCUMENT_LINE_TYPES for the same reasoning applied to other
 * user-supplied images).
 */
const PNG_PREFIX = "data:image/png;base64,";

/** A drawn signature is a few kilobytes. 512 KB is far above any real one
 * and far below anything worth writing to disk unchecked. */
export const MAX_SIGNATURE_BYTES = 512 * 1024;

export type ParsedSignature = { ok: true; bytes: Buffer } | { ok: false };

export function parseSignatureDataUrl(input: string): ParsedSignature {
  if (!input.startsWith(PNG_PREFIX)) return { ok: false };

  const payload = input.slice(PNG_PREFIX.length);
  if (payload.length === 0) return { ok: false };
  // Checked before decoding: base64 is 4/3 the size of its output, so this
  // bounds the allocation rather than discovering the size afterwards. The
  // +4 is slack for padding ("=" / "==") on the final quartet, not a margin
  // for anything larger.
  if (payload.length > Math.ceil((MAX_SIGNATURE_BYTES * 4) / 3) + 4) return { ok: false };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return { ok: false };

  const bytes = Buffer.from(payload, "base64");
  if (bytes.length === 0 || bytes.length > MAX_SIGNATURE_BYTES) return { ok: false };

  // Confirm the declared type against the actual bytes, not the label. The
  // full 8-byte PNG signature (not just the first four), matching
  // sniffImageType's check in src/lib/uploads.ts — saveUpload throws
  // UploadValidationError on anything this accepted but that check didn't.
  const isPng =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  if (!isPng) return { ok: false };

  return { ok: true, bytes };
}
