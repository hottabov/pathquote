import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Download, History } from "lucide-react";
import { auth } from "@/auth";
import { isAdminRole } from "@/lib/roles";
import { listCatalogImports, type CatalogImportHistoryItem } from "@/lib/queries/catalog-xlsx";
import { applyCatalogImport, previewCatalogImport } from "@/lib/actions/catalog-import";
import { CatalogImportPanel } from "@/components/settings/catalog-import-panel";
import { buttonVariants } from "@/components/ui/button";
import {
  PageHeader,
  SectionCard,
  StatusBadge,
  TableShell,
  tableClassName,
  tableHeadRowClassName,
  tableRowClassName,
  EmptyState,
} from "@/components/ui-kit";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Import / Export" };
export const dynamic = "force-dynamic";

/**
 * Settings -> Import / Export: the catalogue as a workbook. Download it,
 * edit it in Excel, upload it back; the app shows every change it would
 * make and writes nothing until the admin confirms
 * (docs/plans/2026-09-05-catalog-import-export.md).
 */
export default async function ImportExportPage() {
  // notFound() rather than a redirect: a Manager hitting a stale bookmark
  // shouldn't be told the page exists at all.
  const session = await auth();
  if (!isAdminRole(session?.user?.role)) notFound();

  const history = await listCatalogImports(10);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Import / Export"
        description="Download the catalogue as a workbook, edit it in Excel, and upload it back. Every change is previewed before anything is written."
      />

      <SectionCard
        title="Export"
        description="One workbook with Products, Options and Prices sheets (plus a README with the editing rules). Every row leads with its database id -- that is what the import matches on."
      >
        <a
          href="/api/catalog/export"
          className={cn(buttonVariants(), "h-11 w-full bg-brand text-white hover:bg-brand/90 sm:w-auto")}
        >
          <Download className="size-4" data-icon="inline-start" aria-hidden="true" />
          Download catalogue (.xlsx)
        </a>
      </SectionCard>

      <SectionCard
        title="Import"
        description="Upload an edited workbook. Rows are matched by id; a row with a blank id is created; a row missing from the file is deleted from the catalogue -- finalized quotes keep their snapshots, draft quotes lose the line and are recalculated."
      >
        <CatalogImportPanel preview={previewCatalogImport} apply={applyCatalogImport} />
      </SectionCard>

      <SectionCard title="Recent imports" description="The last ten confirmed imports, newest first.">
        {history.length === 0 ? (
          <EmptyState icon={History} title="No imports yet" description="Confirmed imports are recorded here with their counts." />
        ) : (
          <TableShell
            table={
              <table className={tableClassName}>
                <thead>
                  <tr className={tableHeadRowClassName}>
                    <th scope="col" className="px-4 py-3">
                      When
                    </th>
                    <th scope="col" className="px-4 py-3">
                      Who
                    </th>
                    <th scope="col" className="px-4 py-3">
                      File
                    </th>
                    <th scope="col" className="px-4 py-3">
                      Changes
                    </th>
                    <th scope="col" className="px-4 py-3">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id} className={tableRowClassName}>
                      <td className="px-4 py-3 text-sm whitespace-nowrap text-slate-600">{formatWhen(h.createdAt)}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{h.user.name ?? h.user.email}</td>
                      <td className="px-4 py-3 font-mono text-xs text-brand-dark">{h.fileName}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{countsSummary(h.counts)}</td>
                      <td className="px-4 py-3">
                        <ImportStatus item={h} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            }
            cards={history.map((h) => (
              <div key={h.id} className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-brand-dark">{h.fileName}</p>
                    <p className="text-sm text-slate-500">
                      {formatWhen(h.createdAt)} · {h.user.name ?? h.user.email}
                    </p>
                  </div>
                  <ImportStatus item={h} />
                </div>
                <p className="text-sm text-slate-600">{countsSummary(h.counts)}</p>
              </div>
            ))}
          />
        )}
      </SectionCard>
    </div>
  );
}

function ImportStatus({ item }: { item: CatalogImportHistoryItem }) {
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <StatusBadge tone={item.status === "APPLIED" ? "green" : "rose"}>{item.status === "APPLIED" ? "Applied" : "Failed"}</StatusBadge>
      {item.error ? <span className="max-w-xs text-xs text-slate-500">{item.error}</span> : null}
    </span>
  );
}

function formatWhen(date: Date): string {
  return date.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

type StoredCounts = {
  products?: { updated?: number; created?: number; deleted?: number };
  options?: { updated?: number; created?: number; deleted?: number };
  prices?: { updated?: number; created?: number; deleted?: number };
  affectedDraftDocuments?: number;
};

/** "3 products, 12 prices changed · 1 draft recalculated" from the stored counts JSON. */
function countsSummary(raw: unknown): string {
  const counts = (raw ?? {}) as StoredCounts;
  const parts: string[] = [];
  for (const [label, bucket] of [
    ["products", counts.products],
    ["options", counts.options],
    ["prices", counts.prices],
  ] as const) {
    const n = (bucket?.updated ?? 0) + (bucket?.created ?? 0) + (bucket?.deleted ?? 0);
    if (n > 0) parts.push(`${n} ${label}`);
  }
  const drafts = counts.affectedDraftDocuments ?? 0;
  const changes = parts.length ? `${parts.join(", ")} changed` : "No changes";
  return drafts > 0 ? `${changes} · ${drafts} draft${drafts === 1 ? "" : "s"} recalculated` : changes;
}
