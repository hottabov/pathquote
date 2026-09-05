"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
import type { VisibilitySeriesRow } from "@/lib/queries/catalog-visibility-admin";

/**
 * Series/product checkbox tree for one user's `CatalogVisibility`.
 * Checking hides. Mirrors `CompatEditor`'s (src/components/catalog/compat-editor.tsx)
 * "send the full desired set, let the action diff it" interaction — the
 * admin toggles freely client-side, then one Save call reconciles both the
 * series-level and product-level sets against the database at once.
 *
 * A series checkbox and its products' checkboxes are independent controls
 * over independent `CatalogVisibility` rows (see the model's own doc
 * comment): checking a series doesn't check its products, and a product
 * stays individually toggleable regardless of its series' state — hiding
 * the series already hides every product under it in every query that
 * reads this (`isProductHidden`), so nothing here needs to keep them in
 * sync, only to explain the overlap.
 */
export function CatalogVisibilityEditor({
  userId,
  series,
  action,
}: {
  userId: string;
  series: VisibilitySeriesRow[];
  action: (
    userId: string,
    hiddenSeriesCodes: string[],
    hiddenProductCodes: string[]
  ) => Promise<{ error?: string }>;
}) {
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(
    () => new Set(series.filter((s) => s.hidden).map((s) => s.code))
  );
  const [hiddenProducts, setHiddenProducts] = useState<Set<string>>(
    () => new Set(series.flatMap((s) => s.products.filter((p) => p.hidden).map((p) => p.code)))
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  function toggleSeries(code: string) {
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
    setError(null);
  }

  function toggleProduct(code: string) {
    setHiddenProducts((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
    setError(null);
  }

  function save() {
    startTransition(async () => {
      const res = await action(userId, Array.from(hiddenSeries), Array.from(hiddenProducts));
      if (res.error) {
        setError(res.error);
        return;
      }
      setError(null);
      toast.success("Catalogue visibility saved");
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3">
        {series.map((s) => {
          const seriesHidden = hiddenSeries.has(s.code);
          return (
            <div key={s.id} className="rounded-lg border border-slate-200">
              <label
                htmlFor={`visibility-series-${s.id}`}
                className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-slate-100 bg-slate-50 px-3 py-2 text-sm last:border-b-0 hover:bg-slate-100"
              >
                <input
                  id={`visibility-series-${s.id}`}
                  type="checkbox"
                  checked={seriesHidden}
                  onChange={() => toggleSeries(s.code)}
                  className="size-4 shrink-0 rounded border-slate-300 accent-brand"
                />
                <span className="font-mono text-xs text-slate-500">{s.code}</span>
                <span className="min-w-0 truncate font-medium text-brand-dark">{s.name}</span>
                {seriesHidden ? (
                  <span className="ml-auto shrink-0 text-xs text-slate-500">
                    Hides every product below
                  </span>
                ) : null}
              </label>

              {s.products.length === 0 ? (
                <p className="px-3 py-2 pl-9 text-sm text-slate-400">No products in this series.</p>
              ) : (
                s.products.map((p) => {
                  const productHidden = hiddenProducts.has(p.code);
                  return (
                    <label
                      key={p.id}
                      htmlFor={`visibility-product-${p.id}`}
                      className={cn(
                        "flex min-h-11 cursor-pointer items-center gap-3 border-b border-slate-100 py-2 pr-3 pl-9 text-sm last:border-b-0 hover:bg-slate-50",
                        seriesHidden && "opacity-60"
                      )}
                    >
                      <input
                        id={`visibility-product-${p.id}`}
                        type="checkbox"
                        checked={productHidden}
                        onChange={() => toggleProduct(p.code)}
                        className="size-4 shrink-0 rounded border-slate-300 accent-brand"
                      />
                      <span className="font-mono text-xs text-slate-500">{p.code}</span>
                      <span className="min-w-0 truncate text-slate-700">{p.name}</span>
                    </label>
                  );
                })
              )}
            </div>
          );
        })}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button
        type="button"
        onClick={save}
        disabled={pending}
        className="h-11 w-full bg-brand text-white hover:bg-brand/90 sm:w-fit"
      >
        {pending ? "Saving…" : "Save visibility"}
      </Button>
    </div>
  );
}
