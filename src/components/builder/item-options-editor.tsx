"use client";

import { useState, useTransition } from "react";
import type { OptionRole } from "@prisma/client";
import { ChevronDown, Minus, Plus, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldInputClass } from "@/components/ui-kit";
import { formatMoney } from "@/lib/format";
import { formatMetres } from "@/lib/option-length";
import { isOptionDisabled } from "@/lib/catalog-compat";
import { cn } from "@/lib/utils";
import { setItemOptions } from "@/lib/actions/documents";
import { pickDerivativeWidth } from "@/lib/image-derivative-width";
import type { CompatibleOption } from "@/lib/queries/documents";
import type { OptionSelectionInput } from "@/lib/validation/documents";

// The panel draws each option's icon at 24 CSS px (`size-6`) — the same box
// the PDF's own `.pq-option-icon` fills (see DERIVATIVE_WIDTH_BY_CLASS in
// src/lib/pdf.ts, which picks a more generous 128 for print quality at
// 300dpi). Here a plain 2× retina derivative is enough, so this asks for
// the smallest width that covers that instead of the print-resolution
// original.
const OPTION_ICON_BOX_PX = 24;

type AttributeField = { key: string; label: string; type: "number" | "text" };

/**
 * Tolerates a malformed/absent `Option.attributeSchema` (admin-entered raw
 * JSON — see catalog.ts's `attributeSchemaSchema`): only entries that are
 * plain objects with a string `key`/`label` and a recognized `type` become
 * an input; anything else (not an array, wrong shape, unknown type) is
 * silently skipped rather than crashing the editor.
 */
function parseAttributeFields(schema: unknown): AttributeField[] {
  if (!Array.isArray(schema)) return [];
  const fields: AttributeField[] = [];
  for (const entry of schema) {
    if (!entry || typeof entry !== "object") continue;
    const { key, label, type } = entry as Record<string, unknown>;
    if (typeof key !== "string" || key.trim() === "") continue;
    if (typeof label !== "string" || label.trim() === "") continue;
    if (type !== "number" && type !== "text") continue;
    fields.push({ key, label, type });
  }
  return fields;
}

type CurrentLine = {
  /** The option's id (`DocumentLine.refId`) -- what the selection is keyed
   * by and what goes back to `setItemOptions`. `code` is the snapshot label
   * shown on the chip, nothing more. */
  refId: string | null;
  code: string | null;
  qty: number;
  attributes: Record<string, string | number> | null;
  /** `Option.role`, resolved live (see `BuilderLine.role`). */
  role: OptionRole | null;
};

type SelectionState = { qty: number; attributes: Record<string, string> };

/** Selection keyed by option id. A line with no `refId` has no catalogue
 * row to resubmit, so it is left out -- `save` could not send it anyway. */
function selectionsFromLines(lines: CurrentLine[]): Map<string, SelectionState> {
  const map = new Map<string, SelectionState>();
  for (const line of lines) {
    if (!line.refId) continue;
    const attributes: Record<string, string> = {};
    for (const [key, value] of Object.entries(line.attributes ?? {})) {
      attributes[key] = String(value);
    }
    map.set(line.refId, { qty: line.qty, attributes });
  }
  return map;
}

