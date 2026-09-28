import Link from "next/link";
import type { Metadata } from "next";
import { Plus } from "lucide-react";
import { auth } from "@/auth";
import { isAdminRole } from "@/lib/roles";
import { listOptions, listSeriesWithCounts } from "@/lib/queries/catalog";
import { catalogVisibilityUserId, filterHiddenSeries } from "@/lib/catalog-visibility";
import { getHiddenCatalogIds } from "@/lib/queries/catalog-visibility";
import { OptionsList } from "@/components/catalog/options-list";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/ui-kit";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Options" };
export const dynamic = "force-dynamic";

type SearchParams = { series?: string };

export default async function OptionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { series: seriesFilter } = await searchParams;
  const [options, series, session] = await Promise.all([
    listOptions({ seriesCode: seriesFilter }),
    listSeriesWithCounts(),
    auth(),
  ]);

  const isAdmin = isAdminRole(session?.user?.role);
  // The series filter chips name a series even though this page never lists
  // its products/prices — still enough of a "meet it" for a hidden series
  // (its name/code) to filter out here too, same as every other catalogue
  // browsing surface.
  const hiddenCatalogIds = await getHiddenCatalogIds(catalogVisibilityUserId(session?.user));
  const visibleSeries = filterHiddenSeries(series, hiddenCatalogIds);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        backHref="/catalog"
        backLabel="Catalog"
        title="Options"
        description="Global options available across product series."
        actions={
          isAdmin ? (
            <Link
              href="/catalog/options/new"
              className={cn(
                buttonVariants({ variant: "brand" }),
                "h-11 w-full sm:w-auto"
              )}
            >
              <Plus className="size-4" data-icon="inline-start" aria-hidden="true" />
              Add option
            </Link>
          ) : undefined
        }
      />

      <OptionsList
        rows={options}
        filters={
          <div
            role="tablist"
            aria-label="Filter options by product"
            className="inline-flex w-fit flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1"
          >
            <FilterChip label="All products" href={buildHref()} active={!seriesFilter} />
            {visibleSeries.map((s) => (
              <FilterChip key={s.id} label={s.code} href={buildHref(s.code)} active={seriesFilter === s.code} />
            ))}
          </div>
        }
      />
    </div>
  );
}

function buildHref(seriesCode?: string) {
  return seriesCode ? `/catalog/options?series=${encodeURIComponent(seriesCode)}` : "/catalog/options";
}

function FilterChip({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      className={cn(
        "focus-ring rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active ? "bg-brand text-white" : "text-slate-500 hover:text-brand-dark"
      )}
    >
      {label}
    </Link>
  );
}
