import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

/** Accepted upload content types, mapped to the extension we store them
 * under. Anything else is rejected. SVG is accepted for icons/logos (vector
 * source art) alongside the raster formats used for real photos — see
 * `sniffImageType` for how its content is verified. */
export const ALLOWED: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/** Maximum accepted upload size, in bytes. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB

/** Extensions a catalogue image may use. SVG is here because catalogue art is
 * vector source; it is deliberately absent from DOCUMENT_LINE_TYPES. */
export const CATALOG_TYPES = ["jpg", "png", "webp", "svg"] as const;

/** Extensions a salesperson may attach to a line on their own document. SVG is
 * XML and can carry script, so a non-admin uploader is restricted to raster. */
export const DOCUMENT_LINE_TYPES = ["jpg", "png", "webp"] as const;

/** Extensions a user avatar (`User.image` — see src/lib/queries/documents.ts
 * for the read-side reuse note) may use. SVG is deliberately excluded here
 * too, for the same reason as `DOCUMENT_LINE_TYPES`: an avatar is displayed
 * to *other* users inside the admin UI (the users list/edit pages, the
 * dashboard greeting), so accepting SVG would let an uploader's script run
 * in someone else's browser the next time their avatar is rendered. */
export const AVATAR_TYPES = ["jpg", "png", "webp"] as const;

/** Extensions the quotation's setup image (`Document.heroImageUrl`) may use.
 * Uploaded from the builder by any authenticated user (not admin-gated —
 * same permission level as `DOCUMENT_LINE_TYPES`), so SVG is excluded for
 * the same reason: it's XML and can carry script, and unlike a catalogue
 * image (admin-only) this uploader isn't a trusted role. */
export const DOCUMENT_HERO_TYPES = ["jpg", "png", "webp"] as const;

/** Extensions a `SpecImage` diagram (e.g. the screen-side "+Y"/"-Y"
 * illustrations — see the model's own doc comment in schema.prisma) may use.
 *
 * SVG is allowed here, unlike for avatars, quote-line photos and the hero
 * image. Those three are uploaded by any signed-in user, so an SVG's ability
 * to carry script would put a manager's file in front of other people's
 * browsers. This purpose is ADMIN/DEVELOPER-only (see the route's
 * `PURPOSE_CONFIG`) — the same trust level as `CATALOG_TYPES`, which has
 * always accepted SVG for the same reason.
 *
 * A spec diagram is line art of a machine, drawn once and reproduced at 96px
 * in the builder and at print resolution on the order forms. That is exactly
 * what vector is for: one file that stays sharp in both places rather than a
 * raster picked to suit whichever surface mattered more. */
export const SPEC_IMAGE_TYPES = ["jpg", "png", "webp", "svg"] as const;

export type UploadPurpose = "catalog" | "document-line" | "avatar" | "document-hero" | "spec-image";

/** A validation failure `saveUpload` can throw — wrong type or too large.
 * Callers (the /api/uploads route) turn this into a 400 with `.message`. */
export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadValidationError";
  }
}

/** Throws when `ext` isn't in `allowed` — the purpose-scoped counterpart to
 * `ALLOWED`'s declared-MIME check. `saveUpload` calls this with the
 * *sniffed* extension (see `sniffImageType`), not the declared MIME type, so
 * the restriction is enforced where the real bytes are known and can't be
 * bypassed by a crafted `Content-Type`. */
export function assertAllowedType(ext: string, allowed: readonly string[]): void {
  if (!allowed.includes(ext)) {
    throw new UploadValidationError(`File type .${ext} is not allowed here`);
  }
}

/**
 * Sniffs the first few bytes of a buffer against the known magic numbers for
 * the three formats we accept, returning the matching `ALLOWED` extension
 * (`"jpg"` / `"png"` / `"webp"`) or `null` if none match. This is a defense
 * against a caller sending a file whose declared `Content-Type` doesn't
 * match its actual bytes (e.g. an HTML/SVG/script payload relabeled as
 * `image/png` to get past the MIME check and later be served back with a
 * browser-guessed content type) — `saveUpload` calls this after the
 * declared-type check and rejects on mismatch. Pure and dependency-free so
 * it's trivially unit-testable with small constructed buffers.
 */
export function sniffImageType(buf: Buffer): "jpg" | "png" | "webp" | "svg" | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "jpg";
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "png";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  // SVG has no magic bytes -- it's XML text. Strip a leading UTF-8 BOM (if
  // any) and leading whitespace, then check whether what's left starts with
  // an XML prolog or an `<svg` root element. This is intentionally strict
  // (no general "looks like XML" check) since anything broader would let an
  // arbitrary HTML/script payload through as a fake image.
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    start = 3; // UTF-8 BOM
  }
  const text = buf.toString("utf8", start).replace(/^\s+/, "").slice(0, 256).toLowerCase();
  if (text.startsWith("<?xml") || text.startsWith("<svg")) {
    return "svg";
  }
  return null;
}