/**
 * Per-item options editor: a row of "code ×qty" chips summarizing the
 * item's current OPTION lines, plus an "Edit options" toggle that opens a
 * panel listing every option compatible with the item (series- and/or
 * product-level `OptionCompatibility` — preloaded via
 * `listCompatibleOptions`). Checking an option reveals its qty stepper and
 * (when it carries an `attributeSchema`) its attribute inputs; an unpriced
 * option is shown but its checkbox is disabled, and so is one that shares
 * an `OptionConflictGroup` with another option already checked in this
 * same panel — its reason names the specific option and group responsible
 * (see `isOptionDisabled`, src/lib/catalog-compat.ts). Deselecting the option
 * that caused the conflict re-enables the others on the very next render —
 * disabled-ness is derived fresh from `selected` on every render, not
 * tracked separately, so there's nothing to resync. "Save options" sends the
 * *entire* selection set to `setItemOptions`, which replaces the item's
 * OPTION lines as a whole (see actions/documents.ts) — there's no partial
 * add/remove here, and `setItemOptions` re-checks compatibility, pricing
 * *and* conflicts server-side rather than trusting this component.
 *
 * The panel also has a search box (client-side filter on code + name),
 * "Select all" / "Clear" buttons, and a "N of M selected" count badge.
 * "Select all" adds every currently-*filtered* and priced option to the
 * selection; "Clear" resets the whole selection (not just the filtered
 * subset) — a full reset is one click away regardless of search state.
 * Options are always rendered in their original catalog order (filtered by
 * search only) — selecting/deselecting never reorders the list. The panel
 * itself is one scrolling column capped at 70dvh with the Save/Cancel bar pinned
 * (`sticky bottom-0`) to its own bottom, so it stays reachable even when a
 * series has many options — including on a phone, the primary device this
 * builder targets.
 */
