"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { CatalogThumb } from "@/components/catalog/catalog-thumb";
import { PriceDisplay, InactiveBadge } from "@/components/catalog-badges";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/actions/catalog";
import type { ProductListItem } from "@/lib/queries/catalog";

function arrayMove<T>(list: T[], from: number, to: number): T[] {
  const copy = list.slice();
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved);
  return copy;
}

/**
 * ADMIN's drag-to-reorder product list for a series (owner: "В каталозі
 * додай можливість перетаскуванням визначити порядок товарів в категорії" —
 * e.g. drag X-10180/X-10220/X-10390 to the bottom of X-Calibre). Reuses
 * exactly the drag-and-drop + keyboard-accessible Up/Down pattern
 * src/components/builder/items-list.tsx established for the builder's item
 * cards, for the same reason that file gives: native HTML5 drag doesn't
 * work on touch (this app's primary device), and a drag handle alone isn't
 * keyboard- or screen-reader-operable.
 *
 * One adaptive card list rather than `TableShell`'s separate desktop-table /
 * mobile-cards split — that split (see `SeriesProductsPage`) stays for the
 * read-only MANAGER view; building the same drag interactions twice, once
 * over a `<table>` and once over cards, wasn't worth it for a control only
 * admins see.
 *
 * Reordering is optimistic via `useOptimistic`, same settle-or-revert +
 * toast-and-refresh-on-error shape `ItemsList` uses: a rejected save can't
 * leave the page showing an order the server didn't accept, since
 * `products` itself never changed until `reorderProductsAction` succeeds,
 * and a `router.refresh()` re-syncs a client whose local list had gone
 * stale (e.g. another tab already reordered/edited a product).
 */
export function ProductReorderList({
  seriesId,
  products,
  reorderProductsAction,
}: {
  seriesId: string;
  products: ProductListItem[];
  reorderProductsAction: (seriesId: string, orderedProductIds: string[]) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [optimisticProducts, setOptimisticProducts] = useOptimistic(
    products,
    (_state: ProductListItem[], newOrder: ProductListItem[]) => newOrder
  );
  const [, startTransition] = useTransition();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  function commitOrder(newOrder: ProductListItem[]) {
    startTransition(async () => {
      setOptimisticProducts(newOrder);
      const result = await reorderProductsAction(
        seriesId,
        newOrder.map((p) => p.id)
      );
      if (result?.error) {
        toast.error(result.error);
        router.refresh();
      }
    });
  }

  function moveBy(index: number, delta: number) {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= optimisticProducts.length) return;
    commitOrder(arrayMove(optimisticProducts, index, targetIndex));
  }

  function handleDrop(targetId: string) {
    setDropTargetId(null);
    const sourceId = draggingId;
    setDraggingId(null);
    if (!sourceId || sourceId === targetId) return;
    const fromIndex = optimisticProducts.findIndex((p) => p.id === sourceId);
    const toIndex = optimisticProducts.findIndex((p) => p.id === targetId);
    if (fromIndex === -1 || toIndex === -1) return;
    commitOrder(arrayMove(optimisticProducts, fromIndex, toIndex));
  }

  return (
    <div className="flex flex-col gap-2">
      {optimisticProducts.map((p, index) => {
        const isDragging = draggingId === p.id;
        const isDropTarget = dropTargetId === p.id && draggingId !== p.id;
        return (
          <div
            key={p.id}
            onDragOver={(event) => {
              if (!draggingId) return;
              event.preventDefault();
              if (dropTargetId !== p.id) setDropTargetId(p.id);
            }}
            onDragLeave={() => {
              setDropTargetId((current) => (current === p.id ? null : current));
            }}
            onDrop={(event) => {
              event.preventDefault();
              handleDrop(p.id);
            }}
            className={cn(
              "flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-2 transition-[opacity,box-shadow] duration-150 motion-reduce:transition-none sm:p-3",
              isDragging && "opacity-50",
              isDropTarget && "ring-2 ring-brand",
              !p.active && "opacity-60"
            )}
          >
            <button
              type="button"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", p.id);
                setDraggingId(p.id);
              }}
              onDragEnd={() => {
                setDraggingId(null);
                setDropTargetId(null);
              }}
              aria-label={`Reorder ${p.name}`}
              className="focus-ring flex size-11 shrink-0 cursor-grab items-center justify-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-600 active:cursor-grabbing"
            >
              <GripVertical className="size-4" aria-hidden="true" />
            </button>

            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => moveBy(index, -1)}
                disabled={index === 0}
                aria-label={`Move ${p.name} up`}
                className="focus-ring flex size-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-600 disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronUp className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => moveBy(index, 1)}
                disabled={index === optimisticProducts.length - 1}
                aria-label={`Move ${p.name} down`}
                className="focus-ring flex size-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-600 disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronDown className="size-4" aria-hidden="true" />
              </button>
            </div>

            <Link
              href={`/catalog/${seriesId}/${p.id}`}
              className="focus-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1"
            >
              {/* Image, then code, then name, then description — the same
                  order the read-only rows and the options list use. This view
                  is what an ADMIN actually sees on a series page, so it
                  leading with the code instead was the whole reason products
                  looked different from options.

                  Product photos are landscape (1280x768 as shot), so they get
                  a wider box than CatalogThumb's square default — same width
                  SeriesProductsPage's own rows use. CatalogThumb reserves that
                  box even with no image, which is what keeps the codes in a
                  column rather than ragged. */}
              <CatalogThumb src={p.imageUrl} width={64} />
              <span className="shrink-0 font-mono text-sm text-brand-dark">{p.code}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-slate-700">{p.name}</span>
                {p.description ? (
                  <span className="block truncate text-xs text-slate-500">{p.description}</span>
                ) : null}
              </span>
              {!p.active ? <InactiveBadge /> : null}
              <PriceDisplay price={p.price} />
            </Link>
          </div>
        );
      })}
    </div>
  );
}
