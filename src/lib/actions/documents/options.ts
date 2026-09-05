"use server";

/**
 * An item's OPTION lines: the hand-picked set a manager saves from the
 * options editor, and the EasyLoader table layout that derives its own set
 * from a drawn table. Both go through the same private `writeItemOptions`,
 * which is the only place OPTION lines are ever written.
 */

import { revalidateDocument } from "@/lib/revalidate";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { documentWhereForUser, type ScopeUser } from "@/lib/scope";
import {
  compatibilityOrFilter,
  findConflictingSelection,
  conflictPartnersByGroup,
} from "@/lib/catalog-compat";
import { recalcAndEnforce } from "@/lib/documents/recalc";
import { easyLoaderSpecSchema } from "@/lib/validation/production-spec";
import {
  deriveEasyLoaderOptions,
  EL_MODULE_ROLE_LIST,
  isEasyLoaderModuleRole,
} from "@/lib/production-forms/table-sections";
import { idSchema, optionSelectionSchema, type OptionSelectionInput } from "@/lib/validation/documents";
import { NOT_FOUND_ERROR, flattenZodError } from "../_shared";
import {
  abortDraftWrite,
  assertStillDraft,
  mapDraftWriteError,
  type ActionResult,
} from "./_internal";

const MAX_OPTION_SELECTIONS = 100;

/**
 * Replaces an item's OPTION lines with exactly `selections`, preserving
 * selection order as `sortOrder`. Every option id must (a) resolve to a
 * real, active-or-not `Option` row, (b) be compatible with the item —
 * either via a series-level `OptionCompatibility` row (matching the item's
 * product's series) or a product-level one (matching the item's product
 * directly, e.g. EasyLoader accessories scoped to EL-2020 — see
 * `compatibilityOrFilter`) — and (c) carry a usable price (exists, not
 * `needsReview`) in the *document's* region — otherwise
 * nothing is written at all and the offending options are named in the
 * returned error, checked in that order (unknown, then incompatible, then
 * unpriced, then conflicting — see `findConflictingSelection`) so the caller
 * always gets one actionable message. Delete+create happens in a single
 * transaction so a failed create can never leave an item with no options
 * where it had some a moment ago. Scoped through item -> document -> author
 * chain and DRAFT-only, like every other item mutation in this directory.
 *
 * The conflict check only governs what this call is about to *write* — an
 * item that already carries two now-conflicting OPTION lines (saved before
 * the conflict existed, or before this rejection existed) keeps those lines
 * and its totals exactly as they are until the next `setItemOptions` call
 * for that item; nothing here re-validates existing `DocumentLine` rows on
 * read (recalc/totals work purely off what's already stored — see
 * `recalcAndEnforce`/`computeTotals`, neither of which touches
 * `OptionConflictGroup` at all). A save that resubmits the same two
 * conflicting options unchanged is still a save, though, and is rejected
 * exactly like a brand-new one — the rule is "no new writes with a
 * conflicting pair", not "grandfather whatever was already there".
 */
export async function setItemOptions(
  itemId: string,
  selections: OptionSelectionInput[]
): Promise<ActionResult> {
  const session = await requireSession();
  return writeItemOptions(session.user, itemId, selections);
}

/**
 * The body of `setItemOptions`, reachable by one other caller:
 * `setEasyLoaderLayout`, which computes an EasyLoader's option lines from
 * its table layout and then needs exactly these checks -- compatibility,
 * pricing, conflicts, the delete/create/recalc transaction -- applied to
 * them. Split out rather than duplicated so a derived selection can never be
 * written under looser rules than a hand-picked one.
 *
 * `alsoWrite`, when given, runs against the same `tx` as the option lines
 * and therefore commits or rolls back with them. It exists for
 * `setEasyLoaderLayout`, whose table layout and option lines are two
 * descriptions of one machine: committing either without the other prices a
 * table nobody asked for, or builds one nobody paid for. It must abort
 * through `abortDraftWrite` (or another sentinel `mapDraftWriteError` knows)
 * rather than returning a failure, since by the time it runs the deletes and
 * creates around it are already staged.
 */
