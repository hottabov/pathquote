import { cache } from "react";
import { db } from "@/lib/db";
import {
  NO_HIDDEN_CATALOG_IDS,
  type HiddenCatalogIds,
} from "@/lib/catalog-visibility";

/**
 * Every hidden series/product id for `userId` — the one DB round trip every
 * filtered catalogue query/page needs, resolved once per request and
 * threaded through to the pure filtering helpers in
 * src/lib/catalog-visibility.ts. `userId === null` (an ADMIN — see
 * `catalogVisibilityUserId`) short-circuits to `NO_HIDDEN_CATALOG_IDS`
 * without a query; a real user with no rows of their own gets back the same
 * empty sets from the query itself, which is the feature's actual default
 * (see the CatalogVisibility model's own doc comment).
 *
 * "Resolved once per request" is now enforced rather than merely intended:
 * several catalogue pages resolve it in `generateMetadata` and again in the
 * page body, and React's `cache` collapses those into one query (the userId
 * argument is a plain string, so the two calls hash to the same key). The
 * memo is scoped to a single render — see `getQuoteValidityDays`
 * (src/lib/queries/settings.ts) for why that can't leak past one.
 */
export const getHiddenCatalogIds = cache(async function getHiddenCatalogIds(
  userId: string | null
): Promise<HiddenCatalogIds> {
  if (!userId) return NO_HIDDEN_CATALOG_IDS;

  const rows = await db.catalogVisibility.findMany({
    where: { userId },
    select: { seriesId: true, productId: true },
  });

  return {
    seriesIds: new Set(rows.map((r) => r.seriesId).filter((id): id is string => id !== null)),
    productIds: new Set(rows.map((r) => r.productId).filter((id): id is string => id !== null)),
  };
});
