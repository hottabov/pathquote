"use server";

import { revalidateDocument } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { documentWhereForUser } from "@/lib/scope";
import { idSchema } from "@/lib/validation/documents";
import { screenSideSchema } from "@/lib/validation/production-spec";
import { resolveForm, specSchemaForCode } from "@/lib/production-forms/resolve";
import { NOT_FOUND_ERROR, flattenZodError, type ActionResult } from "./_shared";

export type { ActionResult };

export type ApplyScreenSideResult = ActionResult & {
  /**
   * Product codes of the machines whose screen side this call changed --
   * empty when they all already stood that way.
   *
   * Codes, not names. A product name here can be the better part of a
   * paragraph (the software modules carry their whole feature list as a
   * name), and the toast that prints this is one line.
   */
  appliedTo?: string[];
};

/**
 * Writes an item's production spec.
 *
 * Deliberately NOT gated on `status: "DRAFT"`, unlike every other item
 * mutation in src/lib/actions/documents.ts. The production spec carries no
 * commercial meaning -- it does not touch price, tax or totals -- so
 * requiring an unfinalize/refinalize cycle to correct a knife size would
 * churn document numbering for no gain. See spec section 4.1.
 *
 * Writes this item and nothing else. The screen side used to be forced onto
 * every machine grouped with it, on the reasoning that a cutter and its
 * spreaders stand together. The owner has since found the case that breaks:
 * a cutter's screen on one side while the conveyor and FabricPro controls
 * face the other. So the side is offered to the rest of the quote rather
 * than applied to it -- see `applyScreenSideToQuote`.
 */
export async function setProductionSpec(itemId: string, spec: unknown): Promise<ActionResult> {
  const session = await requireSession();

  const parsedItemId = idSchema.safeParse(itemId);
  if (!parsedItemId.success) return { error: NOT_FOUND_ERROR };

  const item = await db.documentItem.findFirst({
    where: { id: parsedItemId.data, document: documentWhereForUser(session.user) },
    select: { id: true, code: true, documentId: true },
  });
  if (!item) return { error: NOT_FOUND_ERROR };

  const schema = specSchemaForCode(item.code);
  if (!schema) return { error: "This item has no production form" };

  const parsed = schema.safeParse(spec);
  if (!parsed.success) return { error: flattenZodError(parsed.error) };

  await db.documentItem.update({
    where: { id: item.id },
    data: { productionSpec: parsed.data as object },
  });

  revalidateDocument(item.documentId);
  return {};
}

/**
 * Sets `side` as the operator screen side on every *other* machine in this
 * item's document. Only ever called from the offer the editor shows after a
 * side changes -- a manager who wants two machines facing different ways
 * simply does not take the offer.
 *
 * "Machine" means an item `resolveForm` recognises. A screen side is a fact
 * about a thing an operator stands in front of, and a quote also holds
 * software modules, service entries and accessories, which have no side and
 * no form to print one on. Gating on the form rather than on a hand-kept
 * list of series codes means the set widens on its own the day the X, L and
 * EF forms are written.
 */
export async function applyScreenSideToQuote(
  itemId: string,
  side: string
): Promise<ApplyScreenSideResult> {
  const session = await requireSession();

  const parsedItemId = idSchema.safeParse(itemId);
  if (!parsedItemId.success) return { error: NOT_FOUND_ERROR };

  const parsedSide = screenSideSchema.safeParse(side);
  if (!parsedSide.success) return { error: flattenZodError(parsedSide.error) };

  const item = await db.documentItem.findFirst({
    where: { id: parsedItemId.data, document: documentWhereForUser(session.user) },
    select: { id: true, documentId: true },
  });
  if (!item) return { error: NOT_FOUND_ERROR };

  const appliedTo: string[] = [];

  await db.$transaction(async (tx) => {
    const others = await tx.documentItem.findMany({
      where: { documentId: item.documentId, id: { not: item.id } },
      select: { id: true, code: true, productionSpec: true },
    });

    for (const other of others) {
      if (!resolveForm(other.code)) continue;
      const current = (other.productionSpec ?? {}) as Record<string, unknown>;
      if (current.ui === parsedSide.data) continue;
      await tx.documentItem.update({
        where: { id: other.id },
        data: { productionSpec: { ...current, ui: parsedSide.data } },
      });
      appliedTo.push(other.code);
    }
  });

  revalidateDocument(item.documentId);
  return { appliedTo };
}
