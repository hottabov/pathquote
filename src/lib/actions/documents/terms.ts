"use server";

/**
 * What a quote promises and what it prints: the four standard-terms figures
 * a salesperson may override for this deal, and which of the region's legal
 * documents the quote leaves out.
 *
 * Both are DRAFT-only and scoped exactly like every other document mutation
 * in this directory. Neither affects money, so — like `setPriceDisplay` and
 * `setDocumentNotes` next door — there is no `recalcDocument` call in either.
 */

import { revalidateDocument } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { documentWhereForUser } from "@/lib/scope";
import { idSchema } from "@/lib/validation/documents";
import { documentExclusionsSchema, quoteTermsSchema } from "@/lib/validation/quote-documents";
import { NOT_FOUND_ERROR, flattenZodError } from "../_shared";
import { assertStillDraft, mapDraftWriteError, type ActionResult } from "./_internal";

/**
 * Sets all four of this quote's standard-terms overrides at once — delivery
 * weeks, installation days, training days, warranty months. The builder panel
 * always submits the group together (same convention `setPriceDisplay` uses
 * for its toggle pair), so there is no per-field variant.
 *
 * `null` for a figure means "inherit the region's" — see `resolveQuoteTerms`
 * (src/lib/quote-terms.ts), which is where the precedence actually lives, and
 * `termFigureSchema` for why a blank field and a typed `0` are two different
 * answers. Delivery and warranty are negotiated per deal, and a signed quote
 * promising the region's 14 weeks when the salesperson agreed 10 is a
 * commitment nobody made.
 *
 * A single-statement write, so it folds its own `status: "DRAFT"` check into
 * the `updateMany`'s `where` (see the note in _internal.ts) rather than
 * taking a transaction.
 */
export async function setQuoteTerms(documentId: string, input: unknown): Promise<ActionResult> {
  const session = await requireSession();

  const parsedDocumentId = idSchema.safeParse(documentId);
  if (!parsedDocumentId.success) return { error: NOT_FOUND_ERROR };

  const parsedInput = quoteTermsSchema.safeParse(input);
  if (!parsedInput.success) return { error: flattenZodError(parsedInput.error) };

  const document = await db.document.findFirst({
    where: { id: parsedDocumentId.data, status: "DRAFT", ...documentWhereForUser(session.user) },
    select: { id: true },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  const updated = await db.document.updateMany({
    where: { id: document.id, status: "DRAFT" },
    data: {
      deliveryWeeks: parsedInput.data.deliveryWeeks,
      installationDays: parsedInput.data.installationDays,
      trainingDays: parsedInput.data.trainingDays,
      warrantyMonths: parsedInput.data.warrantyMonths,
    },
  });
  if (updated.count !== 1) return { error: NOT_FOUND_ERROR };

  revalidateDocument(document.id);
  return {};
}

/**
 * Replaces this quote's set of excluded documents with `keys` — the legal
 * documents its author unticked. RSP printed on every quote today whether or
 * not the customer bought it; this is the tickbox.
 *
 * The panel submits the whole set rather than one change, so this is a
 * replace: delete every stored exclusion the new set doesn't name, then
 * create the ones it does. Two statements means the `status: "DRAFT"` check
 * cannot ride along in a single `where` the way `setQuoteTerms` above manages
 * — hence the guarded transaction (`assertStillDraft` +
 * `mapDraftWriteError`), the same shape `setDeliveryTerms` and every
 * money-affecting mutation in this directory use. The guard is not
 * ceremonial: `finalizeDocument` committing between the pre-read and these
 * writes would otherwise change what an already-numbered quote prints.
 *
 * The exclusions live on `DocumentExclusion`, keyed by the document's `key`
 * rather than its id, so the same row still means the same thing if this
 * quote's region changes and a different `QuoteDocument` becomes the resolved
 * one.
 */
export async function setDocumentExclusions(documentId: string, keys: unknown): Promise<ActionResult> {
  const session = await requireSession();

  const parsedDocumentId = idSchema.safeParse(documentId);
  if (!parsedDocumentId.success) return { error: NOT_FOUND_ERROR };

  const parsedKeys = documentExclusionsSchema.safeParse(keys);
  if (!parsedKeys.success) return { error: flattenZodError(parsedKeys.error) };
  const excluded = parsedKeys.data;

  const document = await db.document.findFirst({
    where: { id: parsedDocumentId.data, status: "DRAFT", ...documentWhereForUser(session.user) },
    select: { id: true },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  try {
    await db.$transaction(async (tx) => {
      await assertStillDraft(tx, document.id);
      // Ticking a document back on is the delete half of this replace. The
      // `notIn` clause is spread rather than passed with an empty array so
      // "nothing is excluded any more" reads as the plain "delete this
      // document's exclusions" it is, instead of resting on how Prisma
      // renders `NOT IN ()`.
      await tx.documentExclusion.deleteMany({
        where: {
          documentId: document.id,
          ...(excluded.length > 0 ? { quoteDocumentKey: { notIn: excluded } } : {}),
        },
      });
      if (excluded.length > 0) {
        // `skipDuplicates` because the delete above deliberately leaves the
        // rows that are still excluded in place — re-creating them would
        // collide with the `@@id([documentId, quoteDocumentKey])` primary key.
        await tx.documentExclusion.createMany({
          data: excluded.map((quoteDocumentKey) => ({ documentId: document.id, quoteDocumentKey })),
          skipDuplicates: true,
        });
      }
    });
  } catch (error) {
    return mapDraftWriteError(error);
  }

  revalidateDocument(document.id);
  return {};
}