/** Filenames we write and serve look like `<uuid>.<ext>` — this is also
 * the shape `resolveUploadPath` requires before touching the filesystem, so
 * a path-traversal attempt (`../x`, `a/b.jpg`) or an unexpected extension
 * never reaches `path.join`. */
const UPLOAD_FILENAME_PATTERN = /^[a-f0-9-]{36}\.(jpg|png|webp|svg)$/;

/** The `/api/files/<name>` URL shape stored on `Product.imageUrl` /
 * `Option.imageUrl`. Exported so the catalog server actions and this
 * module's tests validate against the exact same pattern. */
export const IMAGE_URL_PATTERN = /^\/api\/files\/[a-f0-9-]{36}\.(jpg|png|webp|svg)$/;

/** Directory uploads are written to and served from. */
export function uploadsDir(): string {
  return process.env.UPLOADS_DIR ?? path.join(process.cwd(), "data/uploads");
}

/**
 * Validates and persists an uploaded file to `uploadsDir()` under a fresh
 * random name, returning just the filename (not a full URL — callers build
 * the `/api/files/<name>` URL themselves). `allowed` is the caller's
 * purpose-scoped extension set (`CATALOG_TYPES` or `DOCUMENT_LINE_TYPES`) —
 * checked against the *sniffed* extension after the declared-type/sniff
 * match below, so a crafted `Content-Type` can never widen what's actually
 * accepted.
 */
export async function saveUpload(file: File, allowed: readonly string[]): Promise<string> {
  const ext = ALLOWED[file.type];
  if (!ext) {
    throw new UploadValidationError(
      `Unsupported file type "${file.type || "unknown"}". Allowed types: JPEG, PNG, WebP, SVG.`
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new UploadValidationError("File is too large. Maximum size is 5MB.");
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // The declared Content-Type is client-supplied and trivially spoofable —
  // confirm the bytes actually are what they claim to be before writing
  // anything to disk or letting the extension (and therefore the
  // Content-Type this file is later served back with) be decided by it.
  const sniffed = sniffImageType(buffer);
  if (sniffed !== ext) {
    throw new UploadValidationError(
      "File content doesn't match its declared type. Upload a genuine JPEG, PNG, WebP, or SVG image."
    );
  }

  // Purpose-scoped restriction (e.g. a document-line upload rejecting SVG)
  // — enforced on `sniffed`, the verified real extension, never on the
  // caller-declared MIME type.
  assertAllowedType(sniffed, allowed);

  const dir = uploadsDir();
  await mkdir(dir, { recursive: true });

  const filename = `${randomUUID()}.${ext}`;
  // `dir` comes from UPLOADS_DIR (an external volume, e.g. /data/uploads on
  // the VPS) rather than a path under the project — tell Turbopack not to
  // trace it, or the whole project (including public/) gets bundled into
  // the server output. See the build warning this silences.
  await writeFile(path.join(/* turbopackIgnore: true */ dir, filename), buffer);

  return filename;
}

/**
 * Resolves an untrusted `name` (e.g. the `[name]` route param) to an
 * absolute path under `uploadsDir()`, or `null` if it doesn't look like a
 * name `saveUpload` could have produced — this is the only guard against
 * path traversal, so it must run before any filesystem call.
 */
export function resolveUploadPath(name: string): string | null {
  if (!UPLOAD_FILENAME_PATTERN.test(name)) return null;
  return path.resolve(uploadsDir(), name);
}

/** The archived signed quotes `completeSigning` writes
 * (src/lib/actions/signing-client.ts) and the client's own PDF route
 * (src/app/(sign)/sign/[token]/pdf/route.ts) streams back byte-for-byte. A
 * separate pattern from `UPLOAD_FILENAME_PATTERN`/`IMAGE_URL_PATTERN` rather
 * than a widened one: every other caller of `resolveUploadPath` serves its
 * result as an image, and a `.pdf` slipping through there would be served
 * with the wrong `Content-Type` at best. Same uuid shape as those. */
export const SIGNED_PDF_NAME_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pdf$/;

/**
 * `resolveUploadPath`'s counterpart for the archived signed-quote PDFs (see
 * `SIGNED_PDF_NAME_PATTERN`). Same shape as `resolveUploadPath` on purpose —
 * one `.test()` against an anchored pattern that forbids `/` and `..`,
 * followed by `path.resolve` — rather than adding a `startsWith` containment
 * check on top: `resolveUploadPath` itself has never needed one, because an
 * anchored pattern with no separator characters in its alphabet cannot
 * produce a traversal no matter what `path.resolve` does with it. Adding a
 * second idiom here would suggest the regex alone isn't trusted, when it is
 * the only guard its sibling relies on.
 */
export function resolveSignedPdfPath(name: string): string | null {
  if (!SIGNED_PDF_NAME_PATTERN.test(name)) return null;
  return path.resolve(uploadsDir(), name);
}
