"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { FileText } from "lucide-react";
import {
  DeleteDocumentButton,
  useDeleteDocument,
  type DeletableQuote,
} from "@/components/documents/delete-document-button";
import { EmptyState } from "@/components/ui-kit/empty-state";
import {
  ResponsiveTableShell,
  responsiveCellClassName,
  responsiveRowClassName,
  responsiveTableClassName,
  responsiveTbodyClassName,
  responsiveTheadClassName,
  tableHeadRowClassName,
} from "@/components/ui-kit/data-table";
import { StatusBadge, STATUS_TONE } from "@/components/ui-kit/status-badge";
import { useToast } from "@/components/ui-kit/client";
import {
  LinkedRowsBody,
  ListResultCount,
  ListSearchInput,
  SortableTh,
  useListTable,
} from "@/components/ui-kit/list-table";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/actions/documents";
import type { RemainingQuotesResult } from "@/lib/actions/documents-list";
import type { QuoteListRow } from "@/components/documents/quote-list-rows";
import { cn } from "@/lib/utils";

export type { QuoteListRow };

type SortKey = "number" | "type" | "company" | "total" | "status" | "updated" | "salesperson";

/**
 * The /quotes list: client-side search and sort over the rows it holds, one
 * element tree per row, one link per row.
 *
 * It used to render every row twice (a table row for md+ and a card for
 * mobile, one hidden by CSS), wrap each of seven cells in its own `<Link>`
 * and mount a delete component with three hooks per row -- about 7.5 KB of
 * payload per quote, 4.5 MB for an admin's 602 (audit 2026-10-16, PERF-05).
 * Now the same `<table>` is both layouts (`ResponsiveTableShell` switches
 * the table elements' display by breakpoint), the primary cell carries the
 * row's only `<Link>` (what the keyboard and a screen reader reach;
 * `prefetch={false}` -- a quote page is the whole builder render), and
 * `LinkedRowsBody` gives mouse and touch the rest of the row through one
 * delegated handler. The delete flow is one `useDeleteDocument` for the list.
 *
 * Bounded, too: the page sends the most recent `DOCUMENT_LIST_PAGE_SIZE`
 * rows and `total`; when the scope holds more, "Show all" fetches the rest
 * through `loadRemaining` (a server action that applies the same scope from
 * the session) and appends them, so the search then covers everything. Rows
 * loaded that way live in `extra`, keyed out of the page's own rows by id so
 * a refresh after a delete (which re-sends the first page) never duplicates.
 */
