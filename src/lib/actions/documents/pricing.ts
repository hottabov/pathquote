"use server";

/**
 * Everything that moves the money on a draft: the item- and document-level
 * discounts, and the hand-set prices that replace a catalogue figure
 * outright. Grouped together because they share the one thing the display
 * toggles and the lifecycle actions don't — a region cap to check before the
 * write, and a whole-document concession to enforce during it.
 */

import { revalidateDocument } from "@/lib/revalidate";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { isAdminRole } from "@/lib/roles";
import { documentWhereForUser } from "@/lib/scope";
import { capPct, discountCents, toCents } from "@/lib/pricing";
import { recalcAndEnforce } from "@/lib/documents/recalc";
import { formatMoney } from "@/lib/format";
import {
  discountModeSchema,
  discountValueSchema,
  exceedsPercentCeiling,
  idSchema,
  unitPriceSchema,
  creditUnitPriceSchema,
  type DiscountModeInput,
} from "@/lib/validation/documents";
import { NOT_FOUND_ERROR, flattenZodError } from "../_shared";
import { assertStillDraft, mapDraftWriteError, type ActionResult } from "./_internal";

// --- discounts (Task D, extended for mode+value in Task 6) ------------------

/** Renders a discount's value in its own mode's terms — "20%" or a
 * currency-formatted cash figure — for the cap-exceeded message below.
 * Never called with a `null` value (both call sites below only build the
 * message once `exceedsCap` is true, which already implies a non-null
 * value). */
function discountValueLabel(
  mode: DiscountModeInput,
  value: string,
  currency: string,
  currencySymbol: string | null
): string {
  return mode === "PERCENT" ? `${value}%` : formatMoney(value, currency, currencySymbol);
}

/** Trims a computed cap-comparison percentage (see `capPct`) to a
 * display-friendly string (2dp, no trailing zeros) — an AMOUNT discount's
 * `effectivePct` returns a float that can carry floating-point noise (e.g.
 * `19.999999999999996`), which would look wrong printed straight into a
 * user-facing message. */
function formatEffectivePct(pct: number): string {
  return (Math.round(pct * 100) / 100).toString();
}

/**
 * Builds the region-cap-exceeded message shared by `setItemDiscount` and
 * `setDocumentDiscount`, always naming both figures the owner asked for: the
 * discount as entered (in its own mode) and the percentage of `scope` it
 * works out to — e.g. "A $20,000.00 discount is 20% of this item — above the
 * 10% limit for Australia." For a PERCENT discount the two figures are the
 * same number by construction, which is fine — the sentence still reads
 * correctly, just without new information the reader didn't already have.
 */
function discountCapMessage(
  mode: DiscountModeInput,
  value: string,
  effPct: number,
  cap: number,
  regionName: string,
  currency: string,
  currencySymbol: string | null,
  scope: "item" | "quote"
): string {
  const valueLabel = discountValueLabel(mode, value, currency, currencySymbol);
  return `A ${valueLabel} discount is ${formatEffectivePct(effPct)}% of this ${scope} — above the ${cap}% limit for ${regionName}.`;
}

/**
 * Sets (or, given an empty `value`, clears) an item's discount — a mode
 * ("PERCENT" | "AMOUNT") plus a value (see `DiscountMode` in
 * schema.prisma). The document's region cap (`Region.maxDiscountPct`,
 * admin-editable on /settings/regions — see `RegionForm`/`updateRegion`) is
 * enforced *before* persisting — unlike the pricing engine's own violation
 * reporting (which happily computes with whatever discount is already
 * stored and just flags it, see `EngineViolation`) — but ONLY for a
 * MANAGER: a save that exceeds the cap is refused outright for them, so a
 * violating discount is never actually written by a manager's save. An
 * ADMIN may exceed the cap; the save still succeeds but comes back with
 * `warning` set (rather than `error`) so the caller can surface a
 * non-blocking "exceeds cap" toast instead of rejecting the save. A region
 * with no cap configured (`maxDiscountPct` null) allows any discount for
 * either role.
 *
 * A cash (AMOUNT) discount is converted back to an *effective* percentage of
 * the item's own base (unit price + its option lines) before the cap check
 * — otherwise a manager blocked from a 15% discount could simply type the
 * equivalent dollar figure and bypass the cap entirely. A PERCENT discount
 * is compared to the cap using the typed value directly instead — see
 * `capPct` in src/lib/pricing.ts for why the two modes are compared
 * differently.
 *
 * That "item's own base" is narrowed the same way `computeTotals` narrows
 * it (see its "a no-commission line takes no discount" doc comment): the
 * item's own unitPrice is excluded when the item itself is flagged
 * `Product.noCommission`, and any OPTION line whose `Option.noCommission` is
 * set is excluded too. This has to match the engine's own `discountBaseCents`
 * exactly, not just approximate it — for a PERCENT discount it wouldn't
 * matter (`capPct`'s PERCENT branch reports the typed value regardless of
 * base either way), but for an AMOUNT discount the resolved cash amount is
 * clamped to whatever base it's checked against (`discountCents`), so
 * checking against the item's FULL price here while the engine later
 * resolves it against the smaller commissionable-only price would let a
 * MANAGER save a dollar discount that reads as comfortably under cap here
 * but concentrates entirely onto the smaller commissionable slice once
 * actually applied — silently a much bigger effective percentage discount
 * than what this check approved.
 */
