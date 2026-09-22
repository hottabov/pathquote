"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { pickDerivativeWidth } from "@/lib/image-derivative-width";
import { formatMoney } from "@/lib/format";
import { buildItemBreakdown } from "@/lib/sheet-data";
import { discountLabel } from "@/components/sheet/item-breakdown";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
import {
  resetItemUnitPrice,
  resetLineUnitPrice,
  setItemUnitPrice,
  setLineUnitPrice,
  type ActionResult,
} from "@/lib/actions/documents";
import type { BuilderItem } from "@/lib/queries/documents";

/**
 * The builder's own copy of the base/options/discount/subtotal layout
 * `src/components/sheet/item-breakdown.tsx` renders for the two print
 * sheets — deliberately NOT a reuse of that shared presenter. That file's
 * whole markup is posted to Gotenberg as a raw HTML string, so it must stay
 * free of `"use client"`, Tailwind, and event handlers; this component is
 * exactly the opposite of that (a client component whose entire reason to
 * exist is making every price in the list editable in place), so it's a
 * second, independent copy of the layout rather than a `variant` bolted onto
 * the first one. It reuses `buildItemBreakdown` (the pure money-shaping
 * function both copies are built from) and `discountLabel` (so the wording
 * never drifts) from that same module — importing a plain function into a
 * client component is fine; the constraint is only on JSX/hooks/handlers
 * living in the shared file itself.
 *
 * Replaces the old second block of `UnitPriceField` rows that used to sit
 * below the (then read-only) compact breakdown, repeating the same base/
 * option lines a second time with a "Price" input each — the owner's
 * complaint that it "duplicates a list that already exists" is exactly what
 * this fixes: one list, its own prices editable in place, not two lists.
 *
 * Each price is a plain figure until hovered or focused, at which point a
 * small pencil button appears at its top-right corner (same reveal pattern
 * as `src/components/users/avatar-editor.tsx`'s avatar overlay — copied
 * intentionally, see `EditablePrice` below). Clicking it swaps the figure
 * for a focused, fully-selected number input; blurring or Enter saves
 * through the same `setItemUnitPrice`/`setLineUnitPrice` server actions
 * `unit-price-field.tsx` used before it was deleted, and Escape cancels,
 * restoring the previous value without saving. A price that differs from its
 * snapshotted list price still shows that list price struck through beside it
 * with a "Reset to list" control, exactly as it did in the old two-block
 * layout.
 *
 * The four price actions are imported here and handed to `BreakdownRow` /
 * `EditablePrice` below as `setAction`/`resetAction` — those two are private
 * to this file and deliberately id-generic, because the identical row markup
 * serves both an item (`setItemUnitPrice`) and one of its option lines
 * (`setLineUnitPrice`). Which pair a row gets is the only difference between
 * the two cases, so it stays a parameter rather than becoming two near-copies
 * of the row.
 */
/** The icon box on a breakdown row, in CSS pixels -- what decides which
 * `?w=` derivative to ask for rather than shrinking a print-resolution
 * original with CSS. */
const ROW_ICON_BOX_PX = 20;

