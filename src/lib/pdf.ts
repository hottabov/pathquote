// Server-only: HTML rendering + Gotenberg conversion for the quotation PDF
// pipeline (src/app/api/quotes/[documentId]/quotation-pdf/route.ts).
// Kept separate from that route so `renderQuotationHtml`/`fileImageResolver`
// stay reachable from tests without spinning up a route handler.
//
// `renderToStaticMarkup` comes from "react-dom/server". Next's bundler
// statically forbids importing that module from anything reachable through
// the RSC module graph — even from a plain route handler pinned to
// `export const runtime = "nodejs"` — because it can't prove at build time
// that this file is never pulled into a Server Component tree (see the
// `next build` error this sidesteps: "You're importing a component that
// imports react-dom/server..."). A dynamic `import()` inside the function
// (rather than a top-level static import) isn't subject to that same
// static-analysis check, and Node only ever resolves it once, on first
// call, from this route's own server bundle.
import { readFile } from "fs/promises";
import { QuotationSheet } from "@/components/sheet/quotation-sheet";
import { resolveUploadPath } from "@/lib/uploads";
import { ensureDerivative, type DerivativeWidth } from "@/lib/image-derivatives";
import type { ImageResolver } from "@/lib/sheet-data";
import type { QuotationData } from "@/lib/quotation-data";

// --- HTML rendering -----------------------------------------------------

/**
 * Renders `QuotationSheet` to a full standalone HTML document — doctype,
 * charset, and an `@page` rule that fixes Gotenberg's headless Chromium to
 * A4 with 12mm margins (the same margins `QuotationSheet`'s own
 * `.pq-content` padding assumes visually, so the printed page and the
 * in-app preview match).
 *
 * Every image in `data` must already have been resolved to something
 * Chromium can load with no further network/auth context — Gotenberg's
 * Chromium never has this app's session cookie. For the PDF pipeline that
 * means `fileImageResolver` (below) has marked each one, and the second pass
 * here replaces those marks with the actual bytes: see `inlineMarkedImages`
 * for why the file reading cannot happen in the resolver itself.
 */
export async function renderQuotationHtml(data: QuotationData): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const body = await inlineMarkedImages(renderToStaticMarkup(QuotationSheet({ data })));
  return `<!doctype html><html><head><meta charSet="utf-8"><style>@page{size:A4;margin:12mm} body{margin:0}</style></head><body>${body}</body></html>`;
}

// --- footer -----------------------------------------------------------

/** Minimal HTML-escape — the document number is server-generated (see
 * `formatDocNumber`, src/lib/numbering.ts) and never expected to carry
 * markup, but it's still interpolated into HTML here, so it's escaped
 * rather than trusted to stay within its expected `Q-AU-2026-001` shape
 * forever. Same five-entity escape as `escapeHtml` in src/lib/markdown.ts,
 * duplicated locally (that one isn't exported) rather than importing a
 * markdown-rendering module for one string helper. */