export function QuotesList({
  rows,
  total,
  deleteAction,
  loadRemaining,
  showSalesperson,
}: {
  rows: QuoteListRow[];
  /** Every quote in the viewer's scope, from the same query that produced `rows`. */
  total: number;
  /** `deleteDocument`, handed down from the server page — a server action
   * passes through a client component as a reference, and it re-checks
   * every permission server-side regardless of which rows rendered a
   * button. */
  deleteAction: (documentId: string) => Promise<ActionResult>;
  /** `listRemainingQuotes`: the rows after the first `loaded`, in the same
   * order and under the same scope. */
  loadRemaining: (loaded: number) => Promise<RemainingQuotesResult>;
  /** Whether to render the trailing `Salesperson` column — `canSeeSalesperson`
   * (src/lib/roles.ts), resolved on the server page. False for a MANAGER,
   * whose list is their own quotes and for whom the column would be one name
   * repeated down the page.
   *
   * Also gates whether the name joins the search text, so a manager's search
   * matches only what is on their screen. */
  showSalesperson: boolean;
}) {
  const toast = useToast();
  const [extra, setExtra] = useState<QuoteListRow[]>([]);
  // Set when a "Show all" came back empty: `total` was counted at page load,
  // and a quote another user touched since can push one row past the offset
  // so that `remaining` never reaches zero. One empty answer ends it.
  const [exhausted, setExhausted] = useState(false);
  const [loadingRest, startLoadingRest] = useTransition();

  const allRows = useMemo(() => {
    const seen = new Set(rows.map((row) => row.id));
    return [...rows, ...extra.filter((row) => !seen.has(row.id))];
  }, [rows, extra]);

  const { requestDelete, pendingId } = useDeleteDocument({
    action: deleteAction,
    // The page's own rows come back fresh with the revalidation the action
    // ran; a row only this list holds has to go here.
    onDeleted: (id) => setExtra((current) => current.filter((row) => row.id !== id)),
  });

  const remaining = exhausted ? 0 : Math.max(0, total - allRows.length);

  function showAll() {
    startLoadingRest(async () => {
      const result = await loadRemaining(allRows.length);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      if (result.rows.length === 0) setExhausted(true);
      setExtra((current) => [...current, ...result.rows]);
    });
  }

  const { query, setQuery, sort, toggleSort, visible, isFiltered } = useListTable<QuoteListRow, SortKey>({
    rows: allRows,
    // Matches `listDocuments`' own `updatedAt: "desc"`, so the list looks
    // the same before and after hydration.
    defaultSort: { key: "updated", direction: "desc" },
    defaultDirections: { total: "desc", updated: "desc" },
    sortValues: (row) => ({
      number: row.numberLabel,
      type: "Quote",
      company: row.companyLabel,
      total: row.totalValue,
      status: `${row.statusLabel} ${row.signingLabel ?? ""}`,
      updated: row.updatedAtMs,
      salesperson: row.salespersonLabel,
    }),
    searchText: (row) =>
      [
        row.numberLabel,
        "Quote",
        row.companyLabel,
        row.totalLabel,
        row.statusLabel,
        row.signingLabel ?? "",
        row.updatedLabel,
        showSalesperson ? row.salespersonLabel : "",
      ].join(" "),
  });

  return (
    <div className="flex flex-col gap-6">
      <ListSearchInput
        value={query}
        onChange={setQuery}
        label="Search quotes"
        placeholder="Search quotes…"
        className="sm:w-72"
      />

      <ListResultCount count={visible.length} noun="quote" />

      {visible.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={isFiltered ? "No quotes match your search" : "No quotes yet"}
          description={
            isFiltered ? "Try a different number, company or status." : "Create your first quote above."
          }
        />
      ) : (
        <ResponsiveTableShell>
          <table className={responsiveTableClassName}>
            <thead className={responsiveTheadClassName}>
              <tr className={tableHeadRowClassName}>
                <SortableTh label="Number" sortKey="number" sort={sort} onSort={toggleSort} />
                <SortableTh label="Type" sortKey="type" sort={sort} onSort={toggleSort} />
                <SortableTh label="Company" sortKey="company" sort={sort} onSort={toggleSort} />
                <SortableTh label="Total" sortKey="total" sort={sort} onSort={toggleSort} align="right" />
                <SortableTh label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
                <SortableTh label="Updated" sortKey="updated" sort={sort} onSort={toggleSort} />
                {showSalesperson ? (
                  <SortableTh label="Salesperson" sortKey="salesperson" sort={sort} onSort={toggleSort} />
                ) : null}
                <th scope="col" className="px-4 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <LinkedRowsBody className={responsiveTbodyClassName}>
              {visible.map((row) => (
                <QuoteRow
                  key={row.id}
                  row={row}
                  showSalesperson={showSalesperson}
                  deletePending={pendingId === row.id}
                  onDelete={requestDelete}
                />
              ))}
            </LinkedRowsBody>
          </table>
        </ResponsiveTableShell>
      )}

      {remaining > 0 ? (
        <div className="flex flex-col items-center gap-2 text-sm text-slate-500">
          <p>
            Showing the {allRows.length} most recently updated of {total} quotes.
          </p>
          <Button type="button" variant="outline" onClick={showAll} disabled={loadingRest} className="h-11">
            {loadingRest ? "Loading…" : `Show all ${total}`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Beside the DRAFT/FINAL badge — see `signingStatusLabel`'s own doc comment
 * for why NOT_SENT renders nothing here rather than an empty pill. */
function SigningBadge({ row }: { row: QuoteListRow }) {
  if (!row.signingLabel) return null;
  return <StatusBadge tone={STATUS_TONE[row.signingStatus]}>{row.signingLabel}</StatusBadge>;
}

/**
 * One row, one tree. Cells are in table order; below md each one is placed
 * on the card grid (`responsiveRowClassName`: a flexible text column, a
 * right-aligned value column, a trailing icon column) by its `col-start` /
 * `row-start` classes, which table layout ignores from md up. The Number
 * cell holds the row's only link; `LinkedRowsBody` reads `data-href` for
 * clicks that land anywhere else on the row.
 */
function QuoteRow({
  row,
  showSalesperson,
  deletePending,
  onDelete,
}: {
  row: QuoteListRow;
  showSalesperson: boolean;
  deletePending: boolean;
  onDelete: (row: DeletableQuote) => void;
}) {
  const href = `/quotes/${row.id}`;

  return (
    <tr data-href={href} className={cn(responsiveRowClassName, "cursor-pointer")}>
      <td className={cn(responsiveCellClassName, "col-start-1 row-start-3")}>
        <Link
          href={href}
          prefetch={false}
          aria-label={`Open ${row.numberLabel}`}
          className="focus-ring rounded-sm font-mono text-xs whitespace-nowrap text-slate-500 md:text-sm md:text-brand-dark"
        >
          {row.numberLabel}
        </Link>
      </td>
      <td className={cn(responsiveCellClassName, "col-start-1 row-start-1")}>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 md:text-sm md:font-normal md:text-slate-600">
          <span className="list-icon list-icon-quote size-3.5 text-brand" />
          Quote
        </span>
      </td>
      <td className={cn(responsiveCellClassName, "col-start-1 row-start-2")}>
        <span className="block truncate font-medium text-brand-dark md:font-normal md:text-slate-700">
          {row.companyLabel}
        </span>
      </td>
      <td className={cn(responsiveCellClassName, "col-start-2 row-start-2 text-right")}>
        <span className="text-sm font-medium whitespace-nowrap tabular-nums text-brand-dark">{row.totalLabel}</span>
      </td>
      <td className={cn(responsiveCellClassName, "col-start-2 row-start-1 md:text-left")}>
        <span className="flex flex-wrap items-center justify-end gap-1.5 md:justify-start">
          <StatusBadge tone={STATUS_TONE[row.status]}>{row.statusLabel}</StatusBadge>
          <SigningBadge row={row} />
        </span>
      </td>
      <td className={cn(responsiveCellClassName, "col-start-2 row-start-3 text-right md:text-left")}>
        <span className="text-xs whitespace-nowrap text-slate-500 md:text-sm">{row.updatedLabel}</span>
      </td>
      {showSalesperson ? (
        <td className={cn(responsiveCellClassName, "col-start-1 row-start-4")}>
          {/* On the card the author goes under the company rather than in its
              own column; "by" because without it a bare name reads as more
              metadata. The prefix is hidden where the column header says it. */}
          <span className="truncate text-xs text-slate-500 md:text-sm md:text-slate-600">
            <span className="md:hidden">by </span>
            {row.salespersonLabel}
          </span>
        </td>
      ) : null}
      {/* Its own cell, never inside the link: a button inside an `<a>` is
          invalid HTML and would fire both. Spans the card's rows so the icon
          sits beside the whole card; empty when the viewer may not delete. */}
      <td className={cn(responsiveCellClassName, "col-start-3 row-start-1 row-span-3 md:p-0 md:text-right")}>
        {row.canDelete ? (
          <div className="flex justify-end md:px-2">
            <DeleteDocumentButton row={row} pending={deletePending} onClick={onDelete} />
          </div>
        ) : null}
      </td>
    </tr>
  );
}