async function writeItemOptions(
  user: ScopeUser,
  itemId: string,
  selections: OptionSelectionInput[],
  alsoWrite?: (tx: Prisma.TransactionClient) => Promise<void>
): Promise<ActionResult> {
  const parsedItemId = idSchema.safeParse(itemId);
  if (!parsedItemId.success) return { error: NOT_FOUND_ERROR };

  if (!Array.isArray(selections) || selections.length > MAX_OPTION_SELECTIONS) {
    return { error: "Invalid selection" };
  }
  const parsedSelections = z.array(optionSelectionSchema).safeParse(selections);
  if (!parsedSelections.success) return { error: flattenZodError(parsedSelections.error) };

  const ids = parsedSelections.data.map((s) => s.optionId);
  if (new Set(ids).size !== ids.length) {
    return { error: "Each option can only be selected once" };
  }

  const item = await db.documentItem.findFirst({
    where: {
      id: parsedItemId.data,
      document: { status: "DRAFT", ...documentWhereForUser(user) },
    },
    include: { document: true, product: { include: { series: true } } },
  });
  if (!item) return { error: NOT_FOUND_ERROR };
  if (!item.product) return { error: "This item has no product to attach options to" };

  if (ids.length === 0) {
    let concessionWarning: string | undefined;
    try {
      await db.$transaction(async (tx) => {
        await assertStillDraft(tx, item.documentId);
        await tx.documentLine.deleteMany({ where: { itemId: item.id, kind: "OPTION" } });
        await alsoWrite?.(tx);
        concessionWarning = (await recalcAndEnforce(item.documentId, tx, user.role)).warning;
      });
    } catch (error) {
      return mapDraftWriteError(error);
    }
    revalidateDocument(item.documentId);
    return concessionWarning ? { warning: concessionWarning } : {};
  }

  // item.product is checked truthy above, so both its id and seriesId
  // (a required field on Product) are always available here — the OR filter
  // is never null in practice, but the `?? []` keeps the type honest.
  const compatOr = compatibilityOrFilter(item.product.id, item.product.seriesId) ?? [];
  const options = await db.option.findMany({
    where: { id: { in: ids } },
    include: {
      prices: { where: { regionId: item.document.regionId } },
      compat: { where: { OR: compatOr } },
      // Every `OptionConflictGroup` this option belongs to -- see that
      // model's comment in schema.prisma. Only fetched for the *submitted*
      // options (this `where: { id: { in: ids } }` above) -- correct,
      // since `conflictPartnersByGroup` below only needs to know which
      // *submitted* options share a group with which other submitted
      // options, never who else (outside this submission) is in that group.
      conflictGroupMemberships: { select: { groupId: true } },
    },
  });
  const optionById = new Map(options.map((o) => [o.id, o]));

  // Errors name options by code -- that is what the manager sees on screen.
  // An unknown id has no code to show, so it is named as it came.
  const missingIds: string[] = [];
  const incompatibleCodes: string[] = [];
  const unpricedCodes: string[] = [];
  for (const id of ids) {
    const option = optionById.get(id);
    if (!option) {
      missingIds.push(id);
      continue;
    }
    if (option.compat.length === 0) {
      incompatibleCodes.push(option.code);
      continue;
    }
    const price = option.prices[0];
    if (!price || price.needsReview) {
      unpricedCodes.push(option.code);
    }
  }
  if (missingIds.length > 0) {
    return { error: `Unknown option(s): ${missingIds.join(", ")}` };
  }
  if (incompatibleCodes.length > 0) {
    return {
      error: `Not compatible with ${item.product.series.name}: ${incompatibleCodes.join(", ")}`,
    };
  }
  if (unpricedCodes.length > 0) {
    return { error: `Price required for: ${unpricedCodes.join(", ")}` };
  }

  const conflictsById = conflictPartnersByGroup(
    options.flatMap((option) =>
      option.conflictGroupMemberships.map((m) => ({ memberKey: option.id, groupId: m.groupId }))
    )
  );
  const conflictingPair = findConflictingSelection(ids, conflictsById);
  if (conflictingPair) {
    const a = optionById.get(conflictingPair[0])!.code;
    const b = optionById.get(conflictingPair[1])!.code;
    return { error: `${a} conflicts with ${b} — remove one before saving` };
  }

  // Delete+create+recalc all in one interactive transaction (previously
  // delete+create alone, as a batch `$transaction([...])`; folding the
  // recalc in means a failed create *or* a resulting negative subtotal both
  // roll back the whole thing, never leaving an item with no options where
  // it had some a moment ago, or a set of options committed that the
  // negative-subtotal guard should have rejected). A caller's `alsoWrite`
  // joins the same transaction for the same reason.
  let concessionWarning: string | undefined;
  try {
    await db.$transaction(async (tx) => {
      await assertStillDraft(tx, item.documentId);
      await tx.documentLine.deleteMany({ where: { itemId: item.id, kind: "OPTION" } });
      // One `createMany` rather than a `create` per selection: an option line
      // is written and never read back here (nothing downstream needs the
      // generated ids — the recalc below works off the document, not off
      // these rows), so the whole set goes in a single round trip instead of
      // holding the transaction open for one per option.
      await tx.documentLine.createMany({
        data: parsedSelections.data.map((selection, index) => {
          const option = optionById.get(selection.optionId)!;
          const price = option.prices[0]!;
          return {
            documentId: item.documentId,
            itemId: item.id,
            kind: "OPTION" as const,
            refId: option.id,
            code: option.code,
            name: option.name,
            description: option.shortDescription,
            qty: selection.qty,
            unitPrice: price.amount,
            // Snapshot the catalogue price too — see setItemUnitPrice's
            // comment. A freshly (re)selected option always starts equal to
            // its list price; any prior manual edit to this option line is
            // gone anyway once selections are resaved (this whole-set
            // replace deletes and recreates every OPTION line).
            listPrice: price.amount,
            attributes: selection.attributes as Prisma.InputJsonValue | undefined,
            sortOrder: index,
          };
        }),
      });
      await alsoWrite?.(tx);
      concessionWarning = (await recalcAndEnforce(item.documentId, tx, user.role)).warning;
    });
  } catch (error) {
    return mapDraftWriteError(error);
  }

  revalidateDocument(item.documentId);
  return concessionWarning ? { warning: concessionWarning } : {};
}