export async function setItemDiscount(itemId: string, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();

  const parsedItemId = idSchema.safeParse(itemId);
  if (!parsedItemId.success) return { error: NOT_FOUND_ERROR };

  const parsedMode = discountModeSchema.safeParse(formData.get("mode"));
  if (!parsedMode.success) return { error: flattenZodError(parsedMode.error) };
  const parsedValue = discountValueSchema.safeParse(formData.get("value"));
  if (!parsedValue.success) return { error: flattenZodError(parsedValue.error) };

  if (exceedsPercentCeiling(parsedMode.data, parsedValue.data)) {
    return { error: "A percentage discount cannot exceed 100%." };
  }

  const item = await db.documentItem.findFirst({
    where: {
      id: parsedItemId.data,
      document: { status: "DRAFT", ...documentWhereForUser(session.user) },
    },
    include: {
      document: { include: { region: true } },
      lines: true,
      product: { select: { isCredit: true, noCommission: true } },
    },
  });
  if (!item) return { error: NOT_FOUND_ERROR };

  // A credit item (the TRADE-IN product) is already a negative line — a
  // discount on it is meaningless, and if entered by accident would
  // silently make the credit larger without the salesperson noticing. The
  // UI already hides the control for a credit item (see the `isCredit`
  // gate in `ItemBreakdownEditor`); this is the guard against a crafted
  // request that skips straight to the action.
  if (item.product?.isCredit && parsedValue.data !== null) {
    return { error: "A trade-in credit can't have a discount." };
  }

  const cap = item.document.region.maxDiscountPct ? Number(item.document.region.maxDiscountPct) : null;

  let warning: string | undefined;
  if (parsedValue.data !== null && cap !== null) {
    // Narrowed to the commissionable-only base — see this function's own
    // doc comment above for why this must mirror `computeTotals`'s
    // `discountBaseCents` exactly, not just the item's plain full price.
    const optionRefIds = item.lines
      .filter((line): line is (typeof item.lines)[number] & { refId: string } => line.kind === "OPTION" && line.refId !== null)
      .map((line) => line.refId);
    const optionRows =
      optionRefIds.length > 0
        ? await db.option.findMany({ where: { id: { in: optionRefIds } }, select: { id: true, noCommission: true } })
        : [];
    const optionNoCommissionMap = new Map(optionRows.map((o) => [o.id, o.noCommission]));
    const isItemNoCommission = item.product?.noCommission ?? false;

    const baseCents =
      (isItemNoCommission ? 0 : toCents(item.unitPrice.toString())) +
      item.lines.reduce((sum, line) => {
        const lineNoCommission = line.refId !== null ? (optionNoCommissionMap.get(line.refId) ?? false) : false;
        return lineNoCommission ? sum : sum + line.qty * toCents(line.unitPrice.toString());
      }, 0);
    const discount = discountCents(baseCents, parsedMode.data, parsedValue.data);
    const effPct = capPct(parsedMode.data, parsedValue.data, baseCents, discount);
    // Guarded on `baseCents > 0` the same way `computeTotals` guards its own
    // violation check: a wholly no-commission item's discount is inert
    // (resolves to 0 regardless of the typed value), so there's no actual
    // over-cap money movement here to block — see this function's own doc
    // comment.
    if (baseCents > 0 && effPct > cap) {
      const message = discountCapMessage(
        parsedMode.data,
        parsedValue.data,
        effPct,
        cap,
        item.document.region.name,
        item.document.currency,
        // The document's frozen symbol, not its region's current one.
        item.document.currencySymbol,
        "item"
      );
      if (!isAdminRole(session.user.role)) {
        return { error: message };
      }
      warning = message;
    }
  }

  // A larger item discount can reveal a negative subtotal (e.g. against a
  // trade-in extra line elsewhere on the document) — same guarded
  // transaction pattern as every other mutation here. It's also the same
  // `recalcAndEnforce` guard as every other mutation, checking the
  // *whole-document* concession — distinct from (and in addition to) the
  // per-item cap check already done above.
  let concessionWarning: string | undefined;
  try {
    await db.$transaction(async (tx) => {
      await assertStillDraft(tx, item.documentId);
      await tx.documentItem.update({
        where: { id: item.id },
        data: {
          discountMode: parsedMode.data,
          discountValue: parsedValue.data === null ? null : new Prisma.Decimal(parsedValue.data),
        },
      });
      concessionWarning = (await recalcAndEnforce(item.documentId, tx, session.user.role)).warning;
    });
  } catch (error) {
    return mapDraftWriteError(error);
  }

  revalidateDocument(item.documentId);
  const combinedWarning = warning ?? concessionWarning;
  return combinedWarning ? { warning: combinedWarning } : {};
}

