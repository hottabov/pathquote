import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Package, Plus } from "lucide-react";
import { auth } from "@/auth";
import { isAdminRole } from "@/lib/roles";
import {
  listProductsBySeriesById,
  getSeriesFallbackImageUrl,
  type ProductListItem,
} from "@/lib/queries/catalog";
import { catalogVisibilityUserId, isSeriesHidden } from "@/lib/catalog-visibility";
import { getHiddenCatalogIds } from "@/lib/queries/catalog-visibility";
import { updateSeriesImage, reorderProducts } from "@/lib/actions/catalog";
import { SeriesImageCard } from "@/components/catalog/series-image-card";
import { ProductReorderList } from "@/components/catalog/product-reorder-list";
import { PriceDisplay, InactiveBadge } from "@/components/catalog-badges";
import { CatalogThumb } from "@/components/catalog/catalog-thumb";
import { buttonVariants } from "@/components/ui/button";
import {
  PageHeader,
  TableShell,
  RowCell,
  tableClassName,
  tableHeadRowClassName,
  tableRowClassName,
  EmptyState,
} from "@/components/ui-kit";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// Routed by Series.id, not Series.code. Same reasoning as
// `/catalog/options/[optionId]` (see the doc comment there): a code is free
// text an admin can edit, and a `/` in it encodes to `%2F`, which Node/Next
// normalise back into a path separator before route matching, so the
// dynamic segment never matches and the page 404s. No series code contains
// a slash today, but nothing stops one being renamed into one, and an id
// never changes either way. Don't "simplify" this back to the code.
type Params = { seriesId: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { seriesId } = await params;
  // Metadata runs before the page body — re-check hidden-ness here too
  // (same reasoning the document builder's own generateMetadata gives) so a
  // manager browsing to a hidden series' URL never even sees its name in
  // the tab title.
  const [result, session] = await Promise.all([listProductsBySeriesById(seriesId), auth()]);
  if (!result) return { title: "Series" };
  const hiddenCatalogIds = await getHiddenCatalogIds(catalogVisibilityUserId(session?.user));
  if (isSeriesHidden(result.series.id, hiddenCatalogIds)) return { title: "Series" };
  return { title: result.series.name };
}

export default async function SeriesProductsPage({ params }: { params: Promise<Params> }) {
  const { seriesId } = await params;
  const [result, session] = await Promise.all([listProductsBySeriesById(seriesId), auth()]);

  if (!result) notFound();

  const { series } = result;
  const isAdmin = isAdminRole(session?.user?.role);
  // Both reads depend only on the session and the series just loaded, so
  // they go out together. The fallback image is only needed for the admin
  // "Series image" panel below, and an ADMIN never fails the hidden-series
  // check underneath, so pairing it with the visibility read here still
  // never issues a query for a request that ends in a 404.
  const [hiddenCatalogIds, fallbackImageUrl] = await Promise.all([
    getHiddenCatalogIds(catalogVisibilityUserId(session?.user)),
    isAdmin ? getSeriesFallbackImageUrl(series.id) : null,
  ]);
  // A hidden series is absent, full stop — a MANAGER hitting its URL
  // directly (bookmark, typed URL) gets the same 404 as a nonexistent
  // series, same "never distinguish the two" rule `documentWhereForUser`
  // callers already follow for a foreign document.
  if (!isAdmin && isSeriesHidden(series.id, hiddenCatalogIds)) notFound();
  // A visible series can still have individually-hidden products under it.
  const products = isAdmin
    ? result.products
    : result.products.filter((p) => !hiddenCatalogIds.productIds.has(p.id));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        backHref="/catalog"
        backLabel="Catalog"
        title={series.name}
        description={series.code}
        actions={
          isAdmin ? (
            <Link
              href={`/catalog/${series.id}/new`}
              className={cn(
                buttonVariants(),
                "h-11 w-full bg-brand text-white hover:bg-brand/90 sm:w-auto"
              )}
            >
              <Plus className="size-4" data-icon="inline-start" aria-hidden="true" />
              Add product
            </Link>
          ) : undefined
        }
      />

      {products.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No products in this series yet"
          description={isAdmin ? "Add the first one above." : undefined}
        />
      ) : isAdmin ? (
        // ADMIN (or DEVELOPER — see `requireAdmin`) gets drag-to-reorder
        // instead of the read-only table/cards split below — see
        // `ProductReorderList`'s own doc comment for why it's one adaptive
        // list rather than a `<table>` + cards pair. Untouched products
        // still read alphabetically (every `sortOrder` defaults to 0, and
        // `listProductsBySeriesById` ties on `code`) — dragging one only
        // ever reindexes the whole series at once, so the list never shows
        // a half-ordered mix of dragged and alphabetical rows.
        <ProductReorderList seriesId={series.id} products={products} reorderProductsAction={reorderProducts} />
      ) : (
        <TableShell
          table={
            <table className={tableClassName}>
              <thead>
                <tr className={tableHeadRowClassName}>
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Image</span>
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Code
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Description
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    Price
                  </th>
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Status</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <ProductRow key={p.id} seriesId={series.id} product={p} />
                ))}
              </tbody>
            </table>
          }
          cards={products.map((p) => (
            <ProductCard key={p.id} seriesId={series.id} product={p} />
          ))}
        />
      )}

      {isAdmin ? (
        <SeriesImageCard
          currentUrl={series.imageUrl}
          fallbackImageUrl={fallbackImageUrl}
          alt={series.name}
          onSave={updateSeriesImage.bind(null, series.id)}
        />
      ) : null}
    </div>
  );
}

