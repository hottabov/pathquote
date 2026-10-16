import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import { auth } from "@/auth";
import { resolveUploadPath } from "@/lib/uploads";
import { ensureDerivative, parseDerivativeWidth } from "@/lib/image-derivatives";

// Needs real filesystem access (fs/promises, fs streams) — not available on
// the edge runtime.
export const runtime = "nodejs";

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/**
 * Streams a previously-uploaded image back to any authenticated user
 * (managers need to see catalog images too, not just admins). The proxy's
 * matcher excludes image-extension paths from its own auth check, so this
 * route re-checks the session itself rather than relying on the proxy.
 *
 * An optional `?w=<width>` asks for a downscaled WebP *thumbnail* of a
 * raster upload instead of the original bytes — see src/lib/image-
 * derivatives.ts. Only the widths in `DERIVATIVE_WIDTHS` are honoured;
 * anything else (including an SVG, or a width whose derivative can't be
 * built) silently serves the original, so a caller never has to branch on
 * the stored file's format. Quotation sheets/PDFs deliberately request the
 * URL *without* `w`, because those go to print at full resolution.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name } = await params;
  const originalPath = resolveUploadPath(name);
  if (!originalPath) {
    return new Response("Not found", { status: 404 });
  }

  const width = parseDerivativeWidth(new URL(request.url).searchParams.get("w"));
  const derivedPath = width === null ? null : await ensureDerivative(name, width);
  const filePath = derivedPath ?? originalPath;

  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const ext = derivedPath ? "webp" : name.slice(name.lastIndexOf(".") + 1);
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(size),
    // Original and derivative alike: the name is the uuid `saveUpload` minted
    // for these bytes and never reuses (src/lib/uploads.ts), so nothing can
    // change under a client -- cache for a year, and tell the browser not to
    // revalidate. The original used to get a day, which cost a builder page
    // its 12-30 image requests again every morning (audit 2026-10-16,
    // PERF-18). `private`: these are behind the session.
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  };
  // SVG is XML that can carry <script>/event-handler content -- sandbox it
  // so a direct navigation to this URL can't execute anything, even though
  // nosniff already stops a browser from reinterpreting it as another type.
  // Embedding via <img> (how icons/logos are actually used) is unaffected:
  // the sandboxed-document restriction only applies to top-level navigation
  // and non-image embeds (e.g. <iframe>/<object>).
  if (ext === "svg") {
    headers["Content-Security-Policy"] = "sandbox";
  }

  return new Response(body, { headers });
}
