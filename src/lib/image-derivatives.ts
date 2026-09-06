import { randomUUID } from "crypto";
import { mkdir, rename, stat, unlink } from "fs/promises";
import path from "path";
import { resolveUploadPath, uploadsDir } from "@/lib/uploads";
import { DERIVATIVE_WIDTHS, type DerivativeWidth } from "@/lib/image-derivative-width";

// Re-exported so every existing import site (this module's own callers, and
// tests/image-derivatives.test.ts) keeps working unchanged — the closed set
// itself now lives in image-derivative-width.ts, the half of this file that
// has no `fs`/`crypto`/`sharp` and is therefore safe for a client component
// (Avatar, CatalogThumb, ...) to import.
export { DERIVATIVE_WIDTHS };
export type { DerivativeWidth };

/**
 * Downscaled, WebP-encoded copies of an uploaded raster image, used by the
 * catalogue *thumbnails* only. The original file is never touched or
 * replaced: it is what the quotation sheet/PDF renders, and that has to stay
 * print-resolution. This module exists purely so a list page showing 40
 * product rows doesn't ship 40 × ~1MB of 1280px PNG.
 *
 * SVG is deliberately out of scope — it is already vector, resolution
 * independent and a few KB, so `derivativeFilename` refuses it and callers
 * serve the original bytes instead.
 */

/** Quality passed to the WebP encoder. 78 is visually lossless at thumbnail
 * scale while cutting a typical 1280×768 product photo to a few KB. */
const WEBP_QUALITY = 78;

/** Parses an untrusted `?w=` query value into one of `DERIVATIVE_WIDTHS`,
 * or `null` for anything else (absent, non-numeric, or a width we don't
 * generate). `null` means "serve the original", never "error". */
export function parseDerivativeWidth(raw: string | null): DerivativeWidth | null {
  if (raw === null) return null;
  const n = Number(raw);
  return (DERIVATIVE_WIDTHS as readonly number[]).includes(n) ? (n as DerivativeWidth) : null;
}

/** Directory the derivatives live in — a subdirectory of the uploads volume
 * so it inherits the same backup/mount story, but separate from the
 * originals so `resolveUploadPath`'s flat `<uuid>.<ext>` namespace (and the
 * `/api/files/<name>` route it guards) can never resolve to one of these. */
export function derivativesDir(): string {
  return path.join(uploadsDir(), "derived");
}

/**
 * The derivative filename for an original upload `name` at `width`, or
 * `null` when `name` has no raster derivative — either it isn't a
 * `saveUpload`-shaped name at all, or it's an SVG (see the module comment).
 *
 * Pure: takes and returns strings, touches no filesystem, so the naming
 * scheme is unit-testable without sharp or a real uploads directory.
 */
export function derivativeFilename(name: string, width: DerivativeWidth): string | null {
  if (resolveUploadPath(name) === null) return null;
  const dot = name.lastIndexOf(".");
  const ext = name.slice(dot + 1);
  if (ext === "svg") return null;
  return `${name.slice(0, dot)}-w${width}.webp`;
}

/**
 * Returns the absolute path of the on-disk WebP derivative of `name` at
 * `width`, generating it on first request, or `null` when `name` has no
 * derivative (see `derivativeFilename`) or its original is missing.
 *
 * Generation is lazy rather than done at upload time so images uploaded
 * before this existed get thumbnails too, with no backfill migration. The
 * cache is keyed by the original's `<uuid>` — `saveUpload` mints a fresh
 * uuid per upload and never overwrites, so a cached derivative can't go
 * stale and callers may serve it as immutable.
 *
 * Concurrent requests for the same missing derivative are safe: each writes
 * its own uuid-suffixed temp file and renames it into place, and rename is
 * atomic on the same filesystem, so the loser's bytes are simply replaced
 * by identical bytes.
 */
export async function ensureDerivative(
  name: string,
  width: DerivativeWidth
): Promise<string | null> {
  const originalPath = resolveUploadPath(name);
  const derivedName = derivativeFilename(name, width);
  if (originalPath === null || derivedName === null) return null;

  const dir = derivativesDir();
  const derivedPath = path.join(dir, derivedName);

  try {
    await stat(derivedPath);
    return derivedPath;
  } catch {
    // Not generated yet — fall through and build it.
  }

  try {
    await stat(originalPath);
  } catch {
    return null; // Original is gone; nothing to derive from.
  }

  await mkdir(dir, { recursive: true });

  // Imported lazily: sharp loads a platform-specific native binary at
  // require time, and nothing else in this module needs it. Keeping the
  // import inside the one function that resizes means the pure helpers
  // above (and their tests) never pay for — or trip over — that.
  const { default: sharp } = await import("sharp");

  const tempPath = path.join(dir, `.tmp-${randomUUID()}.webp`);
  try {
    await sharp(originalPath)
      // Aspect ratio is preserved (only a width is given) and
      // `withoutEnlargement` means an original already narrower than
      // `width` is re-encoded at its own size rather than upscaled.
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toFile(tempPath);
    await rename(tempPath, derivedPath);
  } catch {
    await unlink(tempPath).catch(() => {});
    return null; // Unreadable/corrupt original — caller falls back to it.
  }

  return derivedPath;
}
