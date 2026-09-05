// The default `ImageResolver`, extracted so src/lib/sheet-data.ts and
// src/lib/quotation-data.ts stop each declaring their own copy of it. It
// lives in its own module rather than being exported from sheet-data.ts
// because quotation-data.ts already imports a dozen types from there and a
// value export would be the only runtime import among them — keeping it
// apart makes it obvious that neither mapper gains a dependency by sharing
// this. Only the *type* is imported below, so nothing is added to either
// module's runtime import graph.
import type { ImageResolver } from "./sheet-data";

/** Passes a stored image URL through untouched — what the in-app preview
 * wants, since the browser is already authenticated for `/api/files/...`.
 * The PDF pipeline substitutes `fileImageResolver` (src/lib/pdf.ts) instead,
 * because Gotenberg's headless Chromium cannot reach an auth-gated URL. */
export const identityResolver: ImageResolver = (url) => url;