function escapeHtmlAttr(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Gotenberg substitutes the pageNumber/totalPages spans from Chromium's own
 * print classes; everything else is literal markup. Font size is set inline
 * because the footer is rendered in its own document with no stylesheet. */
export function buildFooterHtml(documentNumber: string | null): string {
  const left = escapeHtmlAttr(documentNumber ?? "Draft");
  return `<div style="width:100%;font-size:8px;font-family:sans-serif;color:#666;padding:0 12mm;display:flex;justify-content:space-between;">
  <span>${left}</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>`;
}

// --- Gotenberg conversion -------------------------------------------------

const GOTENBERG_TIMEOUT_MS = 30_000;

/**
 * How many conversions may be in flight at once, across every caller in this
 * process (the quotation PDF and the production-forms route both come
 * through `htmlToPdf`).
 *
 * Two, because of what one conversion actually costs on the box this runs on
 * — 4 vCPU / 8GB, shared with Postgres and the Gotenberg container itself.
 * Each conversion holds the whole HTML string with its images inlined as
 * base64 (a photo-heavy quote is several MB, and multipart-encoding it for
 * the POST copies it again) while Gotenberg spawns a headless Chromium that
 * lays out and rasterizes an A4 document — a few hundred MB resident and
 * effectively a whole core for the seconds it runs. Two of those leaves
 * Postgres and Next itself with room; four is how an image-heavy burst turns
 * into the OOM killer picking a victim, and nothing about a 30-second
 * timeout per request bounds that on its own.
 *
 * The limit lives here rather than in Gotenberg's own `--chromium-max-queue`
 * because the memory that matters most is on this side: the HTML strings are
 * held in Node's heap whether or not Gotenberg has got to them yet.
 */
const MAX_CONCURRENT_CONVERSIONS = 2;

/**
 * How many callers may wait for a slot before the gate starts refusing.
 *
 * Queueing is right for the first few: the caller is an HTTP request with a
 * person watching a spinner, a conversion takes a few seconds, and two or
 * three managers downloading quotes at once is an ordinary Monday — making
 * one of them wait four seconds is a far better answer than an error page.
 * Queueing without a bound is not: at six waiting the last one already faces
 * roughly fifteen seconds of queue before its own conversion even starts,
 * and past that the honest answer is that the service is saturated. Failing
 * fast there frees the request thread, and both routes already turn a throw
 * from here into a 502 with a "PDF service unavailable" message — the user
 * retries in a moment rather than watching a browser hang and time out.
 */
const MAX_QUEUED_CONVERSIONS = 6;

let activeConversions = 0;
const waitingForSlot: Array<() => void> = [];

/** Resolves once a conversion slot is free, or rejects immediately when the
 * queue is already full. FIFO: `waitingForSlot` is drained from the front, so
 * a request that has been waiting is never overtaken by one that just
 * arrived. */
function acquireConversionSlot(): Promise<void> {
  if (activeConversions < MAX_CONCURRENT_CONVERSIONS) {
    activeConversions += 1;
    return Promise.resolve();
  }
  if (waitingForSlot.length >= MAX_QUEUED_CONVERSIONS) {
    return Promise.reject(
      new Error("PDF service is busy — too many conversions in progress. Try again in a moment.")
    );
  }
  return new Promise((resolve) => {
    waitingForSlot.push(resolve);
  });
}

/** Hands the slot straight to the next waiter rather than decrementing and
 * letting it re-check — the count only drops when nobody is queued, which is
 * what keeps a released slot from being taken by an arriving request ahead of
 * the queue. */
function releaseConversionSlot(): void {
  const next = waitingForSlot.shift();
  if (next) {
    next();
    return;
  }
  activeConversions -= 1;
}

/**
 * Posts `html` to Gotenberg's Chromium-HTML endpoint and returns the
 * resulting PDF bytes. Margins are pinned to 0 here because `@page` inside
 * the HTML itself (see `renderQuotationHtml`) already reserves the 12mm
 * margin as part of the page content — doubling it up via Gotenberg's own
 * margin options would push the sheet's own padding further in than
 * intended.
 *
 * `footerHtml` (see `buildFooterHtml`) is optional so callers that don't
 * pass one keep today's exact zero-margin behavior. When it IS passed,
 * Chromium's `header.html`/`footer.html` mechanism renders it INSIDE the
 * `marginBottom` band from `Page.printToPDF` — a completely separate
 * reservation from the `@page{margin:12mm}` CSS rule the sheet's own content
 * relies on. With `marginBottom` left at 0, Gotenberg would have no room to
 * place the footer and it would be clipped, so a non-zero `marginBottom` is
 * set whenever a footer is supplied (~10mm — enough for the single-line
 * footer `buildFooterHtml` builds). That reservation stacks on top of, not
 * instead of, the sheet's own 12mm bottom padding, so page content simply
 * ends a little higher up the page — never clipped.
 *
 * Conversions are gated: at most `MAX_CONCURRENT_CONVERSIONS` run at once and
 * the rest queue, up to `MAX_QUEUED_CONVERSIONS`, past which this throws
 * rather than queueing further. Callers already treat a throw from here as
 * "PDF service unavailable" (502), which is the right answer for a saturated
 * service — see those constants for the reasoning behind both numbers. The
 * `GOTENBERG_URL` check stays outside the gate: a misconfigured deployment
 * should fail instantly rather than take a slot to do it.
 */
export async function htmlToPdf(html: string, footerHtml?: string): Promise<Buffer> {
  const baseUrl = process.env.GOTENBERG_URL;
  if (!baseUrl) {
    throw new Error("GOTENBERG_URL is not configured");
  }

  await acquireConversionSlot();
  try {
    return await convertHtml(baseUrl, html, footerHtml);
  } finally {
    // In a `finally` so a Gotenberg timeout, a non-2xx response or an aborted
    // request all give the slot back — a leaked slot here would permanently
    // shrink the pool for the lifetime of the process.
    releaseConversionSlot();
  }
}

/** The conversion itself, minus the gating — split out only so the slot is
 * released by one `finally` around the whole request rather than threaded
 * through every early return. */
async function convertHtml(baseUrl: string, html: string, footerHtml?: string): Promise<Buffer> {
  const form = new FormData();
  form.set("files", new Blob([html], { type: "text/html" }), "index.html");
  form.set("paperWidth", "8.27");
  form.set("paperHeight", "11.69");
  form.set("marginTop", "0");
  form.set("marginBottom", footerHtml ? "0.4" : "0");
  form.set("marginLeft", "0");
  form.set("marginRight", "0");
  if (footerHtml) {
    // `printBackground` isn't needed here — `buildFooterHtml`'s markup has
    // no background of its own — so it's left at Gotenberg's default rather
    // than turned on for a case that doesn't use it.
    form.append("files", new Blob([footerHtml], { type: "text/html" }), "footer.html");
  }

  const response = await fetch(`${baseUrl}/forms/chromium/convert/html`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(GOTENBERG_TIMEOUT_MS),
  });

  if (!response.ok) {
    const snippet = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(`Gotenberg returned ${response.status}: ${snippet}`);
  }

  const buf = await response.arrayBuffer();
  return Buffer.from(buf);
}

