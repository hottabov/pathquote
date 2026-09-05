/**
 * The result shape and the small helpers every module under
 * src/lib/actions/ returns or reaches for.
 *
 * This file deliberately carries NO `"use server"` directive. Such a module
 * may only export async functions, which is why each action module used to
 * keep its own private copy of everything below — a plain module has no
 * such restriction, and a `"use server"` module may import from it freely.
 * The underscore prefix marks it as internal to the action layer: it is not
 * itself an action module and nothing outside src/lib/actions/ should reach
 * for it directly (components import `ActionResult` from whichever action
 * module they call, which re-exports it from here).
 */

import type { z } from "zod";
import { IMAGE_URL_PATTERN } from "@/lib/uploads";

/**
 * What every server action hands back: `{}` on success, `{ error }` on a
 * handled failure the caller should show inline. Actions that also return
 * data widen it (`ActionResult & { id?: string }`) rather than replacing it.
 */
export type ActionResult = { error?: string };

/**
 * `ActionResult` plus a non-blocking note about a save that *did* succeed —
 * an ADMIN pushing a discount past a cap a MANAGER would have been blocked
 * by, a support message stored but not emailed. Callers show `warning` as a
 * toast, not as the inline `error` treatment.
 *
 * Kept as an extension rather than folded into `ActionResult` so that the
 * majority of actions, which can never warn, do not advertise a field their
 * callers would then have to consider.
 */
export type ActionResultWithWarning = ActionResult & { warning?: string };

/**
 * The message an action returns when the row it was asked to change does
 * not exist, or exists outside the caller's scope. Deliberately identical
 * in both cases: telling a manager that someone else's document exists but
 * is not theirs leaks more than it helps.
 */
export const NOT_FOUND_ERROR = "Not found";

/** Returned when a unique `code` column rejects a write (Prisma P2002) — the
 * catalogue and region editors both key their rows by a human-typed code. */
export const CODE_EXISTS_ERROR = "That code already exists — choose a different one.";

/**
 * Join every zod issue message (form-level + field-level) into one string
 * for a plain `{ error }` result — good enough for the single-line banner
 * these editors show, none of which place errors per field.
 */
export function flattenZodError(error: z.ZodError): string {
  const flat = error.flatten();
  const messages = [...flat.formErrors, ...Object.values(flat.fieldErrors).flat()].filter(
    (m): m is string => Boolean(m)
  );
  return messages.length > 0 ? messages.join(" ") : "Invalid input";
}

/**
 * Validates a submitted image URL: either `null` — every caller reads that
 * as "clear the image" — or exactly the `/api/files/<uuid>.<ext>` shape
 * `saveUpload` produces. An arbitrary string is rejected rather than stored,
 * which is what stops an admin (or anything posting on their behalf) from
 * pointing an `imageUrl`/`logoUrl` column at an unrelated app path or an
 * external host that would then be rendered, and printed into PDFs, as if it
 * were ours.
 *
 * The `{ ok }` shape rather than a thrown error or a bare `string | null`
 * exists because `null` is a legitimate *value* here, so a nullable return
 * could not distinguish "clear it" from "rejected".
 *
 * Every image write in the action layer — catalogue product/option/series
 * art, a region's logo, a document's hero photo, a spec diagram — validated
 * against the same pattern through four byte-identical private copies of
 * this function. They were identical because they must be: the URL they
 * accept is the one `saveUpload` writes and `/api/files` serves, and a copy
 * that drifted would either reject a real upload or widen what one column
 * will store. It lives here, rather than in one directory's `_internal.ts`,
 * because its callers span catalog/, documents/ and the top level, and each
 * `_internal.ts` is by its own doc comment off-limits outside its directory.
 */
export function parseImageUrl(url: string | null): { ok: true; value: string | null } | { ok: false } {
  if (url === null) return { ok: true, value: null };
  if (!IMAGE_URL_PATTERN.test(url)) return { ok: false };
  return { ok: true, value: url };
}
