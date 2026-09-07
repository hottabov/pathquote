"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { StatusBadge } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import type { ActionResult } from "@/lib/actions/quote-documents";
import type { QuoteDocumentListItem } from "@/lib/queries/quote-documents";
import { cn } from "@/lib/utils";

function arrayMove<T>(list: T[], from: number, to: number): T[] {
  const copy = list.slice();
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved);
  return copy;
}

/**
 * The ADMIN's drag-to-reorder list of quote documents — the order they print
 * on a quote, top to bottom. Same interaction `ProductReorderList`
 * (src/components/catalog/product-reorder-list.tsx) established for the
 * catalog, for the same two reasons: native HTML5 drag does not work on
 * touch, which is this app's primary device, and a drag handle alone is
 * neither keyboard- nor screen-reader-operable — WCAG 2.2 requires a
 * single-pointer alternative for any author-controlled drag, which is what
 * the Move up / Move down buttons beside each handle are.
 *
 * Optimistic via `useOptimistic`, settle-or-revert on error: `documents`
 * itself never changes until `reorderQuoteDocumentsAction` succeeds, so a
 * rejected save cannot leave the page showing an order the server refused,
 * and `router.refresh()` re-syncs a client whose list had gone stale (another
 * tab reordering, or a document created since this page loaded).
 *
 * Reordering writes the whole list at once, and the action applies each new
 * position to a document's default row AND to every region's own copy of it,
 * so a region's print order never drifts away from the one set here.
 */
export function DocumentReorderList({
  documents,
  reorderQuoteDocumentsAction,
}: {
  documents: QuoteDocumentListItem[];
  reorderQuoteDocumentsAction: (keys: string[]) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [optimisticDocuments, setOptimisticDocuments] = useOptimistic(
    documents,
    (_state: QuoteDocumentListItem[], newOrder: QuoteDocumentListItem[]) => newOrder
  );
  const [, startTransition] = useTransition();
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);

  function commitOrder(newOrder: QuoteDocumentListItem[]) {
    startTransition(async () => {
      setOptimisticDocuments(newOrder);
      const result = await reorderQuoteDocumentsAction(newOrder.map((d) => d.key));
      if (result?.error) {
        toast.error(result.error);
        router.refresh();
      }
    });
  }

  function moveBy(index: number, delta: number) {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= optimisticDocuments.length) return;
    commitOrder(arrayMove(optimisticDocuments, index, targetIndex));
  }

  function handleDrop(targetKey: string) {
    setDropTargetKey(null);
    const sourceKey = draggingKey;
    setDraggingKey(null);
    if (!sourceKey || sourceKey === targetKey) return;
    const fromIndex = optimisticDocuments.findIndex((d) => d.key === sourceKey);
    const toIndex = optimisticDocuments.findIndex((d) => d.key === targetKey);
    if (fromIndex === -1 || toIndex === -1) return;
    commitOrder(arrayMove(optimisticDocuments, fromIndex, toIndex));
  }

  return (
    <div className="flex flex-col gap-2">
      {optimisticDocuments.map((doc, index) => {
        const isDragging = draggingKey === doc.key;
        const isDropTarget = dropTargetKey === doc.key && draggingKey !== doc.key;
        return (
          <div
            key={doc.key}
            onDragOver={(event) => {
              if (!draggingKey) return;
              event.preventDefault();
              if (dropTargetKey !== doc.key) setDropTargetKey(doc.key);
            }}
            onDragLeave={() => {
              setDropTargetKey((current) => (current === doc.key ? null : current));
            }}
            onDrop={(event) => {
              event.preventDefault();
              handleDrop(doc.key);
            }}
            className={cn(
              "flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-2 transition-[opacity,box-shadow] duration-150 motion-reduce:transition-none sm:p-3",
              isDragging && "opacity-50",
              isDropTarget && "ring-2 ring-brand"
            )}
          >
            <button
              type="button"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", doc.key);
                setDraggingKey(doc.key);
              }}
              onDragEnd={() => {
                setDraggingKey(null);
                setDropTargetKey(null);
              }}
              aria-label={`Reorder ${doc.title}`}
              className="focus-ring flex size-11 shrink-0 cursor-grab items-center justify-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-600 active:cursor-grabbing"
            >
              <GripVertical className="size-4" aria-hidden="true" />
            </button>

            {/* The drag alternative. `size-11` rather than the catalog list's
                `size-9`: these are the only way to reorder without a pointer,
                so they get the full 44px target rather than the smaller one a
                secondary control can get away with. */}
            <div className="flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => moveBy(index, -1)}
                disabled={index === 0}
                aria-label={`Move ${doc.title} up`}
                className="focus-ring flex size-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-600 disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronUp className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => moveBy(index, 1)}
                disabled={index === optimisticDocuments.length - 1}
                aria-label={`Move ${doc.title} down`}
                className="focus-ring flex size-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-600 disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronDown className="size-4" aria-hidden="true" />
              </button>
            </div>

            <Link
              href={`/documents/${encodeURIComponent(doc.key)}`}
              className="focus-ring flex min-w-0 flex-1 flex-col gap-1 rounded-lg p-1 sm:flex-row sm:items-center sm:justify-between"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex min-w-0 items-baseline gap-2">
                  {/* The print position, said in a number as well as in the
                      row's place in the list — the order is the whole point
                      of this screen, and "second" is not obvious from
                      position alone once a row is mid-drag. */}
                  <span className="shrink-0 text-xs tabular-nums text-slate-400">{index + 1}</span>
                  <span className="truncate text-sm font-medium text-brand-dark">{doc.title}</span>
                </span>
                <span className="font-mono text-xs text-slate-500">{doc.key}</span>
              </span>
              <DocumentBadges document={doc} />
            </Link>
          </div>
        );
      })}
    </div>
  );
}

/** The three facts a row carries beyond its name: whether it exists only for
 * certain regions, which regions keep their own version, and whether a new
 * quote starts with it ticked. Shared with the read-only list a MANAGER sees,
 * so both say the same thing the same way. */
export function DocumentBadges({ document: doc }: { document: QuoteDocumentListItem }) {
  return (
    <span className="flex shrink-0 flex-wrap items-center gap-2">
      {doc.includedByDefault ? null : (
        <StatusBadge tone="slate">Off by default</StatusBadge>
      )}
      {doc.regionOnly ? (
        // A document with no global default: only the named regions print it,
        // every other region prints nothing for it. Said in words, not by the
        // absence of the "Customised for" badge — "no default" is exactly the
        // fact a reader cannot infer from what is missing, and it changes what
        // a customer in another region receives.
        <StatusBadge tone="amber">{`Only in: ${doc.regionCodes.join(", ")}`}</StatusBadge>
      ) : doc.regionCodes.length > 0 ? (
        <StatusBadge tone="brand-outline">{`Customised for: ${doc.regionCodes.join(", ")}`}</StatusBadge>
      ) : null}
    </span>
  );
}