// --- image resolution -----------------------------------------------------

const FILE_URL_PATTERN = /^\/api\/files\/(.+)$/;

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** The `src` a marked image carries between the two passes below. It is not
 * a URL and never reaches Chromium: `inlineMarkedImages` replaces every one
 * of them (or deletes the `<img>` that carries it) before the HTML leaves
 * `renderQuotationHtml`. The upload's own `<uuid>.<ext>` name is the whole
 * payload, so the mark carries no state between renders and two concurrent
 * renders of the same document can never see each other's. The patterns
 * below spell the prefix out again rather than interpolating this constant —
 * a regex literal can't, and building them with `new RegExp` would cost more
 * clarity than the duplication does. */
const IMAGE_MARK_PREFIX = "pq-pdf-image:";

/**
 * `ImageResolver` (see src/lib/sheet-data.ts) for the PDF pipeline: turns a
 * stored `/api/files/<name>` URL — auth-gated, so Gotenberg's Chromium could
 * never load it directly — into a mark that the second pass over the
 * rendered HTML swaps for the file's actual bytes. Used for item thumbnails,
 * option icons, the author's avatar, the setup image and the entity logo
 * (`entitySnapshot.logoUrl` / live region `logoUrl` both funnel through this
 * same `/api/files/...` shape before reaching here).
 *
 * It marks rather than reads because `ImageResolver` is synchronous by
 * contract — it is called from `toSheetData`, a pure mapper, whose output
 * then goes through `renderToStaticMarkup`, which is synchronous too. Reading
 * the files here would mean `readFileSync` per image on the request thread,
 * blocking the event loop for every other request while a multi-megabyte
 * photo is read and base64-encoded. Deferring to `inlineMarkedImages` buys
 * two things that are impossible in a synchronous resolver: `fs.promises`
 * reads, and a rendition sized for how the image is actually used — the mark
 * has no idea it is a 24px option icon, but the `<img>` tag it ends up on
 * does (see `DERIVATIVE_WIDTH_BY_CLASS`).
 *
 * Only the checks that need no filesystem happen here — a non-matching URL,
 * a name `resolveUploadPath` won't accept (path traversal), or an extension
 * we have no MIME type for all return `undefined`, exactly as before, so the
 * sheet renders no `<img>` at all for them. A file that turns out to be
 * missing or unreadable can only be discovered in the second pass, which
 * removes the whole `<img>` element it was marked on — the same "skip the
 * image, never fail the render" outcome, just decided later.
 */
