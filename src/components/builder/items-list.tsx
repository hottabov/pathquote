"use client";

import { useOptimistic, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { RemoveItemButton } from "@/components/builder/remove-item-button";
import { ItemOptionsEditor } from "@/components/builder/item-options-editor";
import { ItemDiscountField } from "@/components/builder/item-discount-field";
import { ItemBreakdownEditor } from "@/components/builder/item-breakdown-editor";
import { ItemShowImageToggle } from "@/components/builder/item-show-image-toggle";
import { ProductionSpecEditor } from "@/components/builder/production-spec-editor";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
import { resolveForm } from "@/lib/production-forms/resolve";
import { derivedEasyLoaderCodes } from "@/lib/production-forms/table-sections";
import { removeItem, reorderItems, setItemSerialNumber } from "@/lib/actions/documents";
import type { BuilderItem, CompatibleOption } from "@/lib/queries/documents";

function arrayMove<T>(list: T[], from: number, to: number): T[] {
  const copy = list.slice();
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved);
  return copy;
}

/**
 * The builder's item cards, reorderable when the document is a DRAFT.
 * `items` is the server's own `sortOrder asc` order (see
 * `getDocumentForBuilder`) — the single source of truth. Reordering is
 * optimistic via `useOptimistic`: a drag-drop or Up/Down click updates the
 * displayed order immediately, then `reorderItems` persists it. If the
 * action fails, `items` itself never changed, so the optimistic order
 * reverts automatically once the transition settles; we additionally toast
 * the error and force a `router.refresh()` so a client whose local item list
 * had actually gone stale (e.g. another tab already reordered/removed items)
 * re-syncs with the server instead of re-showing a rejected order.
 *
 * Two reorder affordances, both scoped to `!readOnly`:
 * - A grip handle, draggable onto another card to swap positions. It runs
 *   two implementations: native HTML5 drag & drop for the mouse (which
 *   supplies a real drag image via `setDragImage`), and Pointer Events for
 *   touch/pen, because mobile browsers never fire the HTML5 drag events at
 *   all. The pointer path hit-tests `document.elementFromPoint` in place of
 *   the `dragover`/`drop` it doesn't get.
 * - Up/Down icon buttons at `md`+ only. They are the keyboard/screen-reader
 *   affordance (the grip isn't keyboard-operable), and they used to be the
 *   touch fallback too — but on a phone they overflowed the header row, and
 *   the pointer drag above now covers touch, so they're hidden there.
 *
 * Each card is independently collapsible (owner: cards get huge once an
 * item has many options, and collapsed cards are easier to drag-reorder).
 * Collapse state lives in `collapsedByItemId`, a `Map<itemId, boolean>` kept
 * in this component (not per-card local state) so it survives reordering —
 * keyed by `item.id` rather than array index, a reorder never shuffles which
 * card is collapsed. Absent from the map means expanded (the default for a
 * newly added item). The header row (drag handle, name, code, options-count
 * chip, item total, up/down, remove, chevron) is always visible and — apart
 * from its own interactive controls, which stop propagation — clicking
 * anywhere on it toggles the card; the body (options editor, discount,
 * show-image toggle) collapses via a `grid-template-rows` transition so it
 * animates smoothly without knowing its own height up front.
 */