function ProductRow({
  seriesId,
  product: p,
}: {
  seriesId: string;
  product: ProductListItem;
}) {
  const href = `/catalog/${seriesId}/${p.id}`;
  return (
    <tr className={cn(tableRowClassName, p.active ? "" : "opacity-60")}>
      <RowCell href={href}>
        {/* Product photos are landscape (1280x768 as shot), so they get a
            wider box than CatalogThumb's square default. Its own reserved
            spacer (see CatalogThumb's doc comment) keeps every row's Code
            column aligned even for products with no image yet. */}
        <CatalogThumb src={p.imageUrl} width={64} />
      </RowCell>
      <RowCell href={href} primary={`Open ${p.name}`}>
        <span aria-hidden="true" className="font-mono text-sm text-brand-dark">
          {p.code}
        </span>
      </RowCell>
      <RowCell href={href}>
        <span className="text-sm text-slate-700">{p.name}</span>
      </RowCell>
      <RowCell href={href}>
        {p.description ? (
          <span className="block max-w-[280px] truncate text-sm text-slate-500">{p.description}</span>
        ) : null}
      </RowCell>
      <RowCell href={href} align="right">
        <PriceDisplay price={p.price} />
      </RowCell>
      <RowCell href={href} align="right">
        {!p.active ? <InactiveBadge /> : null}
      </RowCell>
    </tr>
  );
}

function ProductCard({
  seriesId,
  product: p,
}: {
  seriesId: string;
  product: ProductListItem;
}) {
  return (
    <Link
      href={`/catalog/${seriesId}/${p.id}`}
      className={cn(
        "focus-ring flex min-h-12 gap-3 rounded-xl border border-slate-200 bg-white p-4 transition-colors active:bg-slate-100",
        p.active ? "" : "opacity-60"
      )}
    >
      {/* Same reading order as the table row: image, then code, then name,
          then description. */}
      <CatalogThumb src={p.imageUrl} width={64} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="font-mono text-sm text-brand-dark">{p.code}</span>
            {!p.active ? <InactiveBadge /> : null}
          </div>
          <PriceDisplay price={p.price} />
        </div>
        <p className="truncate text-sm text-slate-700">{p.name}</p>
        {p.description ? <p className="truncate text-xs text-slate-500">{p.description}</p> : null}
      </div>
    </Link>
  );
}
