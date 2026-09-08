import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Plus, MapPin } from "lucide-react";
import { auth } from "@/auth";
import { isAdminRole } from "@/lib/roles";
import { listRegionsAdmin, type RegionAdminListItem } from "@/lib/queries/regions";
import { buttonVariants } from "@/components/ui/button";
import {
  PageHeader,
  TableShell,
  tableClassName,
  tableHeadRowClassName,
  tableRowClassName,
  StatusBadge,
  EmptyState,
} from "@/components/ui-kit";
import { cn } from "@/lib/utils";
import { currencySymbol } from "@/lib/format";

export const metadata: Metadata = { title: "Regions" };
export const dynamic = "force-dynamic";

export default async function RegionsPage() {
  // notFound() rather than a redirect: a Manager hitting a stale bookmark
  // shouldn't be told the page exists at all.
  const session = await auth();
  if (!isAdminRole(session?.user?.role)) notFound();

  const regions = await listRegionsAdmin();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Regions"
        description="Currency, tax, and legal-entity details used to build documents."
        actions={
          <Link
            href="/settings/regions/new"
            className={cn(buttonVariants(), "h-11 w-full bg-brand text-white hover:bg-brand/90 sm:w-auto")}
          >
            <Plus className="size-4" data-icon="inline-start" aria-hidden="true" />
            Add region
          </Link>
        }
      />

      {regions.length === 0 ? (
        <EmptyState icon={MapPin} title="No regions yet" description="Add your first region above." />
      ) : (
        <TableShell
          table={
            <table className={tableClassName}>
              <thead>
                <tr className={tableHeadRowClassName}>
                  <th scope="col" className="px-4 py-3">
                    Code
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Currency
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Tax
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Entity
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {regions.map((r) => (
                  <RegionRow key={r.id} region={r} />
                ))}
              </tbody>
            </table>
          }
          cards={regions.map((r) => (
            <RegionCard key={r.id} region={r} />
          ))}
        />
      )}
    </div>
  );
}

function taxLabel(region: RegionAdminListItem): string {
  return `${region.taxName} ${region.taxRate}%`;
}

/** "£ GBP" — the symbol amounts actually print with, next to the code they are
 * stored under. Shown for every region, not only the ones with an explicit
 * symbol, so this column answers "what will a quote look like" rather than
 * "which regions has someone bothered to configure". */
function currencyLabel(region: RegionAdminListItem): string {
  return `${currencySymbol(region.currency, region.currencySymbol)} ${region.currency}`;
}

function RegionRow({ region: r }: { region: RegionAdminListItem }) {
  return (
    <tr className={cn(tableRowClassName, "relative")}>
      <td className="px-4 py-3 align-middle">
        <Link
          href={`/settings/regions/${r.id}`}
          className="absolute inset-0 focus-visible:z-10 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
        >
          <span className="sr-only">Open {r.name}</span>
        </Link>
        <span aria-hidden="true" className="relative font-mono text-sm font-medium text-brand-dark">
          {r.code}
        </span>
      </td>
      <td className="px-4 py-3 text-sm text-slate-600">{r.name}</td>
      <td className="px-4 py-3 text-sm text-slate-600">{currencyLabel(r)}</td>
      <td className="px-4 py-3 text-sm text-slate-600">{taxLabel(r)}</td>
      <td className="px-4 py-3 text-sm text-slate-600">{r.entityName}</td>
      <td className="px-4 py-3">
        <StatusBadge tone={r.active ? "green" : "slate"}>{r.active ? "Active" : "Inactive"}</StatusBadge>
      </td>
    </tr>
  );
}

function RegionCard({ region: r }: { region: RegionAdminListItem }) {
  return (
    <div className="relative flex min-h-12 flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4 transition-colors active:bg-slate-100">
      <Link
        href={`/settings/regions/${r.id}`}
        className="focus-ring absolute inset-0 rounded-xl focus-visible:z-10"
      >
        <span className="sr-only">Open {r.name}</span>
      </Link>
      <div className="flex items-start justify-between gap-3">
        <div className="relative min-w-0">
          <p className="truncate font-mono text-sm font-medium text-brand-dark">{r.code}</p>
          <p className="truncate text-sm text-slate-500">{r.name}</p>
        </div>
        <StatusBadge tone={r.active ? "green" : "slate"} className="relative shrink-0">
          {r.active ? "Active" : "Inactive"}
        </StatusBadge>
      </div>
      <div className="relative flex items-center justify-between gap-3 text-sm text-slate-500">
        <span>{currencyLabel(r)}</span>
        <span>{taxLabel(r)}</span>
      </div>
      <p className="relative truncate text-sm text-slate-500">{r.entityName}</p>
    </div>
  );
}