/**
 * Sets (or clears) the document-level discount — same mode + value shape as
 * `setItemDiscount`, enforced against the same region cap (this used to be
 * uncapped at the document level; it now shares the exact same
 * MANAGER-blocked/ADMIN-warned enforcement as an item discount).
 *
 * A cash (AMOUNT) discount is converted back to an effective percentage of
 * the document's own subtotal before the cap check, same reasoning (and the
 * same `capPct` helper) as `setItemDiscount`. The subtotal used starts from
 * the document's already-persisted `subtotal` column (items + extra lines,
 * computed by the last `recalcDocument`) — this action never touches
 * items/lines, so that figure is already exactly right — but then has every
 * no-commission item/line's charged amount subtracted out of it, and every
 * credit item's (`isCredit`) charged magnitude added back in, mirroring
 * `computeTotals`'s own `documentDiscountBaseCents` exactly (see its "a
 * discount must not erode a trade-in" doc comment for the credit half, and
 * "a no-commission line takes no discount" for the other) so this pre-check
 * is comparing against the exact same base the engine will actually resolve
 * the discount against. Skipping either narrowing (comparing against the
 * plain, un-narrowed subtotal instead) would have the same AMOUNT-mode
 * under/over-reporting problem `setItemDiscount`'s own doc comment describes
 * one level down.
 */
