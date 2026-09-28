"use client";

import Link from "next/link";
import { Puzzle } from "lucide-react";
import { EmptyState } from "@/components/ui-kit/empty-state";
import {
  TableShell,
  RowCell,
  tableClassName,
  tableHeadRowClassName,
  tableRowClassName,
} from "@/components/ui-kit/data-table";
import { ListResultCount, ListSearchInput, useListTable } from "@/components/ui-kit/list-table";
import { PriceDisplay, InactiveBadge, CompatBadges } from "@/components/catalog-badges";
import { CatalogThumb } from "@/components/catalog/catalog-thumb";
import type { OptionListItem } from "@/lib/queries/catalog";
import { cn } from "@/lib/utils";

/**
 * The /catalog/options table with its search box. The search filters the
 * rows the server already sent as you type — the same in-browser filter as
 * /quotes and /clients (see @/components/ui-kit/list-table) — so clearing
 * the box brings the whole list straight back without a reload.
 *
 * The product chips sit on the same line as the search box. Picking a chip is
 * still a navigation (`?series=`): it changes which rows the server sends,
 * and the search keeps filtering whatever arrives. The page passes the chips
 * as data rather than as rendered JSX -- a server-built element tree handed
 * to a client component loses React's "static children" marking, and the
 * chip row then warns about missing keys.
 */
export function OptionsList({
  rows,
  series,
  activeSeries,
}: {
  rows: OptionListItem[];
  series: Array<{ id: string; code: string }>;
  activeSeries: string | null;
}) {
  const { query, setQuery, visible, isFiltered } = useListTable<OptionListItem, "code">({
    rows,
    // Matches `listOptions`' own `code: "asc"`.
    defaultSort: { key: "code", direction: "asc" },
    sortValues: (row) => ({ code: row.code }),
    searchText: (row) => [row.code, row.name].join(" "),
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="tablist"
          aria-label="Filter options by product"
          className="inline-flex w-fit flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1"
        >
          <FilterChip label="All products" href={seriesHref()} active={!activeSeries} />
          {series.map((s) => (
            <FilterChip key={s.id} label={s.code} href={seriesHref(s.code)} active={activeSeries === s.code} />
          ))}
        </div>
        <ListSearchInput
          value={query}
          onChange={setQuery}
          label="Search options"
          placeholder="Search by name or code…"
          className="sm:w-72"
        />
      </div>

      <ListResultCount count={visible.length} noun="option" />

      {visible.length === 0 ? (
        <EmptyState
          icon={Puzzle}
          title={isFiltered ? "No options match your search" : "No options match your filters"}
          description={isFiltered ? "Try a different name or code." : "Try a different product."}
        />
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
                  <th scope="col" className="px-4 py-3">
                    Compatibility
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
                {visible.map((o) => (
                  <OptionRow key={o.id} option={o} />
                ))}
              </tbody>
            </table>
          }
          cards={visible.map((o) => (
            <OptionCard key={o.id} option={o} />
          ))}
        />
      )}
    </div>
  );
}

function OptionRow({ option: o }: { option: OptionListItem }) {
  const href = `/catalog/options/${o.id}`;
  return (
    <tr className={cn(tableRowClassName, o.active ? "" : "opacity-60")}>
      <RowCell href={href}>
        {/* Reserves its box even with no image — see CatalogThumb's doc
            comment — so every row's Code column still lines up. */}
        <CatalogThumb src={o.imageUrl} />
      </RowCell>
      <RowCell href={href} primary={`Open ${o.name}`}>
        <span aria-hidden="true" className="font-mono text-sm text-brand-dark">
          {o.code}
        </span>
      </RowCell>
      <RowCell href={href}>
        <span className="text-sm text-slate-700">{o.name}</span>
      </RowCell>
      <RowCell href={href}>
        {o.description ? (
          <span className="block max-w-[240px] truncate text-sm text-slate-500">{o.description}</span>
        ) : null}
      </RowCell>
      <RowCell href={href}>
        <CompatBadges seriesCodes={o.compatSeriesCodes} />
      </RowCell>
      <RowCell href={href} align="right">
        <PriceDisplay price={o.price} />
      </RowCell>
      <RowCell href={href} align="right">
        {!o.active ? <InactiveBadge /> : null}
      </RowCell>
    </tr>
  );
}

function OptionCard({ option: o }: { option: OptionListItem }) {
  return (
    <Link
      href={`/catalog/options/${o.id}`}
      className={cn(
        "focus-ring flex min-h-12 gap-3 rounded-xl border border-slate-200 bg-white p-4 transition-colors active:bg-slate-100",
        o.active ? "" : "opacity-60"
      )}
    >
      {/* Same reading order as the table row: image, then code, then name,
          then description. */}
      <CatalogThumb src={o.imageUrl} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="font-mono text-sm text-brand-dark">{o.code}</span>
            {!o.active ? <InactiveBadge /> : null}
          </div>
          <PriceDisplay price={o.price} />
        </div>
        <p className="truncate text-sm text-slate-700">{o.name}</p>
        {o.description ? <p className="truncate text-xs text-slate-500">{o.description}</p> : null}
        <CompatBadges seriesCodes={o.compatSeriesCodes} />
      </div>
    </Link>
  );
}

function seriesHref(seriesCode?: string) {
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
