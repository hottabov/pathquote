"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  GripVertical,
} from "lucide-react";
import { formatMoney } from "@/lib/format";
import { ItemOptionsEditor } from "@/components/builder/item-options-editor";
import { ItemActionBar } from "@/components/builder/item-action-bar";
import { ItemBreakdownEditor } from "@/components/builder/item-breakdown-editor";
import { ProductionSpecEditor } from "@/components/builder/production-spec-editor";
import { ItemTabs, type ItemTab } from "@/components/builder/item-tabs";
import { useItemReorder } from "@/components/builder/use-item-reorder";
import { Chip, CountBadge, StatusBadge } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
import { formHasScreenSide } from "@/lib/production-forms/resolve";
import { itemMissing } from "@/lib/production-forms/readiness";
import { assignRails, type RailSource } from "@/lib/production-forms/rails";
import { EL_MODULE_ROLES } from "@/lib/production-forms/table-sections";
import type { OptionRole } from "@prisma/client";
import { readProductSpecs } from "@/lib/validation/product-specs";
import { reorderItems, setItemSerialNumber } from "@/lib/actions/documents";
import { pickDerivativeWidth } from "@/lib/image-derivative-width";
import type { BuilderItem, CompatibleOption } from "@/lib/queries/documents";

// The card header draws the item's product photo at 48 CSS px (`size-12`) —
// a print-resolution snapshot (often ~1MB) has no business loading here just
// to be shrunk by CSS, so it asks for the `?w=` thumbnail derivative instead
// (src/lib/image-derivatives.ts), same as CatalogThumb.
const ITEM_THUMB_BOX_PX = 48;

/**
 * Option roles no manager picks by hand, on any item: the per-metre MTS
 * travel rail, whose quantity comes from the length typed against the MTS
 * itself (see `mtsTravelMetres`). Shown with its quantity, and inert -- a
 * number typed here would be recomputed by the server on the next save.
 */
const DERIVED_ROLES: ReadonlySet<OptionRole> = new Set<OptionRole>(["MTS_TRAVEL"]);

