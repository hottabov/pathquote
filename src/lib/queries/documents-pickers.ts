import type { OptionRole } from "@prisma/client";
import { db } from "@/lib/db";
import { companyWhereForUser, type ScopeUser } from "@/lib/scope";
import { compatibilityOrFilter } from "@/lib/catalog-compat";
import {
  isSeriesHidden,
  NO_HIDDEN_CATALOG_IDS,
  type HiddenCatalogIds,
} from "@/lib/catalog-visibility";

/**
 * What the builder's three pickers offer: which client to quote, which
 * product to add, and which options an added item can carry. Each is
 * preloaded whole so the picker itself filters in the browser rather than
 * round-tripping per keystroke.
 */

// --- client picker ---------------------------------------------------------

export type ClientPickerContact = {
  id: string;
  firstName: string;
  lastName: string | null;
  isPrimary: boolean;
};

export type ClientPickerCompany = {
  id: string;
  name: string;
  contacts: ClientPickerContact[];
};

/**
 * Every company `user` can see (scoped like listCompanies in
 * src/lib/queries/clients.ts), each with its contacts ordered primary-first
 * then by first name — preloaded in full for the builder's client-picker
 * client component, which does its own search filtering (companies are a
 * small enough list per manager that a client-side filter beats a
 * per-keystroke server round trip).
 */
export async function listClientPickerCompanies(user: ScopeUser): Promise<ClientPickerCompany[]> {
  const companies = await db.company.findMany({
    where: companyWhereForUser(user),
    orderBy: { name: "asc" },
    include: {
      contacts: { orderBy: [{ isPrimary: "desc" }, { firstName: "asc" }] },
    },
  });

  return companies.map((c) => ({
    id: c.id,
    name: c.name,
    contacts: c.contacts.map((contact) => ({
      id: contact.id,
      firstName: contact.firstName,
      lastName: contact.lastName,
      isPrimary: contact.isPrimary,
    })),
  }));
}

// --- item picker ---------------------------------------------------------

export type ItemPickerProduct = {
  /** `Product.id` -- what `addItem` takes. `code` is display only. */
  id: string;
  code: string;
  name: string;
  priced: boolean;
};

export type ItemPickerSeries = {
  id: string;
  code: string;
  name: string;
  maxDiscountPct: string | null;
  products: ItemPickerProduct[];
};

/**
 * The whole catalog tree (every series, each with its active products),
 * flagged per-product with whether it has a usable price in `regionCode`
 * (a price row that exists and isn't `needsReview`) — the "Add item" picker
 * preloads this once so choosing a series/product is instant, and disables
 * unpriced products with a "price required" hint instead of a second round
 * trip.
 *
 * `hidden` (the caller's own `CatalogVisibility` set — see
 * `catalogVisibilityUserId`/`getHiddenCatalogIds`, defaulting to "nothing
 * hidden") removes a hidden series entirely and drops a hidden product out
 * of its series' list, the same way `addItem` (src/lib/actions/documents.ts)
 * re-checks server-side before actually creating the item — a MANAGER who
 * can't sell a product never sees it here to begin with, an ADMIN (who
 * always resolves to `NO_HIDDEN_CATALOG_IDS`) sees the full catalogue.
 *
 * One query for the whole tree. This used to compose the two general-purpose
 * catalogue queries — a series list, then a products-by-series call per
 * series — which cost 2×series+1 round trips on the single heaviest page in
 * the app, and pulled a full `Region` row along with every price to read
 * nothing off it. Nothing outside the picker needs the composition, so the
 * tree is read directly here instead: prices are narrowed to the document's
 * region by the join and selected down to the one flag `priced` is derived
 * from, and inactive products are dropped by the database rather than in
 * memory afterwards. A series with no visible products still comes back with
 * an empty `products` array, exactly as it did before — the picker shows the
 * series and simply offers nothing under it.
 */
export async function getItemPickerCatalog(
  regionCode: string,
  hidden: HiddenCatalogIds = NO_HIDDEN_CATALOG_IDS
): Promise<ItemPickerSeries[]> {
  const seriesList = await db.series.findMany({
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      code: true,
      name: true,
      maxDiscountPct: true,
      products: {
        where: { active: true },
        // Same ordering `listProductsBySeriesById` uses, and for the same
        // reason: every product defaults to `sortOrder: 0`, so a series
        // nobody has reordered reads alphabetically by code.
        orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
        select: {
          id: true,
          code: true,
          name: true,
          prices: { where: { region: { code: regionCode } }, select: { needsReview: true } },
        },
      },
    },
  });

  return seriesList
    .filter((series) => !isSeriesHidden(series.id, hidden))
    .map((series) => ({
      id: series.id,
      code: series.code,
      name: series.name,
      maxDiscountPct: series.maxDiscountPct?.toString() ?? null,
      products: series.products
        .filter((product) => !hidden.productIds.has(product.id))
        .map((product) => {
          const price = product.prices[0];
          return {
            id: product.id,
            code: product.code,
            name: product.name,
            priced: Boolean(price && !price.needsReview),
          };
        }),
    }));
}

// --- options editor ---------------------------------------------------------