export const fileImageResolver: ImageResolver = (url) => {
  const match = FILE_URL_PATTERN.exec(url);
  if (!match) return undefined;

  const name = match[1];
  if (resolveUploadPath(name) === null) return undefined;
  if (!MIME_BY_EXT[extensionOf(name)]) return undefined;

  return `${IMAGE_MARK_PREFIX}${name}`;
};

function extensionOf(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1).toLowerCase();
}

/**
 * The derivative width (see src/lib/image-derivatives.ts) each kind of sheet
 * image is embedded at, keyed by the class `quotation-sheet.tsx` renders it
 * with. Every width here is at least 3× the CSS box the sheet gives that
 * image, which is roughly 300dpi once Chromium lays the page out at A4 —
 * print resolution, so swapping the original for the derivative is invisible
 * on paper while cutting a ~1MB PNG to a few KB of WebP:
 *
 *   .pq-option-icon         24×24px   → 128
 *   .pq-thumb               60×60px   → 256
 *   .pq-prepared-by-avatar  100×100px → 256
 *   .pq-logo-img            ≤180×64px → 512
 *
 * The two full-bleed images are deliberately absent. `.pq-hero-image` and
 * `.pq-machine-image` both span the full 180mm content width — about 680 CSS
 * px, which needs ~2100px to print at 300dpi and still ~1000px to stay
 * acceptable. The largest derivative this app generates is 512px wide
 * (`DERIVATIVE_WIDTHS`), so every available rendition would visibly soften
 * the one photo the quote is built around (the setup image the manager shows
 * the customer). They keep their originals — which are capped at 5MB by
 * `MAX_UPLOAD_BYTES` and are now read asynchronously, so they no longer
 * block the event loop even though they are still inlined whole. Widening
 * `DERIVATIVE_WIDTHS` far enough to cover them is the change that would let
 * these two join the table.
 *
 * An unrecognized class — a renamed or newly added image class in the sheet
 * — falls back to the original for the same reason: bigger than necessary is
 * a bandwidth problem, while too small is a visible one on a document a
 * customer receives.
 */
const DERIVATIVE_WIDTH_BY_CLASS: Record<string, DerivativeWidth> = {
  "pq-option-icon": 128,
  "pq-thumb": 256,
  "pq-prepared-by-avatar": 256,
  "pq-logo-img": 512,
};

const IMG_TAG_PATTERN = /<img\b[^>]*>/g;
const MARKED_SRC_PATTERN = /src="pq-pdf-image:([^"]+)"/;
const CLASS_ATTR_PATTERN = /class="([^"]*)"/;

/** React hoists a `<link rel="preload" as="image">` to the top of its output
 * for every `<img src>` that looks like a fetchable URL — a mark does, a
 * `data:` URI doesn't, which is why nothing like this existed while the
 * resolver inlined bytes itself. The preload is worthless once the bytes are
 * embedded and would have Chromium chase a scheme that doesn't exist, so
 * these are deleted outright rather than rewritten. */
const MARKED_PRELOAD_PATTERN = /<link\b[^>]*href="pq-pdf-image:[^"]*"[^>]*>/g;

/**
 * Second half of the PDF pipeline's image resolution (see
 * `fileImageResolver`): replaces every mark left in the rendered HTML with a
 * base64 `data:` URI of the file's bytes, and deletes any `<img>` whose file
 * could not be read.
 *
 * Works on the rendered string rather than on `QuotationData` because that is
 * where an image's *role* is finally visible — the mark says which upload,
 * the tag it landed on says how big the sheet draws it — and role is what
 * decides which rendition to embed. The cost of that is a coupling to the
 * sheet's class names, which is why an unknown class falls back to the
 * original rather than guessing: the failure mode of renaming a class in
 * quotation-sheet.tsx is a larger PDF, never a blurry one.
 *
 * Files are read one after another, not with `Promise.all`. The whole point
 * of this pass is to stop a request holding every image in memory at once,
 * and `ensureDerivative` may shell out to sharp for a first-time thumbnail,
 * which is CPU-bound — a fan-out would hand one PDF render every core on a
 * 4 vCPU box. Each distinct file+width is read once even if the sheet uses
 * it several times (the same option icon across several machines is the
 * common case).
 */
