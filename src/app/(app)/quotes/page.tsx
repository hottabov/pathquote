import Link from "next/link";
import type { Metadata } from "next";
import { FileText, Plus, Search } from "lucide-react";
import { auth } from "@/auth";
import { isAdminRole } from "@/lib/roles";
import { listDocuments, type DocumentListItem } from "@/lib/queries/documents";
import { createDraft, deleteDocument } from "@/lib/actions/documents";
import { formatMoney, relativeDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DeleteDocumentButton } from "@/components/documents/delete-document-button";
import {
  PageHeader,
  TableShell,
  RowCell,
  tableClassName,
  tableHeadRowClassName,
  tableRowClassName,
  StatusBadge,
  STATUS_TONE,
  EmptyState,
} from "@/components/ui-kit";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Documents" };
export const dynamic = "force-dynamic";

type SearchParams = { q?: string };

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { q } = await searchParams;
  // AppLayout (src/app/(app)/layout.tsx) already calls requireSession and
  // redirects unauthenticated requests, so a session is always present here.
  const session = (await auth())!;

  const documents = await listDocuments(session.user, { q });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Documents"
        description={
          isAdminRole(session.user.role) ? "Every quote across the business." : "Quotes you've created."
        }
        actions={
          <form action={createDraft}>
            <Button type="submit" className="h-11 w-full bg-brand text-white hover:bg-brand/90 sm:w-auto">
              <Plus className="size-4" data-icon="inline-start" aria-hidden="true" />
              New quote
            </Button>
          </form>
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <form method="GET" className="sm:w-72">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <input
              type="search"
              name="q"
              defaultValue={q ?? ""}
              aria-label="Search by company"
              placeholder="Search by company…"
              className="focus-ring h-11 w-full rounded-lg border border-slate-200 bg-white pr-3 pl-9 text-base text-brand-dark outline-none transition-colors placeholder:text-slate-400 focus-visible:border-brand"
            />
          </div>
        </form>
      </div>

      {documents.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={q ? "No documents match your search" : "No documents yet"}
          description={q ? "Try a different company name." : "Create your first quote above."}
        />
      ) : (
        <TableShell
          table={
            <table className={tableClassName}>
              <thead>
                <tr className={tableHeadRowClassName}>
                  <th scope="col" className="px-4 py-3">
                    Number
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Type
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Company
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    Total
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Updated
                  </th>
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {documents.map((d) => (
                  <DocumentRow
                    key={d.id}
                    document={d}
                    canDelete={isAdminRole(session.user.role) || d.status === "DRAFT"}
                  />
                ))}
              </tbody>
            </table>
          }
          cards={documents.map((d) => (
            <DocumentCard
              key={d.id}
              document={d}
              canDelete={isAdminRole(session.user.role) || d.status === "DRAFT"}
            />
          ))}
        />
      )}
    </div>
  );
}

function DocumentRow({ document: d, canDelete }: { document: DocumentListItem; canDelete: boolean }) {
  const statusLabel = d.status === "DRAFT" ? "Draft" : "Final";
  const numberLabel = d.number ?? "Quote draft";
  const href = `/documents/${d.id}`;

  return (
    <tr className={tableRowClassName}>
      <RowCell href={href} primary={`Open ${numberLabel}`}>
        <span aria-hidden="true" className="font-mono text-sm text-brand-dark">
          {numberLabel}
        </span>
      </RowCell>
      <RowCell href={href}>
        <span className="inline-flex items-center gap-1.5 text-sm text-slate-600">
          <FileText className="size-3.5 text-brand" aria-hidden="true" />
          Quote
        </span>
      </RowCell>
      <RowCell href={href}>
        <span className="text-sm text-slate-700">{d.companyName ?? "No client"}</span>
      </RowCell>
      <RowCell href={href} align="right">
        <span className="text-sm font-medium tabular-nums text-brand-dark">
          {formatMoney(d.total, d.currency)}
        </span>
      </RowCell>
      <RowCell href={href}>
        <StatusBadge tone={STATUS_TONE[d.status]}>{statusLabel}</StatusBadge>
      </RowCell>
      <RowCell href={href}>
        <span className="text-sm text-slate-500">{relativeDate(d.updatedAt)}</span>
      </RowCell>
      {/* Deliberately its own plain `<td>` (no `RowCell`/`Link`) — a delete
          button nested inside an `<a>` would be invalid HTML and would fire
          both the button's click and the row's navigation. */}
      <td className="p-0 align-middle">
        {canDelete ? (
          <div className="flex justify-end px-2">
            <DeleteDocumentButton
              documentId={d.id}
              numberLabel={numberLabel}
              status={d.status}
              action={deleteDocument}
            />
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function DocumentCard({ document: d, canDelete }: { document: DocumentListItem; canDelete: boolean }) {
  const statusLabel = d.status === "DRAFT" ? "Draft" : "Final";
  const numberLabel = d.number ?? "Quote draft";

  return (
    <div className="relative rounded-xl border border-slate-200 bg-white p-4">
      <Link
        href={`/documents/${d.id}`}
        className={cn(
          "focus-ring flex min-h-12 flex-col gap-2 rounded-lg transition-colors active:bg-slate-100",
          canDelete && "pr-12"
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
            <FileText className="size-3.5 text-brand" aria-hidden="true" />
            Quote
          </span>
          <StatusBadge tone={STATUS_TONE[d.status]}>{statusLabel}</StatusBadge>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium text-brand-dark">{d.companyName ?? "No client"}</p>
            <p className="font-mono text-xs text-slate-500">
              {numberLabel} · {relativeDate(d.updatedAt)}
            </p>
          </div>
          <span className="shrink-0 text-sm font-medium tabular-nums text-brand-dark">
            {formatMoney(d.total, d.currency)}
          </span>
        </div>
      </Link>
      {canDelete ? (
        <div className="absolute top-3 right-3">
          <DeleteDocumentButton
            documentId={d.id}
            numberLabel={numberLabel}
            status={d.status}
            action={deleteDocument}
          />
        </div>
      ) : null}
    </div>
  );
}