export type CompatibleOption = {
  id: string;
  code: string;
  name: string;
  shortDescription: string | null;
  /** Raw `Option.attributeSchema`, expected shape (when present) is an array
   * of `{key, label, type: "number"|"text"}` — the options editor is
   * responsible for tolerating anything else (see its `parseAttributeFields`
   * helper) since this is unvalidated admin-entered JSON. */
  attributeSchema: unknown;
  /** `Option.role` -- what the builder uses to recognise the rows an
   * EasyLoader's table layout owns (see `EL_MODULE_ROLES`) and lock them in
   * the options editor. `null` for an option no form or builder keys on. */
  role: OptionRole | null;
  /** `Option.unitLengthM` as a plain number -- the per-unit length of an
   * option sold by the section (1.2 for an EasyLoader length, 1 for MTS
   * travel), which the options editor multiplies by the quantity into a
   * running metre total (see src/lib/option-length.ts). `null` for an option
   * sold by the piece. Converted from Prisma's `Decimal` here, at the query
   * boundary, so the client component never sees one. */
  unitLengthM: number | null;
  price: { amount: string; needsReview: boolean } | null;
  /** `Option.imageUrl`, rendered as a small icon next to the option in the
   * builder's options editor when present and the "ui.showOptionIcons" app
   * setting is on (see `getShowOptionIcons`, src/lib/queries/settings.ts) —
   * `null` (most options today) shows no icon and no placeholder. */
  imageUrl: string | null;
  /** Every option this one conflicts with — i.e. every *other* option that
   * shares at least one `OptionConflictGroup` with it (see that model's
   * comment in schema.prisma) — by id (what the builder matches on) plus
   * code/name and the shared group's name (what it shows), not just the
   * ones also compatible with this item, since an incompatible partner can
   * never be selected anyway and so can never trip the conflict. The
   * builder (`ItemOptionsEditor`) checks this against the *other*
   * currently-selected ids to decide whether to disable this option (see
   * `isOptionDisabled`'s `conflictingWith` parameter) — never against
   * itself. `groupName` names whichever shared group produced that partner
   * (the first found, if a pair happens to share more than one) — enough to
   * explain a block without an exhaustive list. */
  conflictsWith: { id: string; code: string; name: string; groupName: string }[];
};

/**
 * Active options compatible with `productId` and/or `seriesId` — an option
 * counts as compatible when it has a compat row at either the series level
 * (matching `seriesId`) or the product level (matching `productId`; e.g.
 * EasyLoader accessories are only compatible with product EL-2020, not the
 * whole EasyLoader series) — see `compatibilityOrFilter`. Each result
 * carries its price in `regionId` if one exists. Preloaded once per distinct
 * (productId, seriesId) pair on the builder page (not per item) and handed
 * to each item's options editor — a product with no price row at all, or
 * one flagged `needsReview`, is still included (so the editor can show it
 * disabled with "price required") rather than silently hidden.
 */
export async function listCompatibleOptions(
  productId: string | null,
  seriesId: string | null,
  regionId: string
): Promise<CompatibleOption[]> {
  const or = compatibilityOrFilter(productId, seriesId);
  if (!or) return [];

  const options = await db.option.findMany({
    where: { active: true, compat: { some: { OR: or } } },
    orderBy: { sortOrder: "asc" },
    include: {
      prices: { where: { regionId } },
      conflictGroupMemberships: { select: { groupId: true } },
    },
  });

  // Every group referenced by any of these options, each with its full
  // member list and name — one extra query beats an N+1 (one per option),
  // and options sharing the same group is the whole point of a group.
  const groupIds = Array.from(
    new Set(options.flatMap((o) => o.conflictGroupMemberships.map((m) => m.groupId)))
  );
  const groups =
    groupIds.length > 0
      ? await db.optionConflictGroup.findMany({
          where: { id: { in: groupIds } },
          include: {
            members: { include: { option: { select: { id: true, code: true, name: true } } } },
          },
        })
      : [];
  const groupById = new Map(groups.map((g) => [g.id, g]));

  return options.map((o) => {
    const price = o.prices[0];

    // Union every OTHER option across every group this one belongs to,
    // deduped by id — an option can be in more than one group, and the same
    // partner must never appear twice just because two groups both link
    // them. `groupName` on a partner is whichever shared group was found
    // first (see the CompatibleOption.conflictsWith doc comment above).
    const partnersById = new Map<string, { id: string; code: string; name: string; groupName: string }>();
    for (const membership of o.conflictGroupMemberships) {
      const group = groupById.get(membership.groupId);
      if (!group) continue;
      for (const member of group.members) {
        if (member.option.id === o.id) continue;
        if (partnersById.has(member.option.id)) continue;
        partnersById.set(member.option.id, {
          id: member.option.id,
          code: member.option.code,
          name: member.option.name,
          groupName: group.name,
        });
      }
    }

    return {
      id: o.id,
      code: o.code,
      name: o.name,
      shortDescription: o.shortDescription,
      attributeSchema: o.attributeSchema,
      role: o.role,
      unitLengthM: o.unitLengthM !== null ? Number(o.unitLengthM) : null,
      price: price ? { amount: price.amount.toString(), needsReview: price.needsReview } : null,
      imageUrl: o.imageUrl,
      conflictsWith: Array.from(partnersById.values()),
    };
  });
}
