"use server";

/**
 * Document-level CUSTOM lines — the freeform "extra lines" (delivery,
 * install, a trade-in) that hang off the document rather than off an item.
 * An item's OPTION lines are a different thing entirely and live in
 * options.ts, which only ever replaces them as a whole set.
 */

import { revalidateDocument } from "@/lib/revalidate";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { documentWhereForUser } from "@/lib/scope";
import { recalcAndEnforce } from "@/lib/documents/recalc";
import { customLineSchema, idSchema } from "@/lib/validation/documents";
import { NOT_FOUND_ERROR, flattenZodError } from "../_shared";
import { assertStillDraft, mapDraftWriteError, type ActionResult } from "./_internal";

/**
 * Adds a freeform document-level line (e.g. "Delivery", "Install") — always
 * `kind: CUSTOM` with `itemId: null` — appended after every existing
 * document-level line. Scoped to the caller's own DRAFT document.
 */
export async function addCustomLine(documentId: string, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();

  const parsedDocumentId = idSchema.safeParse(documentId);
  if (!parsedDocumentId.success) return { error: NOT_FOUND_ERROR };

  const parsed = customLineSchema.safeParse({
    name: formData.get("name"),
    qty: formData.get("qty"),
    unitPrice: formData.get("unitPrice"),
    description: formData.get("description"),
    imageUrl: formData.get("imageUrl"),
  });
  if (!parsed.success) return { error: flattenZodError(parsed.error) };

  const document = await db.document.findFirst({
    where: { id: parsedDocumentId.data, status: "DRAFT", ...documentWhereForUser(session.user) },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  const maxSortOrder = await db.documentLine.aggregate({
    where: { documentId: document.id, itemId: null },
    _max: { sortOrder: true },
  });

  // A negative unitPrice (a trade-in — see customLineSchema) can push the
  // document's subtotal below zero, and also counts toward the region
  // concession cap (see the doc comment on `computeTotals`, src/lib/pricing.ts);
  // create + recalc run in one transaction so a rejected save never leaves
  // the line committed with a stale total. `listPrice` is left null: a
  // custom line has no catalogue entry to snapshot one from.
  let concessionWarning: string | undefined;
  try {
    await db.$transaction(async (tx) => {
      await assertStillDraft(tx, document.id);
      await tx.documentLine.create({
        data: {
          documentId: document.id,
          itemId: null,
          kind: "CUSTOM",
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          qty: parsed.data.qty,
          unitPrice: new Prisma.Decimal(parsed.data.unitPrice),
          imageUrl: parsed.data.imageUrl ?? null,
          // Same "image present -> show it" default as `addItem` gives a
          // product image: a custom line has no separate show/hide toggle
          // of its own, so attaching a photo is what turns this on.
          showImage: Boolean(parsed.data.imageUrl),
          sortOrder: (maxSortOrder._max.sortOrder ?? -1) + 1,
        },
      });

      concessionWarning = (await recalcAndEnforce(document.id, tx, session.user.role)).warning;
    });
  } catch (error) {
    return mapDraftWriteError(error);
  }

  revalidateDocument(document.id);
  return concessionWarning ? { warning: concessionWarning } : {};
}

/**
 * Removes a document-level CUSTOM line (an "extra line" like delivery).
 * Scoped through line -> document -> author chain, and deliberately matches
 * only a document-level CUSTOM line (`itemId: null`, `kind: "CUSTOM"`) — an
 * item's OPTION lines are replaced as a whole set via `setItemOptions`,
 * never deleted one at a time through this action.
 */
export async function removeLine(lineId: string): Promise<ActionResult> {
  const session = await requireSession();

  const parsedLineId = idSchema.safeParse(lineId);
  if (!parsedLineId.success) return { error: NOT_FOUND_ERROR };

  const line = await db.documentLine.findFirst({
    where: {
      id: parsedLineId.data,
      itemId: null,
      kind: "CUSTOM",
      document: { status: "DRAFT", ...documentWhereForUser(session.user) },
    },
    select: { id: true, documentId: true },
  });
  if (!line) return { error: NOT_FOUND_ERROR };

  // Removing a positive extra line can reveal a negative subtotal (e.g. a
  // trade-in line elsewhere that this one was offsetting) — same guarded
  // transaction pattern as every other mutation here. It can also raise the
  // document's concession percentage (removing a positive extra line shrinks
  // `listValue`), so the cap is re-checked too.
  let concessionWarning: string | undefined;
  try {
    await db.$transaction(async (tx) => {
      await assertStillDraft(tx, line.documentId);
      await tx.documentLine.delete({ where: { id: line.id } });
      concessionWarning = (await recalcAndEnforce(line.documentId, tx, session.user.role)).warning;
    });
  } catch (error) {
    return mapDraftWriteError(error);
  }

  revalidateDocument(line.documentId);
  return concessionWarning ? { warning: concessionWarning } : {};
}
