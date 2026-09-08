import { cache } from "react";
import { db } from "@/lib/db";

export type RegionAdminListItem = {
  id: string;
  code: string;
  name: string;
  currency: string;
  /** Null means "derive it from `currency`" — see Region.currencySymbol. */
  currencySymbol: string | null;
  taxName: string;
  taxRate: string;
  entityName: string;
  active: boolean;
};

/** Every region in the system (active and inactive), ordered by code — feeds
 * the ADMIN-only /settings/regions list. Unlike `listActiveRegions`
 * (src/lib/queries/catalog.ts), inactive regions are included here since an
 * admin needs to see and reactivate them. */
export async function listRegionsAdmin(): Promise<RegionAdminListItem[]> {
  const regions = await db.region.findMany({ orderBy: { code: "asc" } });
  return regions.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    currency: r.currency,
    currencySymbol: r.currencySymbol,
    taxName: r.taxName,
    taxRate: r.taxRate.toString(),
    entityName: r.entityName,
    active: r.active,
  }));
}

export type RegionAdminDetail = {
  id: string;
  code: string;
  name: string;
  currency: string;
  /** Null means "derive it from `currency`" — see Region.currencySymbol. */
  currencySymbol: string | null;
  taxName: string;
  taxRate: string;
  entityName: string;
  entityLegalId: string | null;
  entityAddress: string | null;
  bankDetails: Record<string, string> | null;
  logoUrl: string | null;
  footerText: string | null;
  /** String form of the region's discount cap (like `taxRate`), or `null`
   * for no cap — feeds the region edit form's `maxDiscountPct` default and
   * is enforced in setItemDiscount/setDocumentDiscount
   * (src/lib/actions/documents.ts). */
  maxDiscountPct: string | null;
  /** String form of the region's markup ceiling (like `maxDiscountPct`), or
   * `null` for no ceiling — feeds the region edit form's `maxMarkupPct`
   * default and is enforced via `documentConcession`/`recalcAndEnforce`
   * (src/lib/actions/documents.ts) — the mirror of `maxDiscountPct` for
   * pricing above list instead of below it. */
  maxMarkupPct: string | null;
  active: boolean;
};

/** Narrows `Region.bankDetails` (an untyped `Json?` column) down to the flat
 * string->string shape the editor and `bankDetailsSchema`
 * (src/lib/validation/regions.ts) both expect. Anything else stored there
 * (an old shape, a stray array, non-string values) is treated as absent
 * rather than surfaced — the column is only ever written by
 * `bankDetailsSchema`'s own validated output, so this is a defensive
 * fallback, not the primary guarantee. */
function toBankDetails(value: unknown): Record<string, string> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/** A single region by id, or `null` if it doesn't exist — feeds the
 * /settings/regions/[regionId] edit page, which reads it both in
 * `generateMetadata` and in the page body, hence the request memo. */
export const getRegionAdmin = cache(async function getRegionAdmin(
  regionId: string
): Promise<RegionAdminDetail | null> {
  const region = await db.region.findUnique({ where: { id: regionId } });
  if (!region) return null;

  return {
    id: region.id,
    code: region.code,
    name: region.name,
    currency: region.currency,
    currencySymbol: region.currencySymbol,
    taxName: region.taxName,
    taxRate: region.taxRate.toString(),
    entityName: region.entityName,
    entityLegalId: region.entityLegalId,
    entityAddress: region.entityAddress,
    bankDetails: toBankDetails(region.bankDetails),
    logoUrl: region.logoUrl,
    footerText: region.footerText,
    maxDiscountPct: region.maxDiscountPct?.toString() ?? null,
    maxMarkupPct: region.maxMarkupPct?.toString() ?? null,
    active: region.active,
  };
});

/** Count of currently active users assigned to `regionId` — feeds the
 * deactivate guard in `updateRegion` (src/lib/actions/regions.ts): a region
 * with active users assigned can't be deactivated. Computed fresh on every
 * mutating action rather than cached, since it gates a safety check (mirrors
 * `countActiveAdmins` in src/lib/queries/users.ts). */
export async function countActiveUsersInRegion(regionId: string): Promise<number> {
  return db.user.count({ where: { regionId, active: true } });
}
