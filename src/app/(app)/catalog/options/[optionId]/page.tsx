import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/auth";
import { isAdminRole } from "@/lib/roles";
import { priceRegionIdForSessionUser } from "@/lib/authz";
import { getOptionDetailById, listSeriesWithCounts } from "@/lib/queries/catalog";
import { catalogVisibilityUserId, filterHiddenSeries } from "@/lib/catalog-visibility";
import { getHiddenCatalogIds } from "@/lib/queries/catalog-visibility";
import {
  updateOption,
  deleteOption,
  upsertPrice,
  setOptionCompatibility,
  updateOptionImage,
} from "@/lib/actions/catalog";
import { OptionForm } from "@/components/catalog/option-form";
import { PriceEditor } from "@/components/catalog/price-editor";
import { CompatEditor } from "@/components/catalog/compat-editor";
import { ImageUpload } from "@/components/catalog/image-upload";
import { DeleteButton } from "@/components/catalog/delete-button";
import { PageHeader, SectionCard } from "@/components/ui-kit";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// Routed by Option.id, not Option.code. A code is free text an admin can
// edit at any time, and `encodeURIComponent` can't make it a safe single
// path segment either way — a `/` in the code encodes to `%2F`, which
// Node/Next normalise back into a path separator before route matching, so
// the dynamic segment never matches and the page 404s (two options in this
// catalogue already have a `/` in their code). The id never changes, so
// this also means renaming an option's code no longer breaks its URL. The
// trade-off is a less readable URL (a cuid instead of a code) — accepted
// deliberately: an opaque URL that always works beats a readable one that
// 404s on real data. Don't "simplify" this back to the code.
type Params = { optionId: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { optionId } = await params;
  // The session is resolved before the option: its price rows are scoped to
  // the viewer's region, so the region has to be known before the fetch, and
  // `CatalogLayout`'s `requireRegion` can't supply it — a layout doesn't
  // reliably run before a route's `generateMetadata`.
  const session = await auth();
  const option = await getOptionDetailById(
    optionId,
    priceRegionIdForSessionUser(session?.user)
  );
  return { title: option ? option.code : "Option" };
}

export default async function OptionEditorPage({ params }: { params: Promise<Params> }) {
  const { optionId } = await params;
  // Session first, then the option — same reason as `generateMetadata`
  // above, and the same `regionId` value, so `getOptionDetailById` stays a
  // single request-memoized query across the two calls. `listSeriesWithCounts`
  // needs no region and still runs alongside the option fetch.
  const session = await auth();
  const [option, series] = await Promise.all([
    getOptionDetailById(optionId, priceRegionIdForSessionUser(session?.user)),
    listSeriesWithCounts(),
  ]);

  if (!option) notFound();

  const isAdmin = isAdminRole(session?.user?.role);
  // Same reasoning as the options list's filter chips: the compatibility
  // editor names every series (as a checkbox row) even though this page
  // isn't the product catalogue itself — an ADMIN needs the full list to
  // actually manage compatibility (resolves to no hidden ids, see
  // `catalogVisibilityUserId`), a read-only MANAGER doesn't need to see a
  // series they can't sell.
  const hiddenCatalogIds = await getHiddenCatalogIds(catalogVisibilityUserId(session?.user));
  const visibleSeries = filterHiddenSeries(series, hiddenCatalogIds);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        backHref="/catalog/options"
        backLabel="Options"
        title={option.name}
        description={isAdmin ? option.code : "View only — ask an admin to make changes."}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
        <SectionCard title="Details" className="lg:col-span-2">
          <OptionForm
            action={updateOption.bind(null, option.id)}
            defaultValues={{
              code: option.code,
              name: option.name,
              shortDescription: option.shortDescription ?? "",
              attributeSchema: option.attributeSchema
                ? JSON.stringify(option.attributeSchema, null, 2)
                : "",
              active: option.active,
              noCommission: option.noCommission,
              sortOrder: option.sortOrder,
            }}
            submitLabel="Save changes"
            readOnly={!isAdmin}
          />
        </SectionCard>

        <div className="flex flex-col gap-6">
          <SectionCard title="Image">
            <ImageUpload
              currentUrl={option.imageUrl}
              alt={option.name}
              onSave={updateOptionImage.bind(null, option.id)}
              readOnly={!isAdmin}
            />
          </SectionCard>

          <SectionCard title="Prices by region">
            <PriceEditor
              target={{ optionId: option.id }}
              rows={option.prices}
              action={upsertPrice}
              readOnly={!isAdmin}
            />
          </SectionCard>

          <SectionCard
            title="Compatible series"
            description="Series this option is available on. Product-level overrides aren't supported yet."
          >
            <CompatEditor
              optionId={option.id}
              series={visibleSeries.map((s) => ({ id: s.id, code: s.code, name: s.name }))}
              initialSelected={option.compatSeriesIds}
              action={setOptionCompatibility}
              readOnly={!isAdmin}
            />
          </SectionCard>

          <SectionCard
            title="Conflict groups"
            description="Groups this option belongs to — two options can't be selected together on the same item when they share a group (e.g. a set of knife tools where only one can be fitted). Membership is managed from Settings, not here."
          >
            {option.conflictGroups.length === 0 ? (
              <p className="text-sm text-slate-500">Not in any conflict group.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {option.conflictGroups.map((g) => (
                  <li key={g.id}>
                    <Link
                      href={`/settings/option-conflict-groups/${g.id}`}
                      className="focus-ring rounded text-sm font-medium text-brand-dark underline-offset-2 hover:underline"
                    >
                      {g.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {isAdmin ? (
              <Link
                href="/settings/option-conflict-groups"
                className={cn(buttonVariants({ variant: "outline" }), "mt-3 h-10 w-full sm:w-auto")}
              >
                Manage conflict groups
              </Link>
            ) : null}
          </SectionCard>
        </div>
      </div>

      {isAdmin && (
        <SectionCard
          tone="danger"
          title="Danger zone"
          description="Deleting an option removes its prices, compatibility and conflict group memberships too. Options used on a document can't be deleted."
        >
          <DeleteButton
            action={deleteOption.bind(null, option.id)}
            confirmTitle={`Delete ${option.code} — ${option.name}?`}
            confirmDescription="This removes its prices, compatibility and conflict group memberships too. This can't be undone."
            label="Delete option"
          />
        </SectionCard>
      )}
    </div>
  );
}