export function ItemBreakdownEditor({
  item,
  currency,
  currencySymbol,
  optionImageByRefId,
  showOptionIcons = true,
  readOnly = false,
}: {
  item: BuilderItem;
  currency: string;
  currencySymbol: string | null;
  /** `Option.id -> imageUrl`, for the catalogue icon on each option row. An
   * option line carries no image of its own (only a custom extra line
   * does), so the picture has to come from the compatible-options list the
   * card already holds. */
  optionImageByRefId?: Record<string, string | null>;
  /** The "ui.showOptionIcons" app setting, threaded down the same way the
   * options sheet gets it. */
  showOptionIcons?: boolean;
  readOnly?: boolean;
}) {
  // Always built with showOptionPrices=true — see buildItemBreakdown's own
  // doc comment: the builder is internal to the salesperson, who always
  // sees full pricing detail regardless of the document's customer-facing
  // display toggles. `breakdown.options` is `item.lines.map(...)`, in the
  // same order, so it's zipped 1:1 against `item.lines` below to recover
  // each option row's id/listPrice — `ItemBreakdown` itself carries neither
  // (it's shaped for the read-only sheets, which never need to save
  // anything back).
  const breakdown = buildItemBreakdown(item, true);

  return (
    // One grid for the whole block, not a stack of independent flex rows:
    // every row below renders as `display: contents` so their cells land in
    // these three shared columns (label / qty / price). Separate per-row
    // flexboxes each sized themselves, so the qty and price columns drifted
    // from line to line and the figures never lined up vertically. `auto` on
    // the two right columns means they're as wide as their widest row and no
    // wider, so the labels still get everything that's left.
    <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1.5 rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
      {/* Dropped for a product assembled from its own options (see
          `ItemBreakdown.assembledFromOptions`) — an EasyLoader, today. The
          row would read "$0" against a machine, and there is nothing here to
          edit either: the price lives entirely in the modules the EasyLoader
          builder writes, so a hand-typed base price would be money outside
          that model. A machine a salesperson hand-zeroed is a different
          thing and keeps both its row and its editor. */}
      {breakdown.assembledFromOptions ? null : (
        <BreakdownRow
          icon={showOptionIcons ? item.imageUrl : null}
          // Code only, no name: the card header two rows up already says
          // what this machine is called, and repeating it here made the
          // base row the widest thing in the list to say the least.
          label={item.code}
          qty={`Qty ${breakdown.qty}`}
          displayAmount={breakdown.basePrice}
          id={item.id}
          unitPrice={item.unitPrice}
          listPrice={item.listPrice}
          currency={currency}
          currencySymbol={currencySymbol}
          editable={!readOnly}
          setAction={setItemUnitPrice}
          resetAction={resetItemUnitPrice}
        />
      )}
      {breakdown.options.map((option, index) => {
        const line = item.lines[index];
        return (
          <BreakdownRow
            key={line.id}
            icon={
              showOptionIcons
                ? (line.refId ? (optionImageByRefId?.[line.refId] ?? null) : line.imageUrl)
                : null
            }
            code={line.code}
            label={option.name}
            qty={String(option.qty)}
            // Non-null in practice: `breakdown` above is always built with
            // `showOptionPrices=true` (see the doc comment on it), the only
            // condition under which `ItemBreakdown.options[].lineTotal` is
            // ever null — the `?? unitPrice` fallback exists purely to
            // satisfy that field's wider (nullable) type.
            displayAmount={option.lineTotal ?? line.unitPrice}
            id={line.id}
            unitPrice={line.unitPrice}
            listPrice={line.listPrice}
            currency={currency}
            currencySymbol={currencySymbol}
            editable={!readOnly}
            setAction={setLineUnitPrice}
            resetAction={resetLineUnitPrice}
          />
        );
      })}
      {breakdown.discount ? (
        <StaticRow
          label={discountLabel(breakdown.discount)}
          amount={`-${formatMoney(breakdown.discount.amount, currency, currencySymbol)}`}
          muted
        />
      ) : null}
      {breakdown.options.length > 0 ? (
        <StaticRow label={`${item.code} subtotal`} amount={formatMoney(breakdown.subtotal, currency, currencySymbol)} strong />
      ) : null}
    </div>
  );
}

/** A non-editable row — the discount and subtotal lines, which have no
 * price of their own to hand-edit (a discount is set via `ItemDiscountField`
 * elsewhere on the card; the subtotal is a pure computed figure). Same shape
 * as the old (now-deleted) `CompactRow` in item-breakdown.tsx. */
function StaticRow({
  label,
  amount,
  muted = false,
  strong = false,
}: {
  label: string;
  amount: string;
  muted?: boolean;
  strong?: boolean;
}) {
  return (
    // `contents` so the two cells sit in the parent's shared columns (see the
    // grid's own comment). The wrapper generates no box, but colour/weight/
    // style are inherited properties, so the modifiers below still reach the
    // cells. The label takes the label *and* qty columns — these rows have no
    // qty of their own — and the amount carries the same `pr-5` the editable
    // rows reserve for their pencil, so every figure in the block ends on one
    // line rather than the subtotal hanging 12px further right.
    <div
      className={cn(
        "contents",
        muted && "italic text-amber-700",
        strong && "font-semibold text-slate-700"
      )}
    >
      <span className="col-span-3 truncate">{label}</span>
      <span className="pr-5 text-right tabular-nums">{amount}</span>
    </div>
  );
}

