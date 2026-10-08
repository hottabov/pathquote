"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
import { countCatalogueShown, describeCatalogueAccess } from "@/lib/catalog-visibility-summary";
import type { VisibilitySeriesRow } from "@/lib/queries/catalog-visibility-admin";

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

/**
 * Series/product checkbox tree for one user's `CatalogVisibility`. A tick
 * SHOWS: a ticked series or product is in this user's catalogue, an unticked
 * one is not. By default nothing is hidden, so by default everything is ticked.
 * Agrees with `ContactsVisibilityEditor` directly below it, where a tick also
 * grants.
 *
 * THE BOUNDARY. The admin thinks in "shown"; the database stores "hidden". The
 * `CatalogVisibility` table is a sparse deny-list -- one row per hidden thing,
 * zero rows for a user who sees everything, which is the normal case -- and
 * every enforcement path reads it as hidden (`isSeriesHidden`,
 * `getHiddenCatalogIds`, the item picker, `addItem`'s server-side recheck,
 * catalog-xlsx/apply-plan.ts). This component is the only place the two
 * vocabularies meet, and the inversion lives here on purpose: it is a
 * presentation choice, rendered as `checked={!hidden}`, not a storage one. So
 * `action` still takes `hiddenSeriesIds` / `hiddenProductIds` and the query
 * still returns `hidden` flags. Do not "simplify" by renaming those to "shown":
 * that would mean a row per visible series and product per user (hundreds,
 * rewritten on every save, for the default case), a change to every consumer
 * above, and a new user with no rows would default to seeing nothing.
 *
 * State is therefore kept as hidden ids, not shown ids. It is the shape the
 * query hands in and the action takes, so there is no conversion on load or on
 * Save to get wrong; and a mistake in a deny-list fails toward showing too much
 * (a fresh editor with empty sets is "everything ticked"), where a mistake in a
 * shown-list would fail toward blanking a user's whole catalogue.
 *
 * Mirrors `CompatEditor`'s (src/components/catalog/compat-editor.tsx) "send the
 * full desired set, let the action diff it" interaction -- the admin toggles
 * freely client-side, then one Save call reconciles both the series-level and
 * product-level sets against the database at once.
 *
 * A series checkbox and its products' checkboxes are independent controls over
 * independent `CatalogVisibility` rows (see the model's own doc comment):
 * unticking a series doesn't untick its products, and a product stays
 * individually toggleable regardless of its series' state. An unticked series
 * already hides every product under it in every query that reads this
 * (`isProductHidden`), so nothing here needs to keep them in sync, only to
 * explain the overlap: the series says so beside its name and the products
 * under it are dimmed.
 *
 * Both sets are keyed by id, and ids are what go to the action: the codes
 * printed beside each checkbox are labels an admin can rename at any time.
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
    hiddenSeriesIds: string[],
    hiddenProductIds: string[]
  ) => Promise<{ error?: string }>;
}) {
  // What was last saved, to tell the admin whether the summary they are
  // reading is already in force. Moves forward on a successful save.
  const [saved, setSaved] = useState(() => ({
    series: new Set(series.filter((s) => s.hidden).map((s) => s.id)),
    products: new Set(series.flatMap((s) => s.products.filter((p) => p.hidden).map((p) => p.id))),
  }));
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set(saved.series));
  const [hiddenProducts, setHiddenProducts] = useState<Set<string>>(() => new Set(saved.products));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const access = useMemo(
    () =>
      describeCatalogueAccess(
        countCatalogueShown(series, { seriesIds: hiddenSeries, productIds: hiddenProducts })
      ),
    [series, hiddenSeries, hiddenProducts]
  );
  const dirty = !sameSet(hiddenSeries, saved.series) || !sameSet(hiddenProducts, saved.products);
  const anythingHidden = hiddenSeries.size > 0 || hiddenProducts.size > 0;

  function toggleSeries(id: string) {
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setError(null);
  }

  function toggleProduct(id: string) {
    setHiddenProducts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setError(null);
  }

  /** Back to the default: every series and product ticked, no rows stored. */
  function tickAll() {
    setHiddenSeries(new Set());
    setHiddenProducts(new Set());
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
      setSaved({ series: new Set(hiddenSeries), products: new Set(hiddenProducts) });
      toast.success("Catalogue visibility saved");
    });
  }

  if (series.length === 0) {
    return <p className="text-sm text-slate-500">The catalogue has no series yet, so there is nothing to choose.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* The effect of the selection as it stands now, in words -- the same
          box the Contacts visibility card shows. */}
      <div
        aria-live="polite"
        className={cn(
          "rounded-lg border px-3 py-2 text-sm",
          access.tone === "none"
            ? "border-amber-300 bg-amber-50 text-amber-800"
            : "border-slate-200 bg-slate-50 text-slate-700"
        )}
      >
        <p className="flex items-start gap-2">
          {access.tone === "none" ? (
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          ) : null}
          <span className="font-medium">{access.summary}</span>
        </p>
        {access.warning ? <p className="mt-1">{access.warning}</p> : null}
        {dirty ? <p className="mt-1 text-xs opacity-80">Not saved yet.</p> : null}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <p id="visibility-catalogue-heading" className="text-sm font-medium text-brand-dark">
            Tick a series or product to <span className="underline underline-offset-2">show</span> it
          </p>
          {/* Only "Tick all": it is the way back to the default (no rows at
              all). An "Untick all" would either write a row per product or leave
              products looking ticked under hidden series, and hiding the whole
              catalogue from someone is not a case worth a button. */}
          <Button
            variant="ghost"
            type="button"
            onClick={tickAll}
            disabled={!anythingHidden}
            className="h-9 px-2 text-brand-dark"
          >
            Tick all
          </Button>
        </div>

        <div role="group" aria-labelledby="visibility-catalogue-heading" className="flex flex-col gap-3">
          {series.map((s) => {
            const seriesHidden = hiddenSeries.has(s.id);
            return (
              <div key={s.id} className="rounded-lg border border-slate-200">
                <label
                  htmlFor={`visibility-series-${s.id}`}
                  className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-slate-100 bg-slate-50 px-3 py-2 text-sm last:border-b-0 hover:bg-slate-100"
                >
                  <input
                    id={`visibility-series-${s.id}`}
                    type="checkbox"
                    checked={!seriesHidden}
                    onChange={() => toggleSeries(s.id)}
                    className="size-4 shrink-0 rounded border-slate-300 accent-brand"
                  />
                  <span className="font-mono text-xs text-slate-500">{s.code}</span>
                  <span className="min-w-0 truncate font-medium text-brand-dark">{s.name}</span>
                  {seriesHidden ? (
                    <span className="ml-auto shrink-0 text-xs text-slate-500">
                      <span className="sm:hidden">Hidden, with its products</span>
                      <span className="hidden sm:inline">Hidden, with every product below it</span>
                    </span>
                  ) : null}
                </label>

                {s.products.length === 0 ? (
                  <p className="px-3 py-2 pl-9 text-sm text-slate-400">No products in this series.</p>
                ) : (
                  s.products.map((p) => {
                    const productHidden = hiddenProducts.has(p.id);
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
                          checked={!productHidden}
                          onChange={() => toggleProduct(p.id)}
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
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button
        variant="brand"
        type="button"
        onClick={save}
        disabled={pending}
        className="h-11 w-full sm:w-fit"
      >
        {pending ? "Saving…" : "Save catalogue visibility"}
      </Button>
    </div>
  );
}
