"use client";

import Link from "next/link";
import { FileText } from "lucide-react";
import { DeleteDocumentButton } from "@/components/documents/delete-document-button";
import { EmptyState } from "@/components/ui-kit/empty-state";
import {
  TableShell,
  RowCell,
  tableClassName,
  tableHeadRowClassName,
  tableRowClassName,
} from "@/components/ui-kit/data-table";
import { StatusBadge, STATUS_TONE } from "@/components/ui-kit/status-badge";
import {
  ListResultCount,
  ListSearchInput,
  SortableTh,
  useListTable,
} from "@/components/ui-kit/list-table";
import type { ActionResult } from "@/lib/actions/documents";
import type { DocumentStatus, SigningStatus } from "@prisma/client";
import { cn } from "@/lib/utils";

/**
 * One row of the /quotes list, with every displayed string already
 * rendered by the server page.
 *
 * Deliberately a view model rather than the `DocumentListItem` the query
 * returns: this component is a client component, so anything it formats
 * itself ships to the browser along with it. Keeping `formatMoney`,
 * `relativeDate` and the two status-label helpers on the server means the
 * search box can also match exactly what the user can see, because the
 * labels it searches ARE the labels on screen — no second formatting path
 * that could drift from the first.
 *
 * `totalValue` and `updatedAtMs` ride along beside their labels purely so
 * those two columns sort by value; "A$1,200" and "Yesterday" sort as text
 * the way nobody wants.
 */
export type QuoteListRow = {
  id: string;
  numberLabel: string;
  companyLabel: string;
  totalLabel: string;
  totalValue: number;
  status: DocumentStatus;
  statusLabel: string;
  signingStatus: SigningStatus;
  /** Null for NOT_SENT, which renders no second badge — see
   * `signingStatusLabel` (src/lib/signing/state.ts). */
  signingLabel: string | null;
  updatedLabel: string;
  updatedAtMs: number;
  canDelete: boolean;
};

type SortKey = "number" | "type" | "company" | "total" | "status" | "updated";

export function QuotesList({
  rows,
  deleteAction,
}: {
  rows: QuoteListRow[];
  /** `deleteDocument`, handed down from the server page — a server action
   * passes through a client component as a reference, and it re-checks
   * every permission server-side regardless of which rows rendered a
   * button. */
  deleteAction: (documentId: string) => Promise<ActionResult>;
}) {
  const { query, setQuery, sort, toggleSort, visible, isFiltered } = useListTable<
    QuoteListRow,
    SortKey
  >({
    rows,
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
        <TableShell
          table={
            <table className={tableClassName}>
              <thead>
                <tr className={tableHeadRowClassName}>
                  <SortableTh label="Number" sortKey="number" sort={sort} onSort={toggleSort} />
                  <SortableTh label="Type" sortKey="type" sort={sort} onSort={toggleSort} />
                  <SortableTh label="Company" sortKey="company" sort={sort} onSort={toggleSort} />
                  <SortableTh label="Total" sortKey="total" sort={sort} onSort={toggleSort} align="right" />
                  <SortableTh label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
                  <SortableTh label="Updated" sortKey="updated" sort={sort} onSort={toggleSort} />
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <DocumentRow key={row.id} row={row} deleteAction={deleteAction} />
                ))}
              </tbody>
            </table>
          }
          cards={visible.map((row) => (
            <DocumentCard key={row.id} row={row} deleteAction={deleteAction} />
          ))}
        />
      )}
    </div>
  );
}

/** Beside the DRAFT/FINAL badge on both the table row and the card — see
 * `signingStatusLabel`'s own doc comment for why NOT_SENT renders nothing
 * here rather than an empty pill. */
function SigningBadge({ row }: { row: QuoteListRow }) {
  if (!row.signingLabel) return null;
  return <StatusBadge tone={STATUS_TONE[row.signingStatus]}>{row.signingLabel}</StatusBadge>;
}

function DocumentRow({
  row,
  deleteAction,
}: {
  row: QuoteListRow;
  deleteAction: (documentId: string) => Promise<ActionResult>;
}) {
  const href = `/quotes/${row.id}`;

  return (
    <tr className={tableRowClassName}>
      <RowCell href={href} primary={`Open ${row.numberLabel}`}>
        <span aria-hidden="true" className="font-mono text-sm text-brand-dark">
          {row.numberLabel}
        </span>
      </RowCell>
      <RowCell href={href}>
        <span className="inline-flex items-center gap-1.5 text-sm text-slate-600">
          <FileText className="size-3.5 text-brand" aria-hidden="true" />
          Quote
        </span>
      </RowCell>
      <RowCell href={href}>
        <span className="text-sm text-slate-700">{row.companyLabel}</span>
      </RowCell>
      <RowCell href={href} align="right">
        <span className="text-sm font-medium tabular-nums text-brand-dark">{row.totalLabel}</span>
      </RowCell>
      <RowCell href={href}>
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusBadge tone={STATUS_TONE[row.status]}>{row.statusLabel}</StatusBadge>
          <SigningBadge row={row} />
        </span>
      </RowCell>
      <RowCell href={href}>
        <span className="text-sm text-slate-500">{row.updatedLabel}</span>
      </RowCell>
      {/* Deliberately its own plain `<td>` (no `RowCell`/`Link`) — a delete
          button nested inside an `<a>` would be invalid HTML and would fire
          both the button's click and the row's navigation. */}
      <td className="p-0 align-middle">
        {row.canDelete ? (
          <div className="flex justify-end px-2">
            <DeleteDocumentButton
              documentId={row.id}
              numberLabel={row.numberLabel}
              status={row.status}
              signingStatus={row.signingStatus}
              action={deleteAction}
            />
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function DocumentCard({
  row,
  deleteAction,
}: {
  row: QuoteListRow;
  deleteAction: (documentId: string) => Promise<ActionResult>;
}) {
  return (
    <div className="relative rounded-xl border border-slate-200 bg-white p-4">
      <Link
        href={`/quotes/${row.id}`}
        className={cn(
          "focus-ring flex min-h-12 flex-col gap-2 rounded-lg transition-colors active:bg-slate-100",
          row.canDelete && "pr-12"
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
            <FileText className="size-3.5 text-brand" aria-hidden="true" />
            Quote
          </span>
          <span className="flex flex-wrap items-center justify-end gap-1.5">
            <StatusBadge tone={STATUS_TONE[row.status]}>{row.statusLabel}</StatusBadge>
            <SigningBadge row={row} />
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium text-brand-dark">{row.companyLabel}</p>
            <p className="font-mono text-xs text-slate-500">
              {row.numberLabel} · {row.updatedLabel}
            </p>
          </div>
          <span className="shrink-0 text-sm font-medium tabular-nums text-brand-dark">
            {row.totalLabel}
          </span>
        </div>
      </Link>
      {row.canDelete ? (
        <div className="absolute top-3 right-3">
          <DeleteDocumentButton
            documentId={row.id}
            numberLabel={row.numberLabel}
            status={row.status}
            signingStatus={row.signingStatus}
            action={deleteAction}
          />
        </div>
      ) : null}
    </div>
  );
}
