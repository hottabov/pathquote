"use client";

import { useState, useTransition } from "react";
import { Plus, ChevronLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
import { addItem } from "@/lib/actions/documents";
import type { ItemPickerSeries } from "@/lib/queries/documents";

/**
 * "Add item" for the builder: a two-step picker over the whole catalog tree
 * (preloaded server-side, see getItemPickerCatalog) — series list, then
 * that series' products. A product with no usable price in the document's
 * region is shown but disabled with a "price required" badge instead of
 * being hidden, so a manager can see it exists and knows why it can't be
 * added yet. Collapses back to a single "+ Add item" button after a
 * successful add (or on cancel).
 */
export function AddItemPicker({
  documentId,
  catalog,
}: {
  documentId: string;
  catalog: ItemPickerSeries[];
}) {
  const [open, setOpen] = useState(false);
  const [seriesCode, setSeriesCode] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const activeSeries = catalog.find((s) => s.code === seriesCode) ?? null;

  function close() {
    setOpen(false);
    setSeriesCode(null);
    setError(null);
  }

  function handleAdd(productCode: string, productName: string) {
    setError(null);
    startTransition(async () => {
      const result = await addItem(documentId, productCode);
      if (result?.error) {
        setError(result.error);
        return;
      }
      toast.success(`Added ${productName}`);
      close();
    });
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="success"
        onClick={() => setOpen(true)}
        className="h-11 w-full gap-2 px-5 text-[0.9375rem] sm:w-fit"
      >
        <Plus className="size-4" aria-hidden="true" />
        Add item
      </Button>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-2">
        {activeSeries ? (
          <button
            type="button"
            onClick={() => setSeriesCode(null)}
            className="focus-ring flex min-h-11 items-center gap-1 rounded-md px-1 text-sm font-medium text-brand-dark"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
            {activeSeries.name}
          </button>
        ) : (
          <span className="text-sm font-medium text-brand-dark">Choose a product</span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={close}
          aria-label="Cancel"
          className="size-11"
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <div className="mt-3 flex max-h-72 flex-col gap-1 overflow-y-auto">
        {!activeSeries
          ? catalog.map((series) => (
              <button
                key={series.code}
                type="button"
                onClick={() => setSeriesCode(series.code)}
                className="focus-ring flex min-h-11 items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-white"
              >
                <span>{series.name}</span>
                <span className="text-xs text-slate-500">
                  {series.products.length} {series.products.length === 1 ? "product" : "products"}
                </span>
              </button>
            ))
          : activeSeries.products.map((product) => (
              <button
                key={product.code}
                type="button"
                disabled={!product.priced || pending}
                onClick={() => handleAdd(product.code, product.name)}
                className={cn(
                  "focus-ring flex min-h-11 items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-white",
                  "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                )}
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="font-mono text-xs text-brand-dark">{product.code}</span>
                  <span className="truncate">{product.name}</span>
                </span>
                {!product.priced && (
                  <StatusBadge tone="rose" className="shrink-0">
                    price required
                  </StatusBadge>
                )}
              </button>
            ))}
        {activeSeries && activeSeries.products.length === 0 ? (
          <p className="px-2 py-2 text-sm text-slate-500">No products in this series.</p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
