"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { OptionRole } from "@prisma/client";
import { ChevronRight, Minus, Plus, SearchX, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, fieldInputClass } from "@/components/ui-kit";
import { formatMoney } from "@/lib/format";
import { formatMetres } from "@/lib/option-length";
import {
  MTS_INCLUDED_M,
  MTS_METRES_FIELD,
  MTS_METRES_KEY,
  MTS_METRES_REQUIRED,
  mtsMetresValid,
  mtsTravelMetres,
} from "@/lib/production-forms/mts";
import { isOptionDisabled } from "@/lib/catalog-compat";
import {
  selectionsFromLines,
  withDerivedSelections,
  type SelectionLine,
  type SelectionState,
} from "@/lib/option-selections";
import { cn } from "@/lib/utils";
import { useAutosave } from "@/lib/use-autosave";
import { AutosaveIndicator } from "@/components/builder/autosave-indicator";
import { SideSheet } from "@/components/builder/side-sheet";
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

/**
 * The inputs an option row shows: whatever its catalogue schema declares,
 * plus the MTS travel length, which is a property of an MTS rather than an
 * admin's configuration of one (see `MTS_METRES_FIELD`). Appended rather
 * than substituted, and skipped when the schema already declares the same
 * key, so an admin who adds it by hand does not get the field twice.
 */
function attributeFieldsFor(schema: unknown, role: OptionRole | null): AttributeField[] {
  const fields = parseAttributeFields(schema);
  if (role !== "MTS" || fields.some((field) => field.key === MTS_METRES_KEY)) return fields;
  return [...fields, { ...MTS_METRES_FIELD }];
}

type CurrentLine = SelectionLine & {
  /** The snapshot label shown on the chip, nothing more. */
  code: string | null;
};

/**
 * Per-item options editor: an "Edit options" button that opens a side sheet
 * listing every option compatible with the item (series- and/or
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
/**
 * The MTS row's one control: how far the system has to travel.
 *
 * An MTS is a single rail of whatever length, so there is no quantity to
 * pick -- the length is the whole specification, and the price follows from
 * it. The line under the field says what that comes to, because the
 * per-metre rail is added by the server on save (`withDerivedMtsTravel`) and
 * without it the total would move for a reason nothing on screen explains.
 */
function MtsLengthField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const metres = value === "" ? undefined : Number(value);
  const extra = mtsTravelMetres(metres);
  // Required: an MTS is not an answer without its travel distance.
  const invalid = !mtsMetresValid({ [MTS_METRES_KEY]: value });

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex items-center gap-2 text-xs text-slate-500">
        {MTS_METRES_FIELD.label}
        <span className="text-destructive" aria-hidden="true">
          *
        </span>
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={0.1}
          step="0.1"
          required
          aria-invalid={invalid}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(fieldInputClass, "h-11 w-24 sm:h-9", invalid && "border-destructive")}
        />
      </label>
      <p className={cn("text-xs", invalid ? "text-destructive" : "text-slate-500")}>
        {invalid
          ? `${MTS_METRES_REQUIRED} — required.`
          : extra === 0
          ? `Up to ${MTS_INCLUDED_M} m is included in the MTS price.`
          : `${MTS_INCLUDED_M} m included — ${extra} m of MTS-M added automatically.`}
      </p>
    </div>
  );
}

/**
 * The item's whole option set in the shape `setItemOptions` takes. That action
 * replaces every option on the item in one call, so there is never a partial
 * update to assemble: whatever is selected on screen is what gets sent.
 */
function buildSelections(
  compatibleOptions: CompatibleOption[],
  effective: Map<string, SelectionState>
): OptionSelectionInput[] {
  return compatibleOptions
    .filter((option) => effective.has(option.id))
    .map((option) => {
      const state = effective.get(option.id)!;
      const fields = attributeFieldsFor(option.attributeSchema, option.role);
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
        // One MTS, whatever its length: the length is the attribute and the
        // extra metres are their own line. The server forces this too; it is
        // here so the number sent matches the row on screen, which offers no
        // quantity at all.
        qty: option.role === "MTS" ? 1 : state.qty,
        attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
      };
    });
}