/** The base price row or one option row — label/qty on the left, an
 * `EditablePrice` on the right. `displayAmount` is always the row's already
 * qty-extended figure (`basePrice`/`lineTotal` — qty is always 1 for the
 * base row, so it's moot there), matching what the sheets show for the same
 * row; see `EditablePrice`'s own doc comment for why editing itself still
 * operates on the raw per-unit price underneath that figure. */
function BreakdownRow({
  icon,
  code,
  label,
  qty,
  displayAmount,
  id,
  unitPrice,
  listPrice,
  currency,
  currencySymbol,
  editable,
  setAction,
  resetAction,
}: {
  /** The catalogue picture, or null for a row that has none -- a spacer
   * keeps the codes in one column either way. */
  icon?: string | null;
  code?: string | null;
  label: string;
  qty: string;
  displayAmount: string;
  id: string;
  unitPrice: string;
  listPrice: string | null;
  currency: string;
  currencySymbol: string | null;
  editable: boolean;
  setAction: (id: string, formData: FormData) => Promise<ActionResult>;
  resetAction: (id: string) => Promise<ActionResult>;
}) {
  return (
    // `contents` — the three cells belong to the block-level grid above, not
    // to a flexbox of this row's own; that's what keeps the qty and price
    // columns in line down the list. Both are right-aligned so the digits
    // stack (`tabular-nums` keeps them the same width while a price is being
    // edited elsewhere).
    <div className="contents">
      {icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={icon.endsWith(".svg") ? icon : `${icon}?w=${pickDerivativeWidth(ROW_ICON_BOX_PX * 2)}`}
          alt=""
          className="size-5 shrink-0 rounded object-contain"
        />
      ) : (
        <span className="size-5 shrink-0 rounded bg-slate-200/70" aria-hidden="true" />
      )}
      <span className="flex min-w-0 items-baseline gap-2">
        {code ? <span className="shrink-0 font-mono text-[11px] text-brand-dark">{code}</span> : null}
        <span className="truncate">{label}</span>
      </span>
      <span className="text-right tabular-nums text-slate-400">{qty}</span>
      <span className="flex items-center justify-end tabular-nums">
        <EditablePrice
          label={label}
          id={id}
          displayAmount={displayAmount}
          unitPrice={unitPrice}
          listPrice={listPrice}
          currency={currency}
          currencySymbol={currencySymbol}
          editable={editable}
          setAction={setAction}
          resetAction={resetAction}
        />
      </span>
    </div>
  );
}

/**
 * One hand-editable price — the unit shared by the item's own base price row
 * and every option row above. Three states:
 *
 * - Read-only (`editable=false`, a FINAL document): the plain figure, with
 *   the list price struck through beside it whenever it differs — no pencil,
 *   no reset, matching `unit-price-field.tsx`'s old `readOnly` branch (a
 *   past concession stays visible internally even though it never prints on
 *   a customer-facing sheet).
 * - Viewing (the default when editable): the plain figure, with the struck-
 *   through list price + "Reset to list" whenever there's a concession, and
 *   a pencil button. The pencil is always drawn, at 60% opacity, going to
 *   full on hover or focus. It used to be `opacity-0
 *   group-hover:opacity-100` after `avatar-editor.tsx`, which was not a
 *   styling choice with a touch caveat: on a tablet there is no hover, so
 *   the affordance did not exist and the price read as plain text.
 * - Editing (after the pencil is clicked): a focused, fully-selected number
 *   input. Blurring or Enter saves through `setAction` (only when the value
 *   actually changed) exactly like `unit-price-field.tsx`'s autosave did,
 *   just triggered by leaving the field rather than a typing debounce —
 *   there's no continuous "still typing" state to debounce once editing
 *   only opens on an explicit click. Escape restores `unitPrice` and closes
 *   without saving; `cancelledRef` suppresses the `onBlur`-triggered save
 *   Escape's own `setEditing(false)` may otherwise still fire (removing a
 *   focused input can dispatch a native blur as it unmounts).
 *
 * Editing always writes the row's raw per-unit `unitPrice` (what
 * `setAction`'s `unitPrice` form field expects, and what `unit-price-field.tsx`
 * always edited) — identical to `displayAmount` whenever qty is 1 (the base
 * row always; most option rows in practice), and simply the per-unit figure
 * for a qty > 1 option row, same as before this UI merge.
 */