/**
 * Saves an EasyLoader's table layout and rewrites the option lines that
 * layout adds up to.
 *
 * The EasyLoader is sold as a table assembled from 1.2 metre modules, and
 * the machine itself now costs nothing: every part of it is an option. So a
 * manager draws the table -- how many sections, how long each is, conveyor
 * or static, whether a FabricPro has to run along it -- and the drive
 * modules, lengths, busbar and rail follow from that. See
 * `deriveEasyLoaderOptions` for the arithmetic.
 *
 * The manager's own EasyLoader options -- roll holder, sync feature, crate
 * -- are kept exactly as they are. Only the derived family is replaced, so
 * redrawing the table never silently drops an accessory that was sold with
 * it.
 *
 * DRAFT-only, unlike `setProductionSpec`, which this otherwise resembles:
 * that one writes facts the workshop needs and no money, while this one
 * moves the price of the machine. Correcting a knife size on a finalized
 * quote is housekeeping; re-pricing one is not.
 */
export async function setEasyLoaderLayout(itemId: string, spec: unknown): Promise<ActionResult> {
  const session = await requireSession();

  const parsedItemId = idSchema.safeParse(itemId);
  if (!parsedItemId.success) return { error: NOT_FOUND_ERROR };

  const item = await db.documentItem.findFirst({
    where: {
      id: parsedItemId.data,
      document: { status: "DRAFT", ...documentWhereForUser(session.user) },
    },
    select: {
      id: true,
      code: true,
      documentId: true,
      productId: true,
      product: { select: { code: true, form: true } },
      lines: {
        where: { kind: "OPTION" },
        select: { qty: true, attributes: true, refId: true },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  if (!item) return { error: NOT_FOUND_ERROR };

  if (item.product?.form !== "EASYLOADER" || item.productId === null) {
    return { error: "This item is not an EasyLoader" };
  }

  const parsed = easyLoaderSpecSchema.safeParse(spec);
  if (!parsed.success) return { error: flattenZodError(parsed.error) };

  const derived = deriveEasyLoaderOptions(parsed.data.sections, parsed.data.fabricProCompatible);

  // The modules are this width's own options: one per role, scoped to the
  // product by `parentProductId`. A role the catalogue has no row for is a
  // catalogue fault the manager can do nothing about from here, so it is
  // named plainly rather than surfacing as "unknown option" downstream.
  const lineRefIds = item.lines.map((line) => line.refId).filter((id): id is string => id !== null);
  const [moduleOptions, lineOptions] = await Promise.all([
    db.option.findMany({
      where: { parentProductId: item.productId, role: { in: [...EL_MODULE_ROLE_LIST] } },
      select: { id: true, role: true },
    }),
    lineRefIds.length > 0
      ? db.option.findMany({ where: { id: { in: lineRefIds } }, select: { id: true, role: true } })
      : Promise.resolve([]),
  ]);
  const moduleByRole = new Map(moduleOptions.map((option) => [option.role, option]));
  const missingRoles = derived.filter(({ role }) => !moduleByRole.has(role)).map(({ role }) => role);
  if (missingRoles.length > 0) {
    return {
      error: `EasyLoader ${item.product.code} has no ${missingRoles.join(", ")} option in the catalogue`,
    };
  }
  const derivedSelections = derived.map(({ role, qty }) => ({
    optionId: moduleByRole.get(role)!.id,
    qty,
  }));

  // The manager's own picks first, in the order they were in, then the
  // derived rows. Anything in the derived family -- recognised by the
  // option's role, whichever width it belongs to -- that is already on the
  // item is dropped here and re-added from `derived`. That is what makes a
  // section deleted in the builder disappear from the quote. A line is
  // carried over by its `refId` (the option's id), never by its snapshotted
  // code: a line with no `refId` has no catalogue row to resubmit and is
  // dropped, exactly as `writeItemOptions` would reject it.
  const roleByOptionId = new Map(lineOptions.map((option) => [option.id, option.role]));
  const kept = item.lines
    .filter((line): line is typeof line & { refId: string } => line.refId !== null)
    .filter((line) => !isEasyLoaderModuleRole(roleByOptionId.get(line.refId)))
    .map((line) => ({
      optionId: line.refId,
      qty: line.qty,
      attributes: (line.attributes ?? undefined) as Record<string, unknown> | undefined,
    }));

  // The spec and the option lines describe the same table -- the drawing the
  // workshop builds from and the rows the customer is charged for -- so they
  // are written as one transaction rather than one after the other. A
  // rejected pricing check still stops the spec from being saved (that much
  // the old two-step ordering already got right, and `writeItemOptions`
  // returns before opening its transaction in every one of those cases), but
  // the reverse gap is what this closes: a failure between the two writes
  // used to leave priced option lines standing against the previous layout,
  // so the quote charged for one table and the builder drew another, with
  // nothing on either side to reveal the mismatch.
  const written = await writeItemOptions(session.user, item.id, [...kept, ...derivedSelections], async (tx) => {
    const specWritten = await tx.documentItem.updateMany({
      where: { id: item.id, document: { status: "DRAFT" } },
      data: { productionSpec: parsed.data as object },
    });
    // `assertStillDraft` already holds the document row by now, so a miss
    // here means the item itself is gone -- the same "not found" the
    // caller's own pre-read would have given, but it has to be raised rather
    // than returned to take the option lines down with it.
    if (specWritten.count !== 1) abortDraftWrite();
  });

  // `writeItemOptions` has already revalidated on success; on failure there
  // is nothing to revalidate, since the whole transaction rolled back.
  return written;
}
