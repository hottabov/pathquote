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
        series={visibleSeries.map((s) => ({ id: s.id, code: s.code }))}
        activeSeries={seriesFilter ?? null}
      />
    </div>
  );
}

