import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/auth";
import { isAdminRole } from "@/lib/roles";
import { priceRegionIdForSessionUser } from "@/lib/authz";
import { getProductDetailById } from "@/lib/queries/catalog";
import { catalogVisibilityUserId, isProductHidden } from "@/lib/catalog-visibility";
import { getHiddenCatalogIds } from "@/lib/queries/catalog-visibility";
import { updateProduct, deleteProduct, upsertPrice, updateProductImage } from "@/lib/actions/catalog";
import { ProductForm } from "@/components/catalog/product-form";
import { PriceEditor } from "@/components/catalog/price-editor";
import { ImageUpload } from "@/components/catalog/image-upload";
import { DeleteButton } from "@/components/catalog/delete-button";
import { PageHeader, SectionCard } from "@/components/ui-kit";

export const dynamic = "force-dynamic";

// Routed by Product.id, not Product.code (and the series segment by
// Series.id, not Series.code) -- see the doc comment on `Params` in
// `src/app/(app)/catalog/[seriesId]/page.tsx` for why: a code is free text
// an admin can edit, and a `/` in it encodes to `%2F`, which Node/Next
// normalise back into a path separator before route matching, so the
// dynamic segment never matches and the page 404s. No product code contains
// a slash today, but nothing stops one being renamed into one, and an id
// never changes either way. Don't "simplify" this back to codes.
type Params = { seriesId: string; productId: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { productId } = await params;
  // Re-check hidden-ness here too, same reasoning as the series page's own
  // generateMetadata — a hidden product's name/series shouldn't leak into
  // the tab title for a manager who hit its URL directly.
  // The session is resolved first, not alongside the product: the product's
  // price rows are scoped to the viewer's region, so the region has to be
  // known before the fetch. `CatalogLayout`'s `requireRegion` can't supply
  // it — a layout doesn't reliably run before a route's `generateMetadata`.
  const session = await auth();
  const product = await getProductDetailById(
    productId,
    priceRegionIdForSessionUser(session?.user)
  );
  if (!product) return { title: "Product" };
  const hiddenCatalogIds = await getHiddenCatalogIds(catalogVisibilityUserId(session?.user));
  if (isProductHidden({ id: product.id, seriesId: product.series.id }, hiddenCatalogIds)) {
    return { title: "Product" };
  }
  return { title: `${product.code} · ${product.series.name}` };
}

export default async function ProductEditorPage({ params }: { params: Promise<Params> }) {
  const { productId } = await params;
  // Session first, then the product — same reason as `generateMetadata`
  // above, and the same `regionId` value, so `getProductDetailById` stays a
  // single request-memoized query across the two calls.
  const session = await auth();
  const product = await getProductDetailById(
    productId,
    priceRegionIdForSessionUser(session?.user)
  );

  if (!product) notFound();

  const isAdmin = isAdminRole(session?.user?.role);
  // A hidden product (directly, or via a hidden series) is absent for a
  // MANAGER even at its own direct URL — the picker/series-list filtering
  // above only stops a MANAGER discovering it by browsing; without this,
  // a bookmarked or typed URL would still show it. An ADMIN always resolves
  // to no hidden ids (see `catalogVisibilityUserId`) and is unaffected.
  if (!isAdmin) {
    const hiddenCatalogIds = await getHiddenCatalogIds(catalogVisibilityUserId(session?.user));
    if (isProductHidden({ id: product.id, seriesId: product.series.id }, hiddenCatalogIds)) {
      notFound();
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        backHref={`/catalog/${product.series.id}`}
        backLabel={product.series.name}
        title={product.name}
        description={
          isAdmin ? product.code : "View only — ask an admin to make changes."
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
        <SectionCard title="Details" className="lg:col-span-2">
          <ProductForm
            action={updateProduct.bind(null, product.id)}
            defaultValues={{
              code: product.code,
              name: product.name,
              description: product.description ?? "",
              active: product.active,
              noCommission: product.noCommission,
              sortOrder: product.sortOrder,
            }}
            submitLabel="Save changes"
            readOnly={!isAdmin}
          />
        </SectionCard>

        <div className="flex flex-col gap-6">
          <SectionCard title="Image">
            <ImageUpload
              currentUrl={product.imageUrl}
              alt={product.name}
              onSave={updateProductImage.bind(null, product.id)}
              readOnly={!isAdmin}
            />
          </SectionCard>

          <SectionCard title="Prices by region">
            <PriceEditor
              target={{ productId: product.id }}
              rows={product.prices}
              action={upsertPrice}
              readOnly={!isAdmin}
            />
          </SectionCard>
        </div>
      </div>

      {isAdmin && (
        <SectionCard
          tone="danger"
          title="Danger zone"
          description="Deleting a product removes its prices too. Products used on a document can't be deleted."
        >
          <DeleteButton
            action={deleteProduct.bind(null, product.id)}
            confirmTitle={`Delete ${product.code} — ${product.name}?`}
            confirmDescription="This removes its prices too. This can't be undone."
            label="Delete product"
          />
        </SectionCard>
      )}
    </div>
  );
}
