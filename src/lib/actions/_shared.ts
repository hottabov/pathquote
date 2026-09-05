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
