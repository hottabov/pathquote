"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldInputClass, StatusBadge, tableClassName, tableHeadRowClassName, tableRowClassName } from "@/components/ui-kit";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
import type { ApplyInput, ApplyResult, PreviewResult } from "@/lib/actions/catalog-import";
import type { CatalogDiff, FieldValue, RowBuckets, PriceBuckets, BucketCounts } from "@/lib/catalog-xlsx/diff";

/**
 * The import half of Settings -> Import / Export: choose a workbook, preview
 * every change the file would make, confirm, see the result. The two
 * server actions are handed in as props (same pattern as
 * `SupportMessageForm`) so this component never imports a `"use server"`
 * module itself.
 *
 * After a preview the browser keeps the raw sheet cells the server returned
 * and sends them back on confirm together with the previewed counts; the
 * server re-runs the whole pipeline against the live catalogue and refuses
 * to apply if the counts moved (see applyCatalogImport).
 */
export function CatalogImportPanel({
  preview,
  apply,
}: {
  preview: (formData: FormData) => Promise<PreviewResult>;
  apply: (input: ApplyInput) => Promise<ApplyResult>;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [applied, setApplied] = useState<ApplyResult | null>(null);

  function handlePreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setResult({ kind: "error", message: "Choose an .xlsx file to import." });
      return;
    }
    setApplied(null);
    setResult(null);
    startTransition(async () => {
      const r = await preview(formData);
      setResult(r);
    });
  }

  async function handleApply() {
    if (!result || result.kind !== "preview") return;
    const { counts } = result.diff;
    const deletes = counts.products.deleted + counts.options.deleted;
    const confirmed = await confirm({
      title: deletes > 0 ? "Apply this import and delete rows?" : "Apply this import?",
      description:
        deletes > 0
          ? `This will delete ${counts.products.deleted} product${counts.products.deleted === 1 ? "" : "s"} and ${counts.options.deleted} option${counts.options.deleted === 1 ? "" : "s"} from the catalogue and remove their lines from ${counts.affectedDraftDocuments} draft quote${counts.affectedDraftDocuments === 1 ? "" : "s"}. Finalized quotes are not touched. This can't be undone.`
          : `${summarise(counts)} will be written to the catalogue.`,
      confirmLabel: deletes > 0 ? "Delete and apply" : "Apply import",
      tone: deletes > 0 ? "danger" : "default",
    });
    if (!confirmed) return;

    const input: ApplyInput = { fileName: result.fileName, expectedCounts: result.diff.counts, sheets: result.sheets };
    startTransition(async () => {
      const r = await apply(input);
      setApplied(r);
      if (r.kind === "applied") {
        setResult(null);
        formRef.current?.reset();
        setFileName(null);
        toast.success("Catalogue updated");
        router.refresh();
      } else {
        toast.error(r.message);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <form ref={formRef} onSubmit={handlePreview} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="text-sm font-medium text-brand-dark">Workbook (.xlsx)</span>
          <input
            type="file"
            name="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            required
            disabled={pending}
            onChange={(e) => setFileName(e.currentTarget.files?.[0]?.name ?? null)}
            className={cn(fieldInputClass, "py-2 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1 file:text-sm file:font-medium file:text-brand-dark")}
          />
        </label>
        <Button type="submit" disabled={pending || !fileName} className="h-11 w-full bg-brand text-white hover:bg-brand/90 sm:w-auto">
          <Upload className="size-4" data-icon="inline-start" aria-hidden="true" />
          {pending && !result ? "Reading…" : "Preview changes"}
        </Button>
      </form>

      {applied?.kind === "applied" ? (
        <div role="status" className="flex items-start gap-3 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-medium">Import applied.</p>
            <p>
              {summarise(applied.summary.counts)}
              {applied.summary.recalculatedDrafts > 0
                ? ` · ${applied.summary.recalculatedDrafts} draft quote${applied.summary.recalculatedDrafts === 1 ? "" : "s"} recalculated`
                : ""}
              .
            </p>
          </div>
        </div>
      ) : null}

      {applied?.kind === "error" || result?.kind === "error" ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{applied?.kind === "error" ? applied.message : result?.kind === "error" ? result.message : null}</span>
        </p>
      ) : null}

      {result?.kind === "invalid" ? <ValidationErrors result={result} /> : null}

      {result?.kind === "preview" ? (
        <Preview diff={result.diff} fileName={result.fileName} pending={pending} onApply={handleApply} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

function ValidationErrors({ result }: { result: Extract<PreviewResult, { kind: "invalid" }> }) {
  return (
    <div className="flex flex-col gap-3">
      <p role="alert" className="flex items-start gap-2 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>
          <span className="font-medium">{result.fileName}</span> has {result.errors.length} problem{result.errors.length === 1 ? "" : "s"}. Fix
          them in Excel and upload again -- nothing has been changed.
        </span>
      </p>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className={tableClassName}>
          <thead>
            <tr className={tableHeadRowClassName}>
              <th scope="col" className="px-4 py-2">
                Sheet
              </th>
              <th scope="col" className="px-4 py-2">
                Row
              </th>
              <th scope="col" className="px-4 py-2">
                Column
              </th>
              <th scope="col" className="px-4 py-2">
                Problem
              </th>
            </tr>
          </thead>
          <tbody>
            {result.errors.map((e, i) => (
              <tr key={i} className={tableRowClassName}>
                <td className="px-4 py-2 text-sm text-slate-600">{e.sheet || "—"}</td>
                <td className="px-4 py-2 font-mono text-xs text-slate-600">{e.row > 0 ? e.row : "—"}</td>
                <td className="px-4 py-2 font-mono text-xs text-slate-600">{e.column ?? "—"}</td>
                <td className="px-4 py-2 text-sm text-rose-800">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function summarise(counts: CatalogDiff["counts"]): string {
  const parts: string[] = [];
  for (const [label, b] of [
    ["products", counts.products],
    ["options", counts.options],
    ["prices", counts.prices],
  ] as const) {
    const n = b.updated + b.created + b.deleted;
    if (n > 0) parts.push(`${n} ${label}`);
  }
  return parts.length ? `${parts.join(", ")} changed` : "No changes";
}

function Preview({
  diff,
  fileName,
  pending,
  onApply,
}: {
  diff: CatalogDiff;
  fileName: string;
  pending: boolean;
  onApply: () => void;
}) {
  const { counts } = diff;
  const deletes = counts.products.deleted + counts.options.deleted;
  const nothing = [counts.products, counts.options, counts.prices].every((b) => b.updated + b.created + b.deleted === 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2 text-sm text-slate-600">
        <FileSpreadsheet className="size-4 shrink-0 text-slate-500" aria-hidden="true" />
        <span>
          Preview of <span className="font-medium text-brand-dark">{fileName}</span> against the live catalogue. Nothing has been written yet.
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className={tableClassName}>
          <thead>
            <tr className={tableHeadRowClassName}>
              <th scope="col" className="px-4 py-2">
                Sheet
              </th>
              <th scope="col" className="px-4 py-2 text-right">
                Unchanged
              </th>
              <th scope="col" className="px-4 py-2 text-right">
                Updated
              </th>
              <th scope="col" className="px-4 py-2 text-right">
                Created
              </th>
              <th scope="col" className="px-4 py-2 text-right">
                Deleted
              </th>
            </tr>
          </thead>
          <tbody>
            <CountsRow label="Products" counts={counts.products} />
            <CountsRow label="Options" counts={counts.options} />
            <CountsRow label="Prices" counts={counts.prices} />
          </tbody>
        </table>
      </div>

      {deletes > 0 ? (
        <p className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            This import deletes {counts.products.deleted} product{counts.products.deleted === 1 ? "" : "s"} and {counts.options.deleted}{" "}
            option{counts.options.deleted === 1 ? "" : "s"}, and removes their lines from {counts.affectedDraftDocuments} draft quote
            {counts.affectedDraftDocuments === 1 ? "" : "s"}. Finalized quotes keep their snapshots and are not touched.
          </span>
        </p>
      ) : null}

      <RowSection title="Products" buckets={diff.products} />
      <RowSection title="Options" buckets={diff.options} />
      <PriceSection buckets={diff.prices} />

      <div className="flex flex-col gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-slate-500">{nothing ? "The file matches the catalogue -- there is nothing to apply." : summarise(counts)}</p>
        <Button
          type="button"
          onClick={onApply}
          disabled={pending || nothing}
          variant={deletes > 0 ? "destructive" : "default"}
          className={cn("h-11 w-full sm:w-auto", deletes === 0 && "bg-brand text-white hover:bg-brand/90")}
        >
          {pending ? "Applying…" : deletes > 0 ? `Apply and delete ${deletes} row${deletes === 1 ? "" : "s"}` : "Apply import"}
        </Button>
      </div>
    </div>
  );
}

function CountsRow({ label, counts }: { label: string; counts: BucketCounts }) {
  const cell = (n: number, tone: "slate" | "amber" | "green" | "rose") => (
    <td className={cn("px-4 py-2 text-right font-mono text-sm", n === 0 ? "text-slate-400" : tone === "rose" ? "font-semibold text-rose-700" : "text-brand-dark")}>
      {n}
    </td>
  );
  return (
    <tr className={tableRowClassName}>
      <td className="px-4 py-2 text-sm font-medium text-brand-dark">{label}</td>
      {cell(counts.unchanged, "slate")}
      {cell(counts.updated, "amber")}
      {cell(counts.created, "green")}
      {cell(counts.deleted, "rose")}
    </tr>
  );
}

function show(v: FieldValue): string {
  if (v === null) return "—";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

function Bucket({ title, count, tone, children }: { title: string; count: number; tone: "amber" | "green" | "rose"; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <details open={count <= 25} className="rounded-xl border border-slate-200 bg-white">
      <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium text-brand-dark">
        <StatusBadge tone={tone}>{count}</StatusBadge>
        {title}
      </summary>
      <div className="overflow-x-auto border-t border-slate-100">{children}</div>
    </details>
  );
}

function RowSection({ title, buckets }: { title: string; buckets: RowBuckets }) {
  if (buckets.updated.length + buckets.created.length + buckets.deleted.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">{title}</h3>

      <Bucket title={`${title} to update`} count={buckets.updated.length} tone="amber">
        <table className={tableClassName}>
          <thead>
            <tr className={tableHeadRowClassName}>
              <th scope="col" className="px-4 py-2">
                Code
              </th>
              <th scope="col" className="px-4 py-2">
                Field
              </th>
              <th scope="col" className="px-4 py-2">
                Before
              </th>
              <th scope="col" className="px-4 py-2">
                After
              </th>
            </tr>
          </thead>
          <tbody>
            {buckets.updated.flatMap((u) =>
              u.changes.map((c, i) => (
                <tr key={`${u.id}-${c.field}`} className={tableRowClassName}>
                  <td className="px-4 py-2 align-top font-mono text-xs text-brand-dark">
                    {i === 0 ? (
                      <>
                        {u.code}
                        <span className="block font-sans text-xs text-slate-500">row {u.row}</span>
                      </>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 align-top font-mono text-xs text-slate-600">{c.field}</td>
                  <td className="max-w-xs px-4 py-2 align-top text-sm break-words text-slate-500 line-through decoration-slate-300">{show(c.before)}</td>
                  <td className="max-w-xs px-4 py-2 align-top text-sm break-words text-brand-dark">{show(c.after)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Bucket>

      <Bucket title={`${title} to create`} count={buckets.created.length} tone="green">
        <table className={tableClassName}>
          <thead>
            <tr className={tableHeadRowClassName}>
              <th scope="col" className="px-4 py-2">
                Row
              </th>
              <th scope="col" className="px-4 py-2">
                Code
              </th>
              <th scope="col" className="px-4 py-2">
                Name
              </th>
            </tr>
          </thead>
          <tbody>
            {buckets.created.map((c) => (
              <tr key={c.row} className={tableRowClassName}>
                <td className="px-4 py-2 font-mono text-xs text-slate-500">{c.row}</td>
                <td className="px-4 py-2 font-mono text-xs text-brand-dark">{c.code}</td>
                <td className="px-4 py-2 text-sm text-slate-600">{c.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Bucket>

      <Bucket title={`${title} to delete`} count={buckets.deleted.length} tone="rose">
        <table className={tableClassName}>
          <thead>
            <tr className={tableHeadRowClassName}>
              <th scope="col" className="px-4 py-2">
                Code
              </th>
              <th scope="col" className="px-4 py-2">
                Name
              </th>
              <th scope="col" className="px-4 py-2">
                Quotes
              </th>
            </tr>
          </thead>
          <tbody>
            {buckets.deleted.map((d) => (
              <tr key={d.id} className={tableRowClassName}>
                <td className="px-4 py-2 font-mono text-xs text-brand-dark">{d.code}</td>
                <td className="px-4 py-2 text-sm text-slate-600">{d.name}</td>
                <td className="px-4 py-2 text-sm">
                  <span className={cn(d.draftDocuments > 0 ? "font-medium text-rose-700" : "text-slate-500")}>
                    affects {d.draftDocuments} draft quote{d.draftDocuments === 1 ? "" : "s"}
                  </span>
                  <span className="text-slate-500">
                    {" "}
                    · {d.finalDocuments} finalized quote{d.finalDocuments === 1 ? "" : "s"} untouched
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Bucket>
    </section>
  );
}

function PriceSection({ buckets }: { buckets: PriceBuckets }) {
  if (buckets.updated.length + buckets.created.length + buckets.deleted.length === 0) return null;
  const head = (
    <thead>
      <tr className={tableHeadRowClassName}>
        <th scope="col" className="px-4 py-2">
          Item
        </th>
        <th scope="col" className="px-4 py-2">
          Region
        </th>
        <th scope="col" className="px-4 py-2 text-right">
          Before
        </th>
        <th scope="col" className="px-4 py-2 text-right">
          After
        </th>
      </tr>
    </thead>
  );
  const price = (p: { amount: number; needsReview: boolean }) => `${p.amount.toLocaleString("en-AU")}${p.needsReview ? " (review)" : ""}`;
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">Prices</h3>

      <Bucket title="Prices to update" count={buckets.updated.length} tone="amber">
        <table className={tableClassName}>
          {head}
          <tbody>
            {buckets.updated.map((p) => (
              <tr key={`${p.itemType}-${p.itemCode}-${p.region}`} className={tableRowClassName}>
                <td className="px-4 py-2 font-mono text-xs text-brand-dark">
                  {p.itemCode} <span className="text-slate-500">({p.itemType})</span>
                </td>
                <td className="px-4 py-2 font-mono text-xs text-slate-600">{p.region}</td>
                <td className="px-4 py-2 text-right font-mono text-sm text-slate-500 line-through decoration-slate-300">{price(p.before)}</td>
                <td className="px-4 py-2 text-right font-mono text-sm text-brand-dark">{price(p.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Bucket>

      <Bucket title="Prices to create" count={buckets.created.length} tone="green">
        <table className={tableClassName}>
          {head}
          <tbody>
            {buckets.created.map((p) => (
              <tr key={`${p.itemType}-${p.itemCode}-${p.region}`} className={tableRowClassName}>
                <td className="px-4 py-2 font-mono text-xs text-brand-dark">
                  {p.itemCode} <span className="text-slate-500">({p.itemType})</span>
                </td>
                <td className="px-4 py-2 font-mono text-xs text-slate-600">{p.region}</td>
                <td className="px-4 py-2 text-right font-mono text-sm text-slate-400">—</td>
                <td className="px-4 py-2 text-right font-mono text-sm text-brand-dark">{price(p)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Bucket>

      <Bucket title="Prices to delete" count={buckets.deleted.length} tone="rose">
        <table className={tableClassName}>
          {head}
          <tbody>
            {buckets.deleted.map((p) => (
              <tr key={`${p.itemType}-${p.itemCode}-${p.region}`} className={tableRowClassName}>
                <td className="px-4 py-2 font-mono text-xs text-brand-dark">
                  {p.itemCode} <span className="text-slate-500">({p.itemType})</span>
                </td>
                <td className="px-4 py-2 font-mono text-xs text-slate-600">{p.region}</td>
                <td className="px-4 py-2 text-right font-mono text-sm text-slate-500 line-through decoration-slate-300">{price(p)}</td>
                <td className="px-4 py-2 text-right font-mono text-sm text-slate-400">—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Bucket>
    </section>
  );
}
