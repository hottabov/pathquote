"use client";

import { useId, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Search, X } from "lucide-react";
import {
  filterAndSortRows,
  nextSortState,
  prepareRows,
  type SortDirection,
  type SortState,
  type SortValue,
} from "@/lib/list-table";
import { fieldInputClass } from "./field-row";
import { cn } from "@/lib/utils";

/**
 * The interactive half of the list pages (/quotes, /clients): a search box
 * that filters every rendered column as you type, and clickable column
 * headers that sort on the first click.
 *
 * Deliberately NOT re-exported from `@/components/ui-kit` or
 * `@/components/ui-kit/client` — both of those barrels are a single module
 * to the bundler, and importing one name out of them from a client
 * component drags the rest in (see the header comment on ./index.ts for the
 * `PhoneField` -> `i18n-iso-countries` chain that split them in the first
 * place). Consumers import this file by its own path.
 *
 * Filtering and sorting run in the browser over the full list the server
 * already sent, which is what makes them instant; the trade-off is that the
 * page must ship every row rather than a server-filtered page of them. Both
 * lists are per-business and small enough for that today — if one grows to
 * thousands of rows, the fix is server-side pagination, not a slower
 * version of this.
 *
 * The matching and ordering rules themselves live in @/lib/list-table,
 * where they are plain functions under test; this file is state and markup.
 */

export type { SortDirection, SortState, SortValue };

export function useListTable<T, K extends string>({
  rows,
  defaultSort,
  sortValues,
  searchText,
  defaultDirections,
}: {
  rows: readonly T[];
  /** Column + direction the table opens on — match whatever order the
   * server query already returns, so the first paint doesn't reshuffle. */
  defaultSort: SortState<K>;
  /** One entry per sortable column key for this row. */
  sortValues: (row: T) => Record<K, SortValue>;
  /** Everything about the row the search box should be able to find —
   * join the rendered labels, not the raw ids. */
  searchText: (row: T) => string;
  /** Direction a column starts in when it is first clicked. Defaults to
   * "asc"; pass "desc" for the columns where newest/largest-first is the
   * obvious first thing to want (dates, totals). */
  defaultDirections?: Partial<Record<K, SortDirection>>;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState<K>>(defaultSort);

  const prepared = useMemo(
    () => prepareRows<T, K>(rows, sortValues, searchText),
    // `sortValues`/`searchText` are inline arrows at every call site, so a
    // new identity each render — depending on them would defeat the memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows]
  );

  const visible = useMemo(() => filterAndSortRows(prepared, query, sort), [prepared, query, sort]);

  function toggleSort(key: K) {
    setSort((current) => nextSortState(current, key, defaultDirections));
  }

  return { query, setQuery, sort, toggleSort, visible, isFiltered: query.trim().length > 0 };
}

/**
 * The list pages' search field: icon on the left, and — once there is
 * something to clear — a real `<button>` on the right rather than relying
 * on `type="search"`'s native clear affordance, which Firefox doesn't
 * render at all and which no keyboard user can reach in Safari.
 *
 * `type="text"`, not `type="search"`, precisely so the browser's own
 * inconsistent clear button never sits beside ours.
 */
export function ListSearchInput({
  value,
  onChange,
  label,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name — these boxes sit above the table with no visible
   * label, so this is the only one a screen reader gets. */
  label: string;
  placeholder: string;
  className?: string;
}) {
  const id = useId();

  return (
    <div className={cn("relative", className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400"
        aria-hidden="true"
      />
      <input
        id={id}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Escape clears rather than bubbling — the field is inside no
          // dialog, so nothing else wants the key, and "get back to the
          // full list" is the one shortcut a filter box should have.
          if (event.key === "Escape" && value) {
            event.preventDefault();
            onChange("");
          }
        }}
        aria-label={label}
        placeholder={placeholder}
        autoComplete="off"
        className={cn(fieldInputClass, "pr-11 pl-9")}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="focus-ring absolute top-1/2 right-1 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-brand-dark"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * A `<th>` whose whole box is the sort control. Padding lives on the
 * `<button>`, not the `<th>`, so the click target fills the header cell —
 * the same reason `RowCell` (./data-table.tsx) moves padding onto its link.
 *
 * `aria-sort` on the `<th>` is what tells a screen reader the table is
 * sorted and which way; the arrow icon is the sighted equivalent and stays
 * `aria-hidden`. An unsorted column shows a muted two-way chevron on hover/
 * focus only, so six columns of arrows don't compete with the data.
 */
export function SortableTh<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  align,
  className,
}: {
  label: string;
  sortKey: K;
  sort: SortState<K>;
  onSort: (key: K) => void;
  align?: "right";
  className?: string;
}) {
  const active = sort.key === sortKey;
  const Icon = active ? (sort.direction === "asc" ? ArrowUp : ArrowDown) : ChevronsUpDown;

  return (
    <th
      scope="col"
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      className={cn("p-0", className)}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "focus-ring group flex w-full items-center gap-1.5 px-4 py-3 text-xs font-medium tracking-wide uppercase transition-colors hover:text-brand-dark",
          active ? "text-brand-dark" : "text-slate-500",
          align === "right" && "justify-end"
        )}
      >
        <span>{label}</span>
        <Icon
          className={cn(
            "size-3.5 shrink-0 transition-opacity",
            active ? "text-brand opacity-100" : "opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60"
          )}
          aria-hidden="true"
        />
      </button>
    </th>
  );
}

/**
 * Politely announces how many rows survived the filter. Visually hidden —
 * a sighted user sees the table shrink, a screen-reader user otherwise gets
 * no feedback at all from typing in the search box.
 */
export function ListResultCount({ count, noun }: { count: number; noun: string }) {
  return (
    <p aria-live="polite" className="sr-only">
      {count} {count === 1 ? noun : `${noun}s`} shown
    </p>
  );
}