export async function setDocumentDiscount(documentId: string, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();

  const parsedDocumentId = idSchema.safeParse(documentId);
  if (!parsedDocumentId.success) return { error: NOT_FOUND_ERROR };

  const parsedMode = discountModeSchema.safeParse(formData.get("mode"));
  if (!parsedMode.success) return { error: flattenZodError(parsedMode.error) };
  const parsedValue = discountValueSchema.safeParse(formData.get("value"));
  if (!parsedValue.success) return { error: flattenZodError(parsedValue.error) };

  if (exceedsPercentCeiling(parsedMode.data, parsedValue.data)) {
    return { error: "A percentage discount cannot exceed 100%." };
  }

  const document = await db.document.findFirst({
    where: { id: parsedDocumentId.data, status: "DRAFT", ...documentWhereForUser(session.user) },
    include: {
      region: true,
      // Only needed to narrow the cap check's base below (see this
      // function's own doc comment) — `product`/lines' `refId` are read to
      // find every no-commission item/line's charged amount and every
      // credit item's charged amount, the same "joined live" rule
      // `computeTotals`'s inputs already follow.
      items: { include: { lines: true, product: { select: { isCredit: true, noCommission: true } } } },
    },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  const cap = document.region.maxDiscountPct ? Number(document.region.maxDiscountPct) : null;

  let warning: string | undefined;
  if (parsedValue.data !== null && cap !== null) {
    const optionRefIds = document.items
      .flatMap((item) => item.lines)
      .filter((line): line is (typeof document.items)[number]["lines"][number] & { refId: string } => line.kind === "OPTION" && line.refId !== null)
      .map((line) => line.refId);
    const optionRows =
      optionRefIds.length > 0
        ? await db.option.findMany({ where: { id: { in: optionRefIds } }, select: { id: true, noCommission: true } })
        : [];
    const optionNoCommissionMap = new Map(optionRows.map((o) => [o.id, o.noCommission]));

    // Mirrors `computeTotals`'s `documentDiscountBaseCents` term-for-term:
    // a no-commission item/line's charged amount is subtracted out (it takes
    // no discount), and a credit item's charged magnitude is added back in
    // (a discount must not erode a trade-in — see `computeTotals`'s doc
    // comment) — `document.subtotal` is already net of every credit item
    // (see `recalcDocument`), so without adding it back here the cap check
    // would compare against the same too-small, trade-in-eroded base the
    // engine itself no longer uses.
    let noCommissionChargedCents = 0;
    let creditChargedCents = 0;
    for (const item of document.items) {
      const itemUnitPriceCents = toCents(item.unitPrice.toString());
      if (item.product?.isCredit) {
        // A credit item is never itself discounted (refused above, in this
        // same action, and hidden in the builder), so its full charged
        // amount — unitPrice plus any lines, though it should never carry
        // any in practice — is exactly its magnitude in `document.subtotal`.
        creditChargedCents +=
          itemUnitPriceCents + item.lines.reduce((sum, line) => sum + line.qty * toCents(line.unitPrice.toString()), 0);
        continue;
      }
      if (item.product?.noCommission) noCommissionChargedCents += itemUnitPriceCents;
      for (const line of item.lines) {
        const lineNoCommission = line.refId !== null ? (optionNoCommissionMap.get(line.refId) ?? false) : false;
        if (lineNoCommission) noCommissionChargedCents += line.qty * toCents(line.unitPrice.toString());
      }
    }

    const subtotalCents = toCents(document.subtotal.toString()) + creditChargedCents - noCommissionChargedCents;
    const discount = discountCents(subtotalCents, parsedMode.data, parsedValue.data);
    const effPct = capPct(parsedMode.data, parsedValue.data, subtotalCents, discount);
    // Guarded on `subtotalCents > 0` the same way `computeTotals`'s own
    // violation check is — see `setItemDiscount`'s equivalent guard.
    if (subtotalCents > 0 && effPct > cap) {
      const message = discountCapMessage(
        parsedMode.data,
        parsedValue.data,
        effPct,
        cap,
        document.region.name,
        document.currency,
        document.currencySymbol,
        "quote"
      );
      if (!isAdminRole(session.user.role)) {
        return { error: message };
      }
      warning = message;
    }
  }

  // The document-level discount is applied *after* `negativeSubtotal` is
  // computed (see computeTotals — the flag reflects the pre-discount
  // subtotal), so this can never actually trigger the guard on its own; the
  // same transaction pattern is still used for consistency with every other
  // mutation here, and as a defensive backstop should that ever change.
  // `recalcAndEnforce`'s concession-cap check, unlike `negativeSubtotal`,
  // *does* directly cover this discount (it's one of the terms summed into
  // `concession` — see computeTotals) — a document discount alone can be
  // enough to push the whole-document figure over the region cap even when
  // it stays under the per-discount check above (that one compares only this
  // discount's own percentage; the concession check sums every source at
  // once).
  let concessionWarning: string | undefined;
  try {
    await db.$transaction(async (tx) => {
      await assertStillDraft(tx, document.id);
      await tx.document.update({
        where: { id: document.id },
        data: {
          discountMode: parsedMode.data,
          discountValue: parsedValue.data === null ? null : new Prisma.Decimal(parsedValue.data),
        },
      });
      concessionWarning = (await recalcAndEnforce(document.id, tx, session.user.role)).warning;
    });
  } catch (error) {
    return mapDraftWriteError(error);
  }

  revalidateDocument(document.id);
  const combinedWarning = warning ?? concessionWarning;
  return combinedWarning ? { warning: combinedWarning } : {};
}

// --- manual unit price ------------------------------------------------------
//
// The highest-risk half of this feature (see docs/specs -- the owners'
// framing: "if I give it away for zero dollars... I give them back zero
// dollars", "increase the price of the machine by $10,000 and then give
// away $10,000 worth of options -- we do that all the time"). A salesperson
// can hand-set the price of an item or an option line to anything from $0
// up, snapshotting the catalogue price alongside it the first time (see
// `listPrice` below) so `recalcAndEnforce`'s whole-document concession check
// can measure the concession afterwards -- that check is what actually
// closes Ross's hole ("if the price they're selling for is less than the
// maximum discount that's allowed... it shouldn't allow them to save the
// quote"): unlike `setItemDiscount`, neither action here does its own
// pre-check against a per-item cap, because a manual price has no
// percentage of its own to compare -- the document-level concession check
// inside `recalcAndEnforce` is the only guard, and it is not optional.

/**
 * Hand-sets a `DocumentItem`'s price -- the customer-facing "what they're
 * actually charged" figure, replacing the catalogue snapshot `addItem` wrote
 * originally. Accepts any non-negative value including `0` (John: "if I give
 * it away for zero dollars... I give them back zero dollars" -- a demo unit
 * really can be quoted at $0). The item's `listPrice` is snapshotted from
 * its *current* `unitPrice` the first time this is ever called on it (a
 * fresh item's `listPrice` already equals its `unitPrice` from `addItem`, so
 * this is a no-op then; it only matters for a pre-migration row backfilled
 * with `listPrice = unitPrice` -- either way, this action never overwrites
 * an already-recorded `listPrice`, so a second edit measures against the
 * original catalogue price, not the previous manual one).
 *
 * A CREDIT ITEM MAY BE TYPED WITH A MINUS SIGN: the item is queried before
 * the price is validated (unlike every other action in this directory, which
 * validates first) specifically so that check can pick the right schema —
 * `creditUnitPriceSchema` (allows one leading `-`, then strips it) for a
 * credit item (`item.product?.isCredit`), plain `unitPriceSchema` (rejects a
 * negative outright) for an ordinary one. See `creditUnitPriceSchema`'s own
 * doc comment (src/lib/validation/documents.ts) for why the two behave
 * differently — the short version: a trade-in already reads as negative on
 * screen, so `-20000` is a reasonable mental model for it and not worth
 * interrupting the salesperson over, while a negative price on an ordinary
 * item is a plain data-entry mistake. Either way the STORED value is always
 * non-negative — the credit sign is applied only at render time, driven
 * entirely by `EngineItem.isCredit` (see src/lib/pricing.ts), never by what
 * was typed here.
 */
export async function setItemUnitPrice(itemId: string, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();

  const parsedItemId = idSchema.safeParse(itemId);
  if (!parsedItemId.success) return { error: NOT_FOUND_ERROR };

  const item = await db.documentItem.findFirst({
    where: {
      id: parsedItemId.data,
      document: { status: "DRAFT", ...documentWhereForUser(session.user) },
    },
    select: { id: true, documentId: true, unitPrice: true, listPrice: true, product: { select: { isCredit: true } } },
  });
  if (!item) return { error: NOT_FOUND_ERROR };

  const isCredit = item.product?.isCredit ?? false;
  const priceSchema = isCredit ? creditUnitPriceSchema : unitPriceSchema;
  const parsedValue = priceSchema.safeParse(formData.get("unitPrice"));
  if (!parsedValue.success) return { error: flattenZodError(parsedValue.error) };

  let concessionWarning: string | undefined;
  try {
    await db.$transaction(async (tx) => {
      await assertStillDraft(tx, item.documentId);
      await tx.documentItem.update({
        where: { id: item.id },
        data: {
          unitPrice: new Prisma.Decimal(parsedValue.data),
          listPrice: item.listPrice ?? item.unitPrice,
        },
      });
      concessionWarning = (await recalcAndEnforce(item.documentId, tx, session.user.role)).warning;
    });
  } catch (error) {
    return mapDraftWriteError(error);
  }

  revalidateDocument(item.documentId);
  return concessionWarning ? { warning: concessionWarning } : {};
}

/** Resets a `DocumentItem`'s price back to its own recorded `listPrice`
 * (a no-op, functionally, from the customer's point of view — the item's
 * concession simply goes back to zero). Exists as its own action, rather
 * than making the builder re-type the list figure into `setItemUnitPrice`,
 * because the UI shows the list price struck through specifically so a
 * single click can restore it. */
export async function resetItemUnitPrice(itemId: string): Promise<ActionResult> {
  const session = await requireSession();

  const parsedItemId = idSchema.safeParse(itemId);
  if (!parsedItemId.success) return { error: NOT_FOUND_ERROR };

  const item = await db.documentItem.findFirst({
    where: {
      id: parsedItemId.data,
      document: { status: "DRAFT", ...documentWhereForUser(session.user) },
    },
    select: { id: true, documentId: true, listPrice: true },
  });
  if (!item) return { error: NOT_FOUND_ERROR };
  if (item.listPrice === null) return {};

  let concessionWarning: string | undefined;
  try {
    await db.$transaction(async (tx) => {
      await assertStillDraft(tx, item.documentId);
      await tx.documentItem.update({ where: { id: item.id }, data: { unitPrice: item.listPrice! } });
      concessionWarning = (await recalcAndEnforce(item.documentId, tx, session.user.role)).warning;
    });
  } catch (error) {
    return mapDraftWriteError(error);
  }

  revalidateDocument(item.documentId);
  return concessionWarning ? { warning: concessionWarning } : {};
}

/** Hand-sets an OPTION `DocumentLine`'s price — same rules as
 * `setItemUnitPrice`, one level down. Deliberately matches only `kind:
 * "OPTION"` (never a CUSTOM/extra line, which already gets an arbitrary
 * price — including negative, for a trade-in — at creation via
 * `addCustomLine`, and has no catalogue price to snapshot a concession
 * against in the first place). */
export async function setLineUnitPrice(lineId: string, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();

  const parsedLineId = idSchema.safeParse(lineId);
  if (!parsedLineId.success) return { error: NOT_FOUND_ERROR };

  const parsedValue = unitPriceSchema.safeParse(formData.get("unitPrice"));
  if (!parsedValue.success) return { error: flattenZodError(parsedValue.error) };

  const line = await db.documentLine.findFirst({
    where: {
      id: parsedLineId.data,
      kind: "OPTION",
      document: { status: "DRAFT", ...documentWhereForUser(session.user) },
    },
    select: { id: true, documentId: true, unitPrice: true, listPrice: true },
  });
  if (!line) return { error: NOT_FOUND_ERROR };

  let concessionWarning: string | undefined;
  try {
    await db.$transaction(async (tx) => {
      await assertStillDraft(tx, line.documentId);
      await tx.documentLine.update({
        where: { id: line.id },
        data: {
          unitPrice: new Prisma.Decimal(parsedValue.data),
          listPrice: line.listPrice ?? line.unitPrice,
        },
      });
      concessionWarning = (await recalcAndEnforce(line.documentId, tx, session.user.role)).warning;
    });
  } catch (error) {
    return mapDraftWriteError(error);
  }

  revalidateDocument(line.documentId);
  return concessionWarning ? { warning: concessionWarning } : {};
}

/** Resets an OPTION `DocumentLine`'s price back to its own recorded
 * `listPrice` — see `resetItemUnitPrice`'s doc comment, same reasoning one
 * level down. */
export async function resetLineUnitPrice(lineId: string): Promise<ActionResult> {
  const session = await requireSession();

  const parsedLineId = idSchema.safeParse(lineId);
  if (!parsedLineId.success) return { error: NOT_FOUND_ERROR };

  const line = await db.documentLine.findFirst({
    where: {
      id: parsedLineId.data,
      kind: "OPTION",
      document: { status: "DRAFT", ...documentWhereForUser(session.user) },
    },
    select: { id: true, documentId: true, listPrice: true },
  });
  if (!line) return { error: NOT_FOUND_ERROR };
  if (line.listPrice === null) return {};

  let concessionWarning: string | undefined;
  try {
    await db.$transaction(async (tx) => {
      await assertStillDraft(tx, line.documentId);
      await tx.documentLine.update({ where: { id: line.id }, data: { unitPrice: line.listPrice! } });
      concessionWarning = (await recalcAndEnforce(line.documentId, tx, session.user.role)).warning;
    });
  } catch (error) {
    return mapDraftWriteError(error);
  }

  revalidateDocument(line.documentId);
  return concessionWarning ? { warning: concessionWarning } : {};
}