async function inlineMarkedImages(html: string): Promise<string> {
  const resolved = new Map<string, string | undefined>();

  for (const tag of html.match(IMG_TAG_PATTERN) ?? []) {
    const request = markedImageRequest(tag);
    if (!request || resolved.has(request.key)) continue;
    resolved.set(request.key, await readImageDataUri(request.name, request.width));
  }

  if (resolved.size === 0) return html;

  return html.replace(MARKED_PRELOAD_PATTERN, "").replace(IMG_TAG_PATTERN, (tag) => {
    const request = markedImageRequest(tag);
    if (!request) return tag;

    const dataUri = resolved.get(request.key);
    // Dropping the element entirely — rather than leaving a `src` pointing at
    // nothing — keeps the missing-file behavior the synchronous resolver had:
    // the sheet prints no image, not a broken one, and a customer-facing
    // quote never shows Chromium's broken-image placeholder.
    if (!dataUri) return "";

    // Replaced through a function so a `$` sequence in the data URI is never
    // read as a `String.replace` substitution pattern.
    return tag.replace(MARKED_SRC_PATTERN, () => `src="${dataUri}"`);
  });
}

/** Parses one `<img>` tag into the file it was marked with and the width to
 * embed it at, or `null` when it carries no mark (an already-resolved `data:`
 * URI from a caller that resolved its own images, say). `key` identifies the
 * exact bytes wanted, so the same upload embedded at two different widths is
 * read twice and the same one twice at one width is read once. */
function markedImageRequest(
  tag: string
): { key: string; name: string; width: DerivativeWidth | null } | null {
  const marked = MARKED_SRC_PATTERN.exec(tag);
  if (!marked) return null;

  const name = marked[1];
  const classes = CLASS_ATTR_PATTERN.exec(tag)?.[1].split(/\s+/) ?? [];
  const width = classes.map((cls) => DERIVATIVE_WIDTH_BY_CLASS[cls]).find(Boolean) ?? null;

  return { key: `${name}@${width ?? "original"}`, name, width };
}

/**
 * Reads one upload as a base64 `data:` URI at `width`, or `undefined` when
 * the file can't be read at all.
 *
 * A `width` that has no derivative — an SVG, which is already vector and a
 * few KB (see src/lib/image-derivatives.ts), or an original sharp can't
 * decode — falls back to the original bytes rather than dropping the image:
 * an unresizable logo still belongs on the quote. `ensureDerivative` is
 * caught rather than only null-checked for the same reason: it loads sharp's
 * platform-specific native binary on first use, and a deployment where that
 * fails to load should print a heavier quote, not no quote.
 */
async function readImageDataUri(
  name: string,
  width: DerivativeWidth | null
): Promise<string | undefined> {
  const mime = MIME_BY_EXT[extensionOf(name)];
  if (!mime) return undefined;

  if (width !== null) {
    const derivedPath = await ensureDerivative(name, width).catch(() => null);
    if (derivedPath !== null) {
      const bytes = await readFile(derivedPath).catch(() => null);
      // `ensureDerivative` always writes WebP, whatever the original was.
      if (bytes) return `data:image/webp;base64,${bytes.toString("base64")}`;
    }
  }

  const originalPath = resolveUploadPath(name);
  if (originalPath === null) return undefined;

  const bytes = await readFile(originalPath).catch(() => null);
  return bytes ? `data:${mime};base64,${bytes.toString("base64")}` : undefined;
}

// --- filename ---------------------------------------------------------------

/**
 * The quotation PDF's downloaded filename: `<number>-quotation.pdf` for a
 * finalized quote, `draft-quotation.pdf` for one still in draft — always
 * downloaded from a single already-open document, so there's no need to
 * disambiguate between drafts by id. Strips everything except word
 * characters/dot/dash/underscore so a value can never break out of the
 * `Content-Disposition` header's quoted-string (e.g. embedded `"`, CR/LF, or
 * other header-splitting characters) — document numbers are server-
 * generated (see formatDocNumber) and never contain such characters, but
 * this stays defensive regardless.
 */
export function quotationPdfFilename(number: string | null): string {
  const raw = `${number ?? "draft"}-quotation`;
  const sanitized = raw.replace(/[^\w.-]+/g, "_");
  return `${sanitized}.pdf`;
}