export function ItemOptionsEditor({
  itemId,
  itemName,
  itemCode,
  currentLines,
  compatibleOptions,
  currency,
  currencySymbol,
  showOptionIcons = true,
  readOnly = false,
  lockedRoles,
}: {
  itemId: string;
  /** Titles the sheet. Once the options live in a panel of their own rather
   * than under the card that names the machine, the sheet has to say which
   * machine it is configuring. */
  itemName: string;
  itemCode: string | null;
  currentLines: CurrentLine[];
  compatibleOptions: CompatibleOption[];
  currency: string;
  currencySymbol: string | null;
  /** Option roles this item's own builder owns, and that a manager must not
   * hand-edit here. Today that is the EasyLoader's table (`EL_MODULE_ROLES`):
   * its drive modules, lengths, busbar and rail are computed from the layout
   * drawn in the production-spec panel (see `deriveEasyLoaderOptions`), so a
   * quantity typed here would only survive until the next click of a section
   * stepper. They are shown, and their quantity is shown, but the controls
   * are inert -- and `save` re-submits them untouched, so opening this panel
   * and saving can never drop them. */
  lockedRoles?: ReadonlySet<OptionRole>;
  /** "ui.showOptionIcons" app setting (see `getShowOptionIcons`,
   * src/lib/queries/settings.ts), read server-side and threaded down through
   * ItemsList/ItemsSection. Gates only the small per-option icon in this
   * editor's list; the priced breakdown above it reads the same setting
   * through its own prop. Defaults to `true` so a caller that forgets to pass it (e.g. a
   * future test) doesn't silently hide icons. */
  showOptionIcons?: boolean;
  readOnly?: boolean;
}) {
  // Always closed to begin with. This used to open itself for an item with
  // no options yet, which was defensible while it was an inline panel and
  // indefensible now that it is a modal: a quote with thirteen unconfigured
  // items would have tried to open thirteen dialogs on load.
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Map<string, SelectionState>>(() =>
    selectionsFromLines(currentLines)
  );
  const router = useRouter();
  const [search, setSearch] = useState("");

  // Only the count survives -- it rides on the button. The chips this used
  // to draw ("WPN ×1  LSC ×1  …") said the same thing as the priced list
  // above it, in less detail and a second visual language, so they were two
  // answers to one question sitting one above the other.
  const optionCount = currentLines.filter((line) => Boolean(line.code)).length;

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

  // What the rows read from, instead of `selected` directly: the manager's
  // picks as this panel has them, with the derived rows taken from the item's
  // lines as the server last confirmed them. See `withDerivedSelections`.
  const effective = withDerivedSelections(selected, currentLines, isLocked);

  // Re-sync from the server-confirmed lines only at the moment the panel
  // opens — while it's open, the user's own edits are the source of truth
  // and shouldn't be clobbered by a stale prop from an unrelated re-render.
  function openPanel() {
    setSelected(selectionsFromLines(currentLines));
    setSearch("");
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
    // "Clear" only ever emptied the manager's own picks: the derived rows are
    // read from the item's lines rather than held here, so there is nothing
    // of the builder's in this map to spare.
    setSelected(new Map());
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

  // The full selection set, in the shape the action takes. `setItemOptions`
  // replaces every option on the item in one call, so there is no partial
  // update to build: whatever is on screen is what gets sent.
  const selections = buildSelections(compatibleOptions, effective);

  // An MTS with no travel distance is the one thing this panel can produce
  // that the server will refuse, so autosave stays off until it is fixed,
  // exactly as TermsDocumentsPanel gates its own on a live Zod check. The
  // user sees the message immediately either way.
  const mtsWithoutLength = compatibleOptions.some(
    (option) =>
      option.role === "MTS" &&
      effective.has(option.id) &&
      !mtsMetresValid(effective.get(option.id)!.attributes)
  );

  // Every change commits on its own. There is no Save and no Cancel: with
  // nothing staged, Save would be a lie and Cancel a promise this panel
  // cannot keep, so closing it is never a decision and Escape, the backdrop
  // and Done all do the same harmless thing.
  //
  // Keyed by a stable serialisation rather than the array, because the array
  // is rebuilt on every render and would retrigger the hook forever.
  const autosaveKey = JSON.stringify(selections);
  const autosave = useAutosave({
    value: autosaveKey,
    enabled: open && !readOnly && !mtsWithoutLength,
    // Deliberately no router.refresh() here. Nothing in this app's document
    // actions calls revalidatePath, so the refresh has to happen somewhere,
    // but doing it per save would re-render the page on every checkbox and,
    // worse, could not terminate: the server normalises a selection set (it
    // derives the MTS travel line and the EasyLoader's modules), the new
    // lines come back as props, the effective set changes, and that is
    // another save. The refresh happens once, when the sheet closes.
    onSave: async () => {
      const result = await setItemOptions(itemId, selections);
      if (result?.error) return { error: result.error };
    },
  });

  function closePanel() {
    setOpen(false);
    // Pull the card's breakdown and the quote total back in line with what
    // was just written.
    router.refresh();
  }


  // No compatible options for this product at all — there's nothing to add
  // and nothing useful to say about that, so the whole block (heading,
  // toggle, empty state) is omitted rather than shown empty.
  if (compatibleOptions.length === 0) return null;

  return (
    <div className="mt-3">
      {!readOnly && (
        <div>
          {/* A real secondary button, not a link-styled trigger — bordered,
              44px-tall tap target, full-width on mobile so it's easy to hit
              on the phone this builder primarily targets. The option count
              renders as a small badge, and the chevron rotates (plus the
              label swaps to "Close options") to reflect panel state. */}
          <button
            type="button"
            onClick={openPanel}
            aria-haspopup="dialog"
            aria-expanded={open}
            className="focus-ring inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 transition-colors hover:border-brand/40 hover:bg-slate-50 active:bg-slate-100 sm:w-auto"
          >
            <SlidersHorizontal className="size-4 text-slate-500" aria-hidden="true" />
            <span>Edit options</span>
            {optionCount > 0 ? (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-brand/10 px-1.5 py-0.5 text-xs font-semibold text-brand">
                {optionCount}
              </span>
            ) : null}
            <ChevronRight className="size-4 text-slate-400" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* A side sheet, not an inline panel. Options are the longest job in
          the builder and the item card is the worst place to do it: the
          list pushed every machine below it down the page, and the footer
          that carries the save state and the count scrolled away with it.
          In a sheet the list gets the full height of the window, the footer
          cannot be scrolled out of reach, and the card underneath keeps its
          shape while the options change.

          The first attempt at this was Base UI's Dialog, whose popup would
          not take the viewport as its containing block in this tree. This
          one is a native <dialog> in the top layer; see side-sheet.tsx. */}
      <SideSheet
        open={open && !readOnly}
        onClose={closePanel}
        title={itemName}
        description={itemCode ?? undefined}
        footer={
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-sm text-slate-600">
              <span className="font-medium text-brand-dark">{effective.size} selected</span>
              {mtsWithoutLength ? (
                <span role="alert" className="block text-xs text-destructive">
                  {MTS_METRES_REQUIRED}
                </span>
              ) : null}
            </p>
            {/* Only speaks up while a save is in flight or has failed. There
                is no resting "Saved", for the same reason the quote bar
                carries no save indicator. */}
            <AutosaveIndicator status={autosave.status} error={autosave.error} />
            <Button type="button" variant="brand" onClick={closePanel}>
              Done
            </Button>
          </div>
        }
      >
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
            {effective.size} of {compatibleOptions.length} selected
          </span>
        </div>

        {displayOptions.length === 0 ? (
              <EmptyState
            icon={SearchX}
            title="No options match"
            description={`Nothing here is called \u201c${search}\u201d. Try a code, or part of a name.`}
            bordered={false}
            compact
            className="mt-2"
          />
            ) : (
              <div className="mt-2 flex flex-col gap-2">
                {displayOptions.map((option) => {
                  const state = effective.get(option.id);
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
                    : (option.conflictsWith.find((c) => effective.has(c.id)) ?? null);
                  const locked = isLocked(option.id);
                  const disabledReason = isOptionDisabled(option.price, conflictingWith);
                  const priced = disabledReason === null || disabledReason.type !== "unpriced";
                  const isMts = option.role === "MTS";
                  // The MTS length has its own control above; leaving it in
                  // the generic attribute list too would draw it twice.
                  const attributeFields = attributeFieldsFor(option.attributeSchema, option.role).filter(
                    (field) => !(isMts && field.key === MTS_METRES_KEY)
                  );
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
                              {formatMoney(option.price!.amount, currency, currencySymbol)}
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

                      {/* An MTS is one system of whatever length, so it has
                          no quantity worth showing: what the salesperson
                          sets is how far it travels, and the price follows
                          from that (MTS up to 9 m, MTS-M per metre after).
                          A "Qty" stepper beside a "Travel (m)" box invited
                          exactly the wrong number to be typed. */}
                      {checked && !locked && isMts ? (
                        <div className="mt-2 flex flex-wrap items-center gap-3 pl-[1.875rem]">
                          <MtsLengthField
                            id={`${option.id}-mts-metres`}
                            value={state!.attributes[MTS_METRES_KEY] ?? ""}
                            onChange={(value) => setAttribute(option.id, MTS_METRES_KEY, value)}
                          />
                        </div>
                      ) : null}

                      {checked && !locked && !isMts ? (
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
      </SideSheet>
    </div>
  );
}