function EditablePrice({
  label,
  id,
  displayAmount,
  unitPrice,
  listPrice,
  currency,
  currencySymbol,
  editable,
  setAction,
  resetAction,
}: {
  label: string;
  id: string;
  displayAmount: string;
  unitPrice: string;
  listPrice: string | null;
  currency: string;
  currencySymbol: string | null;
  editable: boolean;
  setAction: (id: string, formData: FormData) => Promise<ActionResult>;
  resetAction: (id: string) => Promise<ActionResult>;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(unitPrice);
  const [, startSave] = useTransition();
  const [resetting, startReset] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const hasConcession = listPrice !== null && Number(listPrice) !== Number(unitPrice);

  function openEditor() {
    setDraft(unitPrice);
    cancelledRef.current = false;
    setEditing(true);
  }

  function save() {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    setEditing(false);
    if (draft === unitPrice) return;
    startSave(async () => {
      const formData = new FormData();
      formData.set("unitPrice", draft);
      const result = await setAction(id, formData);
      if (result.error) toast.error(result.error);
      // A `warning` here means the save pushed the *document's* whole
      // concession over the region cap (ADMIN-only — a MANAGER's would
      // come back as `error` instead, handled above) — no longer toasted
      // per field. That state now lives in the Summary panel's persistent
      // badge plus a one-time transition toast; see
      // `ConcessionCapBadge`/`ConcessionCapToast` in `[documentId]/page.tsx`.
    });
  }

  function cancel() {
    cancelledRef.current = true;
    setDraft(unitPrice);
    setEditing(false);
  }

  function reset() {
    startReset(async () => {
      const result = await resetAction(id);
      if (result.error) toast.error(result.error);
      // See `save`'s own comment above -- a `warning` here is the same
      // document-level concession state, surfaced elsewhere.
    });
  }

  if (!editable) {
    return (
      <span className="inline-flex items-center gap-1.5">
        {hasConcession ? (
          <span className="text-slate-400 line-through">{formatMoney(listPrice!, currency, currencySymbol)}</span>
        ) : null}
        <span>{formatMoney(displayAmount, currency, currencySymbol)}</span>
      </span>
    );
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            inputRef.current?.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        aria-label={`${label} price`}
        className="h-7 w-20 rounded border border-slate-300 bg-white px-1.5 text-right text-xs tabular-nums text-brand-dark outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand"
      />
    );
  }

  return (
    // `pr-5` reserves the pencil's own width. It used to be `pr-3`, which
    // was enough while the pencil only appeared on hover; now that it is
    // always drawn it sat on the last digit of every price in the list.
    <span className="group relative inline-flex items-center gap-1.5 pr-5">
      {hasConcession ? (
        <>
          <span className="text-slate-400 line-through">{formatMoney(listPrice!, currency, currencySymbol)}</span>
          <button
            type="button"
            onClick={reset}
            disabled={resetting}
            className="focus-ring rounded text-[11px] font-medium text-brand hover:underline disabled:opacity-50"
          >
            Reset to list
          </button>
        </>
      ) : null}
      <span>{formatMoney(displayAmount, currency, currencySymbol)}</span>
      <button
        type="button"
        onClick={openEditor}
        aria-label={`Edit ${label} price`}
        className={cn(
          "focus-ring absolute top-1/2 right-0 flex size-5 -translate-y-1/2 items-center justify-center rounded-full bg-white text-slate-400 shadow-sm ring-1 ring-slate-200 transition-[opacity,color] duration-(--duration-micro) ease-out-soft motion-reduce:transition-none hover:text-brand",
          // Always there, faint until wanted. This used to be
          // `opacity-0 group-hover:opacity-100`, which on a tablet -- where
          // there is no hover -- meant the affordance did not exist at all:
          // the price simply looked like text. 60% is enough to read as a
          // control without competing with the figure it sits on.
          "opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
        )}
      >
        <Pencil className="size-3" aria-hidden="true" />
      </button>
    </span>
  );
}
