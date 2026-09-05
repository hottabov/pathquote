/**
 * The internals every document-action module in this directory shares: the
 * result type they all return, the DRAFT guard each interactive transaction
 * opens with, and the sentinel-to-`ActionResult` mapping each one closes
 * with.
 *
 * Like `src/lib/actions/_shared.ts` (whose `ActionResult` this widens), the
 * file deliberately carries NO `"use server"` directive — such a module may
 * only export async functions, and neither the type, the class nor the
 * mapper below is one. The `"use server"` modules alongside it import from
 * here freely; nothing outside `src/lib/actions/documents/` should, the
 * underscore prefix marking it as internal to that split the same way
 * `_shared.ts` marks itself internal to the action layer as a whole.
 */

import type { Prisma } from "@prisma/client";
import { NOT_FOUND_ERROR, type ActionResultWithWarning } from "../_shared";
import { ConcessionCapError, NegativeSubtotalError } from "@/lib/documents/recalc";

/**
 * The warning-carrying variant of the shared result, aliased so the barrel
 * at src/lib/actions/documents.ts — and through it every component — keeps
 * importing `ActionResult` from there.
 *
 * `warning` is set on an otherwise-successful save that an ADMIN pushed
 * through over a rule a MANAGER would have been blocked by (currently just
 * `setItemDiscount` exceeding a series' cap — see its own comment) — the
 * caller shows it as a non-blocking toast rather than the inline `error`
 * treatment, since the save itself did succeed.
 */
export type ActionResult = ActionResultWithWarning;

const NEGATIVE_SUBTOTAL_ERROR = "Discounts and trade-ins cannot exceed the value of the quote.";

// --- draft guard -----------------------------------------------------------

/** The subset of a Prisma client `assertStillDraft` needs — satisfied by the
 * `tx` handed to a `db.$transaction(async (tx) => ...)` callback, which is
 * the only place it is ever meaningful to call it from. */
type DraftGuardClient = { document: Prisma.TransactionClient["document"] };

/** Thrown by `assertStillDraft` below to abort and roll back the caller's
 * transaction, the same sentinel-error shape as `NegativeSubtotalError`.
 * `mapDraftWriteError` maps it to the plain `NOT_FOUND_ERROR` the caller's
 * own pre-read would have returned: from the caller's point of view a
 * document that turned FINAL mid-save is exactly that — no longer a draft it
 * can edit. */
class NotDraftError extends Error {}

/**
 * Re-checks *inside* the caller's transaction the `status: "DRAFT"` its
 * pre-read already checked outside one, and holds the document row for the
 * rest of that transaction.
 *
 * Both halves matter. Every mutating action in this directory loads its
 * document (or its item/line, through the document) before opening its
 * transaction, so a `finalizeDocument` committing in the gap between that
 * read and the write would otherwise let an item be appended to — or a price
 * changed on — a document that is by then FINAL and numbered. And the check
 * is written as a status-scoped `updateMany` rather than a `findFirst`
 * because only a write takes the row lock that makes this and finalize's own
 * status-guarded `updateMany` (src/lib/actions/finalize.ts) order against
 * each other; two concurrent reads would both see DRAFT and both proceed.
 * `count !== 1` means the document is gone or is no longer a draft, and the
 * whole transaction — entity write and recalc alike — is rolled back.
 *
 * The value written is the status the row already holds, so the only column
 * this moves on its own is `updatedAt`, and all but `reorderItems` go on to
 * write the row anyway through `recalcAndEnforce`.
 */
export async function assertStillDraft(tx: DraftGuardClient, documentId: string): Promise<void> {
  const guarded = await tx.document.updateMany({
    where: { id: documentId, status: "DRAFT" },
    data: { status: "DRAFT" },
  });
  if (guarded.count !== 1) throw new NotDraftError();
}

/**
 * Aborts and rolls back the caller's transaction with the same answer
 * `assertStillDraft` raises: the row this write was aimed at is gone, or is
 * no longer a draft, so `mapDraftWriteError` turns it into `NOT_FOUND_ERROR`.
 *
 * Needed by a write that rides *inside* another action's transaction and so
 * cannot simply `return { error }` the way a top-level action does — a bare
 * return there would commit the surrounding writes and report failure.
 * `setEasyLoaderLayout`'s production-spec `updateMany` is the case that
 * introduced it: its `count !== 1` has to take the option lines down with it.
 */
export function abortDraftWrite(): never {
  throw new NotDraftError();
}

/* An action whose entire write is a single statement needs neither the helper
 * above nor a transaction to hold: it folds the same `status: "DRAFT"` check
 * into that one statement's own `where` (as an `updateMany`/`deleteMany`,
 * which unlike `update` doesn't throw on matching nothing), which is atomic by
 * construction, and reads `count !== 1` as the same "not a draft any more"
 * answer `NotDraftError` carries for the transactional ones. An item-level
 * write reaches the status through its `document` relation. */

/**
 * Turns the three sentinel errors a guarded write can throw into the result
 * each of them means to the caller, and rethrows anything else so a genuine
 * failure still surfaces as a 500 rather than as an inline message the user
 * could mistake for a validation problem.
 *
 * Every transaction in this directory closes with exactly this mapping, which
 * is why it is written once here rather than repeated per action. The two
 * recalc sentinels (`NegativeSubtotalError`, `ConcessionCapError`) can only
 * ever be raised by `recalcAndEnforce`, so for the one action that runs no
 * recalc (`reorderItems`) those branches are simply unreachable — sharing the
 * mapper costs it nothing.
 */
export function mapDraftWriteError(error: unknown): ActionResult {
  if (error instanceof NotDraftError) return { error: NOT_FOUND_ERROR };
  if (error instanceof NegativeSubtotalError) return { error: NEGATIVE_SUBTOTAL_ERROR };
  if (error instanceof ConcessionCapError) return { error: error.message };
  throw error;
}