export function ItemOptionsEditor({
  itemId,
  currentLines,
  compatibleOptions,
  currency,
  showOptionIcons = true,
  readOnly = false,
  lockedRoles,
  startClosed = false,
}: {
  itemId: string;
  currentLines: CurrentLine[];
  compatibleOptions: CompatibleOption[];
  currency: string;
  /** Option roles this item's own builder owns, and that a manager must not
   * hand-edit here. Today that is the EasyLoader's table (`EL_MODULE_ROLES`):
   * its drive modules, lengths, busbar and rail are computed from the layout
   * drawn in the production-spec panel (see `deriveEasyLoaderOptions`), so a
   * quantity typed here would only survive until the next click of a section
   * stepper. They are shown, and their quantity is shown, but the controls
   * are inert -- and `save` re-submits them untouched, so opening this panel
   * and saving can never drop them. */
  lockedRoles?: ReadonlySet<OptionRole>;
  /** Keep the panel closed even for an item with no options yet. Set for an
   * EasyLoader: its modules come from the builder above, so an open list of
   * pickable options is an invitation to do the wrong thing -- what is left
   * in here is accessories, which are looked for deliberately. */
  startClosed?: boolean;
  /** "ui.showOptionIcons" app setting (see `getShowOptionIcons`,
   * src/lib/queries/settings.ts), read server-side and threaded down through
   * ItemsList/ItemsSection. Gates only the small per-option icon in this
   * editor's list — the summary chips on the item card stay text-only either
   * way. Defaults to `true` so a caller that forgets to pass it (e.g. a
   * future test) doesn't silently hide icons. */
  showOptionIcons?: boolean;
  readOnly?: boolean;
}) {
  // A machine is almost never sold bare, so an item that has no options yet
  // is one the salesperson is about to configure — the panel opens itself
  // rather than costing a click. An item that already has options stays
  // closed, so reopening a built-up quote isn't a wall of open editors.
  const [open, setOpen] = useState(currentLines.length === 0 && !readOnly && !startClosed);
  const [selected, setSelected] = useState<Map<string, SelectionState>>(() =>
    selectionsFromLines(currentLines)
  );
  const [search, setSearch] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const chips = currentLines.filter((line): line is CurrentLine & { code: string } => Boolean(line.code));

  // Selection state is keyed by option id (that is what `setItemOptions`
  // takes), so locking resolves an id back to its role through the two
  // lists that carry one: the compatible options and the lines already on
  // the item.
  const roleById = new Map<string, OptionRole | null>();
  for (const line of currentLines) if (line.refId) roleById.set(line.refId, line.role);
  for (const option of compatibleOptions) roleById.set(option.id, option.role);
  const isLocked = (id: string) => {
    const role = roleById.get(id);
    return role !== null && role !== undefined && (lockedRoles?.has(role) ?? false);
  };

  // Re-sync from the server-confirmed lines only at the moment the panel
  // opens — while it's open, the user's own edits are the source of truth
  // and shouldn't be clobbered by a stale prop from an unrelated re-render.
  function openPanel() {
    setSelected(selectionsFromLines(currentLines));
    setSearch("");
    setError(null);
    setOpen(true);
  }

  const query = search.trim().toLowerCase();
  const filteredOptions = query
    ? compatibleOptions.filter(
        (option) =>
          option.code.toLowerCase().includes(query) || option.name.toLowerCase().includes(query)
      )
    : compatibleOptions;

  // Always rendered in the original catalog order — no selected-first
  // sorting, so the list never reshuffles as the user checks/unchecks
  // options.
  const displayOptions = filteredOptions;

  function selectAllFiltered() {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const option of filteredOptions) {
        if (next.has(option.id) || isLocked(option.id)) continue;
        // Only the price reason applies here — conflicts aren't checked
        // against the batch being built up by this same click (that would
        // mean "select all" secretly picks a winner between two conflicting
        // options), so a resulting conflicting pair surfaces as the normal
        // save-time error instead, same as if the user had checked both by
        // hand.
        if (isOptionDisabled(option.price) !== null) continue;
        next.set(option.id, { qty: 1, attributes: {} });
      }
      return next;
    });
  }

  function clearAll() {
    setSelected((prev) => {
      const next = new Map<string, SelectionState>();
      // "Clear" means the manager's own picks, not the ones the builder
      // computed -- those come back on the next save anyway, so removing
      // them here would only flash them out and back.
      for (const [id, state] of prev) if (isLocked(id)) next.set(id, state);
      return next;
    });
  }

  function toggle(id: string) {
    if (isLocked(id)) return;
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, { qty: 1, attributes: {} });
      return next;
    });
  }

  function setQty(id: string, qty: number) {
    if (isLocked(id)) return;
    setSelected((prev) => {
      const current = prev.get(id);
      if (!current) return prev;
      const next = new Map(prev);
      next.set(id, { ...current, qty });
      return next;
    });
  }

  function setAttribute(id: string, key: string, value: string) {
    setSelected((prev) => {
      const current = prev.get(id);
      if (!current) return prev;
      const next = new Map(prev);
      next.set(id, { ...current, attributes: { ...current.attributes, [key]: value } });
      return next;
    });
  }

  function save() {
    setError(null);
    const selections: OptionSelectionInput[] = compatibleOptions
      .filter((option) => selected.has(option.id))
      .map((option) => {
        const state = selected.get(option.id)!;
        const fields = parseAttributeFields(option.attributeSchema);
        const attributes: Record<string, string | number> = {};
        for (const field of fields) {
          const raw = state.attributes[field.key];
          if (raw === undefined || raw === "") continue;
          if (field.type === "number") {
            const num = Number(raw);
            attributes[field.key] = Number.isFinite(num) ? num : raw;
          } else {
            attributes[field.key] = raw;
          }
        }
        return {
          optionId: option.id,
          qty: state.qty,
          attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
        };
      });

    startTransition(async () => {
      const result = await setItemOptions(itemId, selections);
      if (result?.error) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  }

  // No compatible options for this product at all — there's nothing to add
  // and nothing useful to say about that, so the whole block (heading,
  // toggle, empty state) is omitted rather than shown empty.
  if (compatibleOptions.length === 0) return null;

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((line, index) => (
          <span
            key={`${line.code}-${index}`}
            className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600"
          >
            {line.code} ×{line.qty}
          </span>
        ))}
        {chips.length === 0 && readOnly ? (
          <span className="text-xs text-slate-500">No options</span>
        ) : null}
      </div>

      {!readOnly && (
        <div className="mt-2">
          {/* A real secondary button, not a link-styled trigger — bordered,
              44px-tall tap target, full-width on mobile so it's easy to hit
              on the phone this builder primarily targets. The option count
              renders as a small badge, and the chevron rotates (plus the
              label swaps to "Close options") to reflect panel state. */}
          <button
            type="button"
            onClick={() => (open ? setOpen(false) : openPanel())}
            aria-expanded={open}
            className="focus-ring inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 transition-colors hover:border-brand/40 hover:bg-slate-50 active:bg-slate-100 sm:w-auto"
          >
            <SlidersHorizontal className="size-4 text-slate-500" aria-hidden="true" />
            <span>{open ? "Close options" : "Edit options"}</span>
            {chips.length > 0 ? (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-brand/10 px-1.5 py-0.5 text-xs font-semibold text-brand">
                {chips.length}
              </span>
            ) : null}
            <ChevronDown
              className={cn("size-4 text-slate-400 transition-transform", open && "rotate-180")}
              aria-hidden="true"
            />
          </button>
        </div>
      )}

      {open && !readOnly ? (
        <div className="mt-2 flex max-h-[70dvh] flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
          <div className="flex-1 overflow-y-auto p-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search options…"
                aria-label="Search options"
                className={cn(fieldInputClass, "h-11 min-w-[10rem] flex-1 sm:h-9")}
              />
              <Button type="button" variant="ghost" size="sm" onClick={selectAllFiltered}>
                Select all
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={clearAll}>
                Clear
              </Button>
              <span className="text-xs text-slate-500">
                {selected.size} of {compatibleOptions.length} selected
              </span>
            </div>

            {displayOptions.length === 0 ? (
                  <p className="mt-2 text-sm text-slate-500">No options match &ldquo;{search}&rdquo;.</p>
                ) : (
                  <div className="mt-2 flex flex-col gap-2">
                    {displayOptions.map((option) => {
                      const state = selected.get(option.id);
                      const checked = Boolean(state);
                      // Never treat an already-checked option as conflicting
                      // with itself: the options that get disabled are the
                      // *other* ones this one conflicts with, not this one.
                      // That's what lets the user immediately deselect the
                      // option that caused a conflict — its own checkbox
                      // stays clickable the whole time — instead of both
                      // sides of the pair locking each other out.
                      const conflictingWith = checked
                        ? null
                        : (option.conflictsWith.find((c) => selected.has(c.id)) ?? null);
                      const locked = isLocked(option.id);
                      const disabledReason = isOptionDisabled(option.price, conflictingWith);
                      const priced = disabledReason === null || disabledReason.type !== "unpriced";
                      const attributeFields = parseAttributeFields(option.attributeSchema);
                      const unitLength = option.unitLengthM;

                      return (
                        <div
                          key={option.id}
                          className="rounded-lg border border-slate-200 bg-white p-2.5"
                        >
                          <label className="flex min-h-12 items-start gap-2.5">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={locked || disabledReason !== null}
                              onChange={() => toggle(option.id)}
                              className="mt-0.5 size-5 shrink-0 rounded border-slate-300 accent-brand"
                            />
                            {showOptionIcons && option.imageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={
                                  option.imageUrl.endsWith(".svg")
                                    ? option.imageUrl
                                    : `${option.imageUrl}?w=${pickDerivativeWidth(OPTION_ICON_BOX_PX * 2)}`
                                }
                                alt=""
                                className="mt-0.5 size-6 shrink-0 rounded object-contain"
                              />
                            ) : null}
                            <span className="flex min-w-0 flex-1 flex-col justify-center">
                              <span className="flex flex-wrap items-baseline gap-2">
                                <span className="font-mono text-xs text-brand-dark">{option.code}</span>
                                <span className="text-sm text-slate-700">{option.name}</span>
                              </span>
                              {disabledReason?.type === "conflict" ? (
                                <span className="mt-0.5 w-fit rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">
                                  Conflicts with {disabledReason.conflictingOptionCode} —{" "}
                                  {disabledReason.conflictingGroupName}
                                </span>
                              ) : priced ? (
                                <span className="text-xs text-slate-500">
                                  {formatMoney(option.price!.amount, currency)}
                                </span>
                              ) : (
                                <span className="mt-0.5 w-fit rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                                  price required
                                </span>
                              )}
                            </span>
                          </label>

                          {checked && locked ? (
                            <div className="mt-2 pl-[1.875rem] text-xs text-slate-500">
                              Qty {state!.qty} — set by the table layout above
                            </div>
                          ) : null}

                          {checked && !locked ? (
                            <div className="mt-2 flex flex-wrap items-center gap-3 pl-[1.875rem]">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs text-slate-500">Qty</span>
                                {/* Visual stepper stays a compact 36px square (dense per-option
                                    row); the real tap target is the full 44px button around it —
                                    an invisible hit-area expansion, same idea as the toast close
                                    button's negative-margin trick elsewhere in this codebase. */}
                                <button
                                  type="button"
                                  aria-label={`Decrease ${option.name} quantity`}
                                  disabled={state!.qty <= 1}
                                  onClick={() => setQty(option.id, Math.max(1, state!.qty - 1))}
                                  className="group focus-ring flex size-11 shrink-0 items-center justify-center rounded-lg disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  <span
                                    aria-hidden="true"
                                    className="flex size-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition-colors md:group-hover:bg-slate-50"
                                  >
                                    <Minus className="size-3.5" />
                                  </span>
                                </button>
                                {/* Wrapping <label> (native click-forwarding to the nested
                                    control, no JS needed) expands the tap target to 44px tall
                                    without growing the visible 36px input box. */}
                                <label className="flex size-11 shrink-0 items-center justify-center">
                                  <input
                                    type="number"
                                    inputMode="numeric"
                                    min={1}
                                    max={999}
                                    aria-label={`${option.name} quantity`}
                                    value={state!.qty}
                                    onChange={(e) =>
                                      setQty(option.id, Math.max(1, Number(e.target.value) || 1))
                                    }
                                    className={cn(fieldInputClass, "h-9 w-14 text-center")}
                                  />
                                </label>
                                <button
                                  type="button"
                                  aria-label={`Increase ${option.name} quantity`}
                                  onClick={() => setQty(option.id, Math.min(999, state!.qty + 1))}
                                  className="group focus-ring flex size-11 shrink-0 items-center justify-center rounded-lg"
                                >
                                  <span
                                    aria-hidden="true"
                                    className="flex size-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition-colors md:group-hover:bg-slate-50"
                                  >
                                    <Plus className="size-3.5" />
                                  </span>
                                </button>
                                {/* An option sold by the section (the
                                    EasyLoader's 1.2 m lengths -- see
                                    `Option.unitLengthM`) is really a
                                    length: four sections is 4.8 m of table,
                                    and that is the figure the customer
                                    asks about. See src/lib/option-length.ts. */}
                                {unitLength !== null ? (
                                  <span className="text-xs font-medium text-slate-600 tabular-nums">
                                    = {formatMetres(unitLength * state!.qty)}
                                  </span>
                                ) : null}
                              </div>
                              {attributeFields.map((field) => (
                                <label
                                  key={field.key}
                                  className="flex items-center gap-2 text-xs text-slate-500"
                                >
                                  {field.label}
                                  <input
                                    type={field.type === "number" ? "number" : "text"}
                                    inputMode={field.type === "number" ? "decimal" : undefined}
                                    value={state!.attributes[field.key] ?? ""}
                                    onChange={(e) => setAttribute(option.id, field.key, e.target.value)}
                                    className={cn(fieldInputClass, "h-11 w-28 sm:h-9")}
                                  />
                                </label>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
          </div>

          <div className="sticky bottom-0 flex flex-col gap-2 border-t border-slate-200 bg-white p-3">
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <Button type="button" onClick={save} disabled={pending} className="h-10 bg-brand text-white hover:bg-brand/90">
                {pending ? "Saving…" : "Save options"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={pending}
                className="h-10"
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