/** The same, plus the EasyLoader's table modules, which its builder owns. */
const EASYLOADER_LOCKED_ROLES: ReadonlySet<OptionRole> = new Set<OptionRole>([
  ...EL_MODULE_ROLES,
  ...DERIVED_ROLES,
]);

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
  currencySymbol,
  compatibleOptionsByItemKey,
  showOptionIcons = true,
  screenSideImages,
  heading,
  readOnly = false,
}: {
  documentId: string;
  items: BuilderItem[];
  currency: string;
  currencySymbol: string | null;
  compatibleOptionsByItemKey: Record<string, CompatibleOption[]>;
  showOptionIcons?: boolean;
  /** `value -> imageUrl` for the "screenSide" `SpecImage` field — see
   * `ProductionSpecEditor`'s own doc comment on the prop of the same name.
   * Fetched once per page load (src/lib/queries/spec-images.ts) and passed
   * straight through to every item card, same as `showOptionIcons`. */
  screenSideImages: Record<string, string>;
  /** The section's own heading, rendered by the caller and passed in so that
   *  it can share a row with the collapse control, which reads this
   *  component's state and so cannot be lifted above it. */
  heading?: React.ReactNode;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [optimisticItems, setOptimisticItems] = useOptimistic(
    items,
    (_state: BuilderItem[], newOrder: BuilderItem[]) => newOrder
  );
  const [, startTransition] = useTransition();
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

  // Drives the single Collapse/Expand control's label, icon and aria-expanded.
  // "Any" rather than "all" so the control always does the thing the list is
  // not already doing.
  const anyExpanded = optimisticItems.some((item) => !isCollapsed(item.id));

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

  // Mouse drag, touch drag and keyboard, one state machine -- see
  // use-item-reorder.ts for why the keyboard path could not simply sit
  // beside the other two.
  const reorder = useItemReorder({ items: optimisticItems, commitOrder });
  const reorderHintId = `${documentId}-reorder-hint`;

  // The offer to apply a screen side to the rest of the quote is noise on a
  // single-machine one, so it only appears once the document holds two or
  // more items a production form recognizes.
  const machineCount = optimisticItems.filter((item) => formHasScreenSide(item.form)).length;

  // Rail length for the FabricPro cards, read off the EasyLoader cards in the
  // same quote -- the rails bolt to the table, not to the FabricPro, so the
  // number is already known the moment a table is drawn "FabricPro
  // compatible" (see src/lib/production-forms/rails.ts). One machine runs
  // over one table, so this is a pairing in card order rather than a total:
  // two tables and two FabricPros are two lengths, not one doubled one. The
  // same function decides what the printed forms say, so the card and the
  // sheet can never disagree. Computed from `optimisticItems` so ticking
  // "FabricPro compatible" updates the FabricPro card in the same render
  // rather than after a round trip.
  const railsByItemId = assignRails(
    optimisticItems
      .filter((item) => item.form === "EASYLOADER")
      .map((item) => ({
        id: item.id,
        code: item.code,
        ...((item.productionSpec ?? {}) as RailSource),
      })),
    optimisticItems.filter((item) => item.form === "FABRICPRO").map((item) => item.id)
  );

  return (
    <div className="flex flex-col gap-4">
      {/* A reorder is invisible to a screen reader otherwise: focus stays on
          the same grip and that grip's label never changes. */}
      <p aria-live="polite" className="sr-only">
        {reorder.announcement}
      </p>
      <p id={reorderHintId} className="sr-only">
        Press Space to pick this item up, the arrow keys to move it, Space again to drop it, and
        Escape to put it back.
      </p>
      {/* Heading and collapse control on one row. They were two stacked rows,
          which put a whole line of whitespace between the section's title and
          its first machine for no reason. */}
      <div className="flex min-h-9 items-center gap-2 px-1">
        {heading}
        {optimisticItems.length > 1 ? (
          // One control that flips, rather than two text buttons separated by
          // a literal "|": only one of the two is ever the useful one, and
          // which one that is can be read off the list.
          <button
            type="button"
            aria-expanded={anyExpanded}
            onClick={() => (anyExpanded ? collapseAll() : expandAll())}
            className="focus-ring ml-auto inline-flex h-9 items-center gap-1.5 rounded-(--radius-control) px-2.5 text-sm font-medium text-slate-600 transition-colors duration-(--duration-micro) motion-reduce:transition-none md:hover:bg-slate-100 md:hover:text-brand-dark"
          >
            {anyExpanded ? (
              <ChevronsDownUp className="size-4" aria-hidden="true" />
            ) : (
              <ChevronsUpDown className="size-4" aria-hidden="true" />
            )}
            {anyExpanded ? "Collapse all" : "Expand all"}
          </button>
        ) : null}
      </div>

      {optimisticItems.map((item, index) => {
        const compatKey = item.productId ?? (item.seriesId ? `series:${item.seriesId}` : null);
        const isEasyLoader = item.form === "EASYLOADER";
        const isDragging = reorder.draggingId === item.id;
        const isDropTarget =
          reorder.dropTargetId === item.id && reorder.draggingId !== item.id;
        const grabbed = reorder.grabbedId === item.id;
        const collapsed = isCollapsed(item.id);
        const optionCount = item.lines.filter((line) => line.kind === "OPTION").length;
        const compatibleOptions = compatKey ? (compatibleOptionsByItemKey[compatKey] ?? []) : [];
        const panelId = `item-panel-${item.id}`;
        // The same per-item check finalizeDocument enforces, so the badge on
        // the card and the refusal at finalize can never disagree.
        const missingSpec = itemMissing({
          code: item.code,
          form: item.form,
          productionSpec: item.productionSpec,
          options: item.lines
            .filter((line) => line.kind === "OPTION")
            .map((line) => ({ role: line.role, attributes: line.attributes })),
        });

        return (
          <div
            key={item.id}
            // Read back by `itemIdAtPoint` to hit-test a touch drag. A data
            // attribute rather than the `cardNodes` map because the lookup
            // starts from whatever element is under the finger and walks up.
            data-builder-item-id={item.id}
            ref={reorder.registerCard(item.id)}
            {...reorder.cardProps(item.id)}
            className={cn(
              "rounded-(--radius-card) border border-line bg-white p-3 transition-[opacity,box-shadow,border-color] duration-(--duration-micro) motion-reduce:transition-none sm:p-4",
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
            {/* The header is a real button now, not a div with an onClick.
                It was operable by keyboard only because the chevron's native
                click bubbled up to the div, which is a coincidence rather
                than a design: the row announced nothing, took no focus and
                answered no key. Making it a button means the grip, the
                reorder arrows and remove all have to sit OUTSIDE it, since a
                button cannot contain buttons, which is also why the old
                version needed a stopPropagation on each of them. */}
            <div className="flex items-start gap-1">
              {!readOnly && (
                <div className="flex shrink-0 items-center pt-1">
                <button
                  type="button"
                  {...reorder.handleProps(item, index)}
                  aria-label={`Reorder ${item.name}`}
                  aria-describedby={reorderHintId}
                  className={cn(
                    "focus-ring flex size-11 cursor-grab touch-none items-center justify-center rounded-lg text-slate-400 transition-colors duration-(--duration-micro) ease-out-soft motion-reduce:transition-none hover:bg-slate-50 hover:text-slate-600 active:cursor-grabbing",
                    // Picked up by the keyboard: the handle has to look
                    // different from every other handle on the page, or
                    // "which one am I carrying" is unanswerable.
                    grabbed && "bg-brand/10 text-brand ring-2 ring-brand"
                  )}
                >
                  <GripVertical className="size-4" aria-hidden="true" />
                </button>
                </div>
              )}

              <button
                type="button"
                aria-expanded={!collapsed}
                aria-controls={panelId}
                onClick={() => toggleCollapsed(item.id)}
                className="focus-ring flex min-w-0 flex-1 items-center gap-3 rounded-(--radius-control) p-1.5 text-left transition-colors duration-(--duration-micro) motion-reduce:transition-none md:hover:bg-slate-50"
              >
                {item.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={
                      item.imageUrl.endsWith(".svg")
                        ? item.imageUrl
                        : `${item.imageUrl}?w=${pickDerivativeWidth(ITEM_THUMB_BOX_PX * 2)}`
                    }
                    alt=""
                    // Hidden on a phone. The row has to hold a grip, a
                    // name, a price, two reorder arrows and a chevron in
                    // 390px, and a 48px photo is the one thing on it that
                    // does not say which machine this is any better than
                    // the name does.
                    className="hidden size-12 shrink-0 rounded-(--radius-control) border border-line object-contain sm:block"
                  />
                ) : null}

                <span className="min-w-0 flex-1">
                  {/* An h3 at last: the whole items list was one flat h2
                      region, so a screen reader had no outline to move
                      through and every machine was an unlabelled blob. */}
                  <h3 className="truncate text-sm font-semibold text-brand-dark">{item.name}</h3>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs text-slate-500">{item.code}</span>
                    {/* On a phone the price moves down here rather than
                        taking a column of its own: with the grip, the two
                        reorder arrows and the chevron all on the same row,
                        a column for it left the machine's name about eight
                        characters wide. */}
                    <span className="text-xs font-semibold tabular-nums text-brand-dark sm:hidden">
                      {formatMoney(item.total, currency, currencySymbol)}
                    </span>
                    {optionCount > 0 ? (
                      <Chip>
                        {optionCount} option{optionCount === 1 ? "" : "s"}
                      </Chip>
                    ) : null}
                    {/* What is wrong with this machine, on the collapsed row.
                        Before this the only way to find an incomplete
                        production spec was to open every card in turn, or to
                        press Finalize and be told. */}
                    {missingSpec.length > 0 ? (
                      <StatusBadge tone="amber" className="gap-1">
                        <CircleAlert className="size-3" aria-hidden="true" />
                        Spec: {missingSpec.length} missing
                      </StatusBadge>
                    ) : null}
                    {/* The amber wash below says this too, but colour alone
                        is not a signal: this is the text half of it. */}
                    {item.noCommission ? <StatusBadge tone="slate">No commission</StatusBadge> : null}
                  </span>
                </span>

                <span className="hidden shrink-0 text-sm font-semibold tabular-nums text-brand-dark sm:block">
                  {formatMoney(item.total, currency, currencySymbol)}
                </span>

                <ChevronDown
                  className={cn(
                    "size-4 shrink-0 text-slate-400 transition-transform duration-(--duration-ui) ease-(--ease-move) motion-reduce:transition-none",
                    collapsed && "-rotate-90"
                  )}
                  aria-hidden="true"
                />
              </button>

              {!readOnly && (
                <div className="flex shrink-0 items-center gap-1 pt-1">
                  {/* Not md+ only any more. These were the keyboard's only
                      way to reorder and they were hidden below 768px, so on
                      a phone a keyboard user could not reorder at all. The
                      grip now answers the keyboard too, but these stay
                      visible everywhere: they are the discoverable path,
                      and the grip is not. */}
                  <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => reorder.moveBy(index, -1)}
                        disabled={index === 0}
                        aria-label={`Move ${item.name} up`}
                        className="focus-ring flex size-8 items-center justify-center rounded-lg text-slate-400 transition-colors duration-(--duration-micro) ease-out-soft motion-reduce:transition-none hover:bg-slate-50 hover:text-slate-600 disabled:pointer-events-none disabled:opacity-30 sm:size-9"
                      >
                        <ChevronUp className="size-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => reorder.moveBy(index, 1)}
                        disabled={index === optimisticItems.length - 1}
                        aria-label={`Move ${item.name} down`}
                        className="focus-ring flex size-8 items-center justify-center rounded-lg text-slate-400 transition-colors duration-(--duration-micro) ease-out-soft motion-reduce:transition-none hover:bg-slate-50 hover:text-slate-600 disabled:pointer-events-none disabled:opacity-30 sm:size-9"
                      >
                        <ChevronDown className="size-4" aria-hidden="true" />
                      </button>
                                      </div>
                </div>
              )}
            </div>

            <div
              id={panelId}
              className={cn(
                "grid transition-[grid-template-rows] duration-(--duration-ui) ease-(--ease-move) motion-reduce:transition-none",
                collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
              )}
            >
              <div className="overflow-hidden">
                {/* One panel at a time. Each machine used to stack a
                    breakdown that was always open, a production-spec
                    disclosure and an options disclosure whose trigger
                    buttons were byte-identical apart from their label --
                    so opening a machine meant choosing between two
                    identical buttons, and a machine with both open was
                    taller than the screen. */}
                <div className="mt-3 border-t border-divider pt-3">
                  {item.isCredit ? (
                    <CreditItemSerialNumber
                      itemId={item.id}
                      serialNumber={item.serialNumber}
                      readOnly={readOnly}
                    />
                  ) : null}

                  <ItemTabs
                    // An EasyLoader opens on Spec because Spec is where an
                    // EasyLoader is *built*: the machine itself costs
                    // nothing and the table drawn there is what puts money
                    // on the line. Every other machine opens on Options,
                    // which is the job.
                    defaultTab={isEasyLoader ? "spec" : "options"}
                    tabs={([
                      compatibleOptions.length > 0
                        ? {
                            key: "options",
                            label: "Options",
                            badge:
                              optionCount > 0 ? <CountBadge>{optionCount}</CountBadge> : null,
                            content: (
                              <ItemOptionsEditor
                                itemId={item.id}
                                itemName={item.name}
                                itemCode={item.code}
                                currentLines={item.lines
                                  .filter((line) => line.kind === "OPTION")
                                  .map((line) => ({
                                    refId: line.refId,
                                    code: line.code,
                                    qty: line.qty,
                                    attributes: line.attributes,
                                    role: line.role,
                                  }))}
                                compatibleOptions={compatibleOptions}
                                currency={currency}
                                currencySymbol={currencySymbol}
                                showOptionIcons={showOptionIcons}
                                readOnly={readOnly}
                                lockedRoles={
                                  isEasyLoader ? EASYLOADER_LOCKED_ROLES : DERIVED_ROLES
                                }
                              />
                            ),
                          }
                        : null,
                      item.form
                        ? {
                            key: "spec",
                            label: isEasyLoader ? "Builder" : "Spec",
                            badge:
                              missingSpec.length > 0 ? (
                                <StatusBadge tone="amber">{missingSpec.length}</StatusBadge>
                              ) : null,
                            content: (
                              <ProductionSpecEditor
                                itemId={item.id}
                                form={item.form}
                                productSpecs={readProductSpecs(item.specs)}
                                spec={(item.productionSpec ?? {}) as Record<string, unknown>}
                                hasOtherMachines={machineCount > 1}
                                derivedRailLengthM={railsByItemId.get(item.id)?.lengthM ?? null}
                                rollFeedQty={item.lines
                                  .filter(
                                    (line) =>
                                      line.kind === "OPTION" && line.role === "EL_ROLL_FEED"
                                  )
                                  .reduce((sum, line) => sum + line.qty, 0)}
                                screenSideImages={screenSideImages}
                                readOnly={readOnly}
                                asPanel
                              />
                            ),
                          }
                        : null,
                      {
                        key: "price",
                        label: "Price",
                        content: (
                          <ItemBreakdownEditor
                            item={item}
                            currency={currency}
                            currencySymbol={currencySymbol}
                            readOnly={readOnly}
                          />
                        ),
                      },
                    ] satisfies (ItemTab | null)[]).filter((tab) => tab !== null)}
                  />

                  {/* Global to the machine, so it sits under the strip
                      rather than inside one of the tabs. A tab holds what
                      its label names, and neither a discount nor a delete
                      is a price or a spec. */}
                  <ItemActionBar
                    itemId={item.id}
                    itemName={item.name}
                    isCredit={item.isCredit}
                    productHasImage={item.productHasImage}
                    showImage={item.showImage}
                    discountMode={item.discountMode}
                    discountValue={item.discountValue}
                    currency={currency}
                    currencySymbol={currencySymbol}
                    readOnly={readOnly}
                  />
                </div>
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