export function ItemsList({
  documentId,
  items,
  currency,
  compatibleOptionsByItemKey,
  showOptionIcons = true,
  screenSideImages,
  readOnly = false,
}: {
  documentId: string;
  items: BuilderItem[];
  currency: string;
  compatibleOptionsByItemKey: Record<string, CompatibleOption[]>;
  showOptionIcons?: boolean;
  /** `value -> imageUrl` for the "screenSide" `SpecImage` field — see
   * `ProductionSpecEditor`'s own doc comment on the prop of the same name.
   * Fetched once per page load (src/lib/queries/spec-images.ts) and passed
   * straight through to every item card, same as `showOptionIcons`. */
  screenSideImages: Record<string, string>;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [optimisticItems, setOptimisticItems] = useOptimistic(
    items,
    (_state: BuilderItem[], newOrder: BuilderItem[]) => newOrder
  );
  const [, startTransition] = useTransition();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const cardNodes = useRef(new Map<string, HTMLDivElement>());
  /** The in-flight touch/pen drag, or `null`. Mouse drags don't come through
   * here at all — they use the native HTML5 drag below, which gives a real
   * drag image for free. See `startPointerDrag`. */
  const pointerDrag = useRef<{ pointerId: number; itemId: string } | null>(null);
  const [collapsedByItemId, setCollapsedByItemId] = useState<Map<string, boolean>>(new Map());

  function isCollapsed(itemId: string) {
    return collapsedByItemId.get(itemId) ?? false;
  }

  function toggleCollapsed(itemId: string) {
    setCollapsedByItemId((prev) => {
      const next = new Map(prev);
      next.set(itemId, !(prev.get(itemId) ?? false));
      return next;
    });
  }

  function collapseAll() {
    setCollapsedByItemId(new Map(optimisticItems.map((item) => [item.id, true])));
  }

  function expandAll() {
    setCollapsedByItemId(new Map());
  }

  function commitOrder(newOrder: BuilderItem[]) {
    startTransition(async () => {
      setOptimisticItems(newOrder);
      const result = await reorderItems(
        documentId,
        newOrder.map((item) => item.id)
      );
      if (result?.error) {
        toast.error(result.error);
        router.refresh();
      }
    });
  }

  function moveBy(index: number, delta: number) {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= optimisticItems.length) return;
    commitOrder(arrayMove(optimisticItems, index, targetIndex));
  }

  // The offer to apply a screen side to the rest of the quote is noise on a
  // single-machine one, so it only appears once the document holds two or
  // more items a production form recognizes.
  const machineCount = optimisticItems.filter((item) => resolveForm(item.code) !== null).length;

  /** The id of the item card under a viewport point, or `null` when the
   * point is outside every card. Hit-testing the DOM is what stands in for
   * `dragover`/`drop` during a pointer drag: those fire only for the native
   * HTML5 drag, which touch browsers never start. */
  function itemIdAtPoint(clientX: number, clientY: number): string | null {
    const card = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-builder-item-id]");
    return card?.dataset.builderItemId ?? null;
  }

  function endPointerDrag(clientX: number, clientY: number) {
    const drag = pointerDrag.current;
    if (!drag) return;
    pointerDrag.current = null;
    const targetId = itemIdAtPoint(clientX, clientY);
    if (targetId) {
      handleDrop(targetId);
      return;
    }
    // Dropped on empty space — leave the order alone.
    setDraggingId(null);
    setDropTargetId(null);
  }

  function cancelPointerDrag() {
    pointerDrag.current = null;
    setDraggingId(null);
    setDropTargetId(null);
  }

  function handleDrop(targetId: string) {
    setDropTargetId(null);
    const sourceId = draggingId;
    setDraggingId(null);
    if (!sourceId || sourceId === targetId) return;
    const fromIndex = optimisticItems.findIndex((item) => item.id === sourceId);
    const toIndex = optimisticItems.findIndex((item) => item.id === targetId);
    if (fromIndex === -1 || toIndex === -1) return;
    commitOrder(arrayMove(optimisticItems, fromIndex, toIndex));
  }

  return (
    <div className="flex flex-col gap-3">
      {optimisticItems.length > 1 ? (
        <div className="flex justify-end gap-3 text-xs font-medium text-slate-500">
          <button
            type="button"
            onClick={collapseAll}
            className="focus-ring rounded transition-colors hover:text-brand"
          >
            Collapse all
          </button>
          <span aria-hidden="true" className="text-slate-300">
            |
          </span>
          <button
            type="button"
            onClick={expandAll}
            className="focus-ring rounded transition-colors hover:text-brand"
          >
            Expand all
          </button>
        </div>
      ) : null}

      {optimisticItems.map((item, index) => {
        const compatKey = item.productId ?? (item.seriesId ? `series:${item.seriesId}` : null);
        const isEasyLoader = resolveForm(item.code)?.id === "easyloader";
        const isDragging = draggingId === item.id;
        const isDropTarget = dropTargetId === item.id && draggingId !== item.id;
        const collapsed = isCollapsed(item.id);
        const optionCount = item.lines.filter((line) => line.kind === "OPTION").length;

        return (
          <div
            key={item.id}
            // Read back by `itemIdAtPoint` to hit-test a touch drag. A data
            // attribute rather than the `cardNodes` map because the lookup
            // starts from whatever element is under the finger and walks up.
            data-builder-item-id={item.id}
            ref={(node) => {
              if (node) cardNodes.current.set(item.id, node);
              else cardNodes.current.delete(item.id);
            }}
            onDragOver={(event) => {
              if (!draggingId) return;
              event.preventDefault();
              if (dropTargetId !== item.id) setDropTargetId(item.id);
            }}
            onDragLeave={() => {
              setDropTargetId((current) => (current === item.id ? null : current));
            }}
            onDrop={(event) => {
              event.preventDefault();
              handleDrop(item.id);
            }}
            className={cn(
              "rounded-xl border border-slate-200 p-3 transition-[opacity,box-shadow] duration-150 motion-reduce:transition-none sm:p-4",
              // A line the salesperson earns nothing on carries a faint amber
              // wash (owner's request). Deliberately barely-there: it is a
              // standing fact about the product, not a problem to fix, so it
              // must not read as a warning — but without it the only way to
              // discover a line pays no commission is to notice the figure at
              // the bottom failing to move.
              item.noCommission && "bg-amber-50/60",
              isDragging && "opacity-50",
              isDropTarget && "ring-2 ring-brand"
            )}
          >
            {/* Header: always visible, clicking anywhere on it (other than
                the drag/reorder controls and remove button, which stop
                propagation) toggles the card's collapsed state. The chevron
                button is the keyboard/screen-reader-accessible affordance —
                it carries no handler of its own and relies on its native
                click event bubbling up to this row. Reorder controls (up/down)
                are inline on the right with compact 36px visual / 44px hit area. */}
            <div
              onClick={() => toggleCollapsed(item.id)}
              className="flex cursor-pointer select-none flex-wrap items-start justify-between gap-x-2 gap-y-1 sm:flex-nowrap sm:gap-x-3"
            >
              {/* `flex-1` matters as much as `min-w-0` here: the controls to
                  the right are `shrink-0`, so without it a narrow row hands
                  them everything and collapses this column to zero width —
                  at which point its children paint straight over the price,
                  which is exactly what a phone used to render.
                  `basis-full` then takes it further below `sm`: even once it
                  stops overlapping, sharing one 327px line with the grip,
                  the thumbnail and ~170px of controls leaves the name about
                  35px — enough for "Co…". Wrapping the controls onto their
                  own line buys the title the whole width instead. */}
              <div className="flex min-w-0 basis-full items-start gap-2 sm:flex-1 sm:basis-auto">
                {!readOnly && (
                  <div
                    onClick={(event) => event.stopPropagation()}
                    className="flex shrink-0 items-center"
                  >
                    <button
                      type="button"
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", item.id);
                        const node = cardNodes.current.get(item.id);
                        if (node) event.dataTransfer.setDragImage(node, 20, 20);
                        setDraggingId(item.id);
                      }}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setDropTargetId(null);
                      }}
                      // Touch/pen path. Mobile browsers never fire the HTML5
                      // drag events above, so on a phone — where the up/down
                      // buttons are hidden — this is the only way to reorder.
                      // Mouse is left to the native drag, which supplies a
                      // drag image these handlers can't.
                      onPointerDown={(event) => {
                        if (event.pointerType === "mouse") return;
                        // Suppresses the scroll/long-press gesture that would
                        // otherwise steal the pointer mid-drag; `touch-none`
                        // below is the same guarantee at the CSS level, which
                        // is the one Safari actually honours.
                        event.preventDefault();
                        // Keeps `pointermove`/`pointerup` targeted at this
                        // handle once the finger leaves it, which is the
                        // entire drag. Not fatal if the browser refuses (the
                        // pointer can already be gone by the time this runs):
                        // the drag still starts, it just ends early if the
                        // finger slides off — far better than throwing here
                        // and never setting `draggingId` at all.
                        try {
                          event.currentTarget.setPointerCapture(event.pointerId);
                        } catch {
                          // Capture is an optimisation, not a precondition.
                        }
                        pointerDrag.current = { pointerId: event.pointerId, itemId: item.id };
                        setDraggingId(item.id);
                      }}
                      onPointerMove={(event) => {
                        const drag = pointerDrag.current;
                        if (drag?.pointerId !== event.pointerId) return;
                        const overId = itemIdAtPoint(event.clientX, event.clientY);
                        setDropTargetId(overId === drag.itemId ? null : overId);
                      }}
                      onPointerUp={(event) => {
                        if (pointerDrag.current?.pointerId !== event.pointerId) return;
                        endPointerDrag(event.clientX, event.clientY);
                      }}
                      onPointerCancel={(event) => {
                        if (pointerDrag.current?.pointerId !== event.pointerId) return;
                        cancelPointerDrag();
                      }}
                      aria-label={`Reorder ${item.name}`}
                      className="focus-ring flex size-11 cursor-grab touch-none items-center justify-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-600 active:cursor-grabbing"
                    >
                      <GripVertical className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                )}
                {item.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.imageUrl}
                    alt={item.name}
                    className="size-12 shrink-0 rounded-lg border border-slate-200 object-contain"
                  />
                ) : null}
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium text-brand-dark">{item.name}</span>
                    {/* Truncates for the same reason the name does: a code is
                        unbroken text, so without it a squeezed column lets it
                        spill out over whatever sits to its right. */}
                    <span className="truncate font-mono text-xs text-slate-500">{item.code}</span>
                  </div>
                  {optionCount > 0 ? (
                    <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                      {optionCount} option{optionCount === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </div>
              </div>
              {/* Below `sm` this sits on its own line under the title (the
                  title block is `basis-full` there), so it stretches to the
                  full width and keeps its controls right-aligned. */}
              <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-2 sm:w-auto">
                <span className="text-sm font-medium tabular-nums text-brand-dark sm:pt-2">
                  {formatMoney(item.total, currency)}
                </span>
                {!readOnly && (
                  <>
                    {/* md+ only. On a phone these two buttons plus the price,
                        remove and chevron overflow the row, and reordering
                        there is served by dragging the grip handle instead
                        (which works on touch — see its pointer handlers). */}
                    <div
                      onClick={(event) => event.stopPropagation()}
                      className="hidden items-center gap-2 md:flex"
                    >
                      <button
                        type="button"
                        onClick={() => moveBy(index, -1)}
                        disabled={index === 0}
                        aria-label={`Move ${item.name} up`}
                        className="focus-ring flex size-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-600 disabled:pointer-events-none disabled:opacity-30 -m-1 p-1"
                      >
                        <ChevronUp className="size-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveBy(index, 1)}
                        disabled={index === optimisticItems.length - 1}
                        aria-label={`Move ${item.name} down`}
                        className="focus-ring flex size-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-600 disabled:pointer-events-none disabled:opacity-30 -m-1 p-1"
                      >
                        <ChevronDown className="size-4" aria-hidden="true" />
                      </button>
                    </div>
                    <span onClick={(event) => event.stopPropagation()}>
                      <RemoveItemButton action={removeItem.bind(null, item.id)} itemName={item.name} />
                    </span>
                  </>
                )}
                <button
                  type="button"
                  aria-label={collapsed ? `Expand ${item.name}` : `Collapse ${item.name}`}
                  aria-expanded={!collapsed}
                  className="focus-ring flex size-11 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-600"
                >
                  <ChevronDown
                    className={cn(
                      "size-4 transition-transform duration-150 motion-reduce:transition-none",
                      collapsed && "-rotate-90"
                    )}
                    aria-hidden="true"
                  />
                </button>
              </div>
            </div>

            <div
              className={cn(
                "grid transition-[grid-template-rows] duration-150 ease-in-out motion-reduce:transition-none",
                collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
              )}
            >
              <div className="overflow-hidden">
                {/* Base price / options / item discount / per-item subtotal,
                    each price editable in place (pencil-on-hover-or-focus,
                    same reveal pattern as avatar-editor.tsx) — see
                    item-breakdown-editor.tsx for why this is the builder's
                    own copy of the layout rather than a reuse of the shared
                    (non-interactive) sheet presenter. Replaces what used to
                    be two separate blocks: a read-only compact breakdown
                    here, and a second list of `UnitPriceField` rows
                    repeating the same lines below it with a "Price" input
                    each. */}
                <div className="mb-3">
                  <ItemBreakdownEditor item={item} currency={currency} readOnly={readOnly} />
                </div>

                {item.isCredit ? (
                  <CreditItemSerialNumber
                    itemId={item.id}
                    serialNumber={item.serialNumber}
                    readOnly={readOnly}
                  />
                ) : null}

                {/* On an EasyLoader these two swap places. Its builder is
                    where the machine is assembled and priced, so it comes
                    first and opens itself; the options panel holds only the
                    accessories by then, and starts closed rather than
                    inviting a manager to pick modules the builder owns. */}
                <ProductionSpecEditor
                  itemId={item.id}
                  itemCode={item.code}
                  spec={(item.productionSpec ?? {}) as Record<string, unknown>}
                  hasOtherMachines={machineCount > 1}
                  screenSideImages={screenSideImages}
                  readOnly={readOnly}
                  defaultOpen={isEasyLoader && !readOnly}
                />

                <ItemOptionsEditor
                  itemId={item.id}
                  currentLines={item.lines
                    .filter((line) => line.kind === "OPTION")
                    .map((line) => ({ code: line.code, qty: line.qty, attributes: line.attributes }))}
                  compatibleOptions={compatKey ? (compatibleOptionsByItemKey[compatKey] ?? []) : []}
                  currency={currency}
                  showOptionIcons={showOptionIcons}
                  readOnly={readOnly}
                  lockedCodes={isEasyLoader ? derivedEasyLoaderCodes(item.code) : undefined}
                  startClosed={isEasyLoader}
                />

                {/* A credit item (item.isCredit — the TRADE-IN product) is
                    already a negative line; a discount on it is meaningless
                    and, entered by accident, silently wrong — so the control
                    doesn't exist for it at all, not merely disabled. See
                    `setItemDiscount`'s own guard for the server-side half of
                    this. */}
                {!item.isCredit || (!readOnly && item.productHasImage) ? (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
                    {!item.isCredit ? (
                      <ItemDiscountField
                        itemId={item.id}
                        discountMode={item.discountMode}
                        discountValue={item.discountValue}
                        maxDiscountPct={item.maxDiscountPct}
                        currency={currency}
                        readOnly={readOnly}
                      />
                    ) : null}
                    {!readOnly && item.productHasImage ? (
                      <ItemShowImageToggle itemId={item.id} showImage={item.showImage} />
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The one field a credit item (`item.isCredit` — the TRADE-IN catalogue
 * product, today) needs that no ordinary item exposes any builder affordance
 * for at all: the serial number of the machine being taken in trade
 * (`DocumentItem.serialNumber` — see its doc comment on `BuilderItem` and in
 * `getDocumentForBuilder`). Per-deal, and knowable only here.
 *
 * The trade-in *description* is deliberately not editable here. It is the
 * standing trade-in terms, the same text for every deal, and it belongs to
 * the catalogue product — `addItem` snapshots `Product.description` onto the
 * item like it does for every other product, and the sheets print it from
 * there (see `item-breakdown.tsx`). Editing it per quote meant the terms
 * could drift from the ones the owner maintains in Settings → Catalogue,
 * quote by quote, with no way to tell which quote said what.
 *
 * A plain onBlur-save text field, not the pencil-reveal pattern
 * `item-breakdown-editor.tsx` uses for prices — this isn't a number with a
 * list-price concession to show alongside, just one freeform fact, so an
 * always-editable field reads more honestly than a price-editor affordance.
 */
function CreditItemSerialNumber({
  itemId,
  serialNumber,
  readOnly,
}: {
  itemId: string;
  serialNumber: string | null;
  readOnly: boolean;
}) {
  const toast = useToast();
  const [serial, setSerial] = useState(serialNumber ?? "");
  const [, startTransition] = useTransition();

  function saveSerial() {
    if (serial === (serialNumber ?? "")) return;
    startTransition(async () => {
      const formData = new FormData();
      formData.set("serialNumber", serial);
      const result = await setItemSerialNumber(itemId, formData);
      if (result.error) toast.error(result.error);
    });
  }

  if (readOnly) {
    return (
      <div className="mt-3 border-t border-slate-100 pt-3 text-sm">
        <span className="font-medium text-slate-600">Serial number: </span>
        <span className="text-slate-700">{serialNumber || "—"}</span>
      </div>
    );
  }

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        Serial number (machine being traded in)
        <input
          type="text"
          value={serial}
          onChange={(e) => setSerial(e.target.value)}
          onBlur={saveSerial}
          placeholder="e.g. PF-2019-00412"
          className="focus-ring rounded-lg border border-slate-300 px-2 py-1.5 text-sm font-normal text-brand-dark outline-none focus-visible:border-brand"
        />
      </label>
    </div>
  );
}
