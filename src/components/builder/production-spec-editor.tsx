"use client";

import { useState, useTransition } from "react";
import type { ProductionForm } from "@prisma/client";
import { ChevronDown, Minus, Plus, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
import { applyScreenSideToQuote, setProductionSpec } from "@/lib/actions/production";
import { setEasyLoaderLayout } from "@/lib/actions/documents";
import { resolveForm } from "@/lib/production-forms/resolve";
import { easyLoaderPrintedWidthCell } from "@/lib/production-forms/specs/easyloader";
import type { ProductSpecs } from "@/lib/validation/product-specs";
import {
  layoutTotals,
  modulesIn,
  unitsToM,
  MAX_SECTIONS,
  type Section,
} from "@/lib/production-forms/table-sections";
import { resolveSpecImage, SCREEN_SIDES } from "@/lib/production-forms/spec-images";
import { SpecDiagram } from "@/components/builder/spec-diagram";

/**
 * Writes one section's module count, dropping any trailing section left
 * empty. A section with no modules is not a zero-length section, it is a
 * section that isn't there -- and `deriveEasyLoaderOptions` would otherwise
 * be handed a run of nothing to price.
 */
function writeSection(sections: Section[], index: number, modules: number, surface: Section["surface"]): Section[] {
  const copy = [...sections];
  while (copy.length <= index) copy.push({ lengthM: 0, surface: "conveyor" });
  copy[index] = { lengthM: unitsToM(modules), surface };
  while (copy.length > 0 && modulesIn(copy[copy.length - 1]!) === 0) copy.pop();
  return copy;
}

/** The printed form has four roll-feed distance rows, and no fifth to spill into. */
const MAX_ROLL_FEEDS = 4;

/**
 * Writes one roll-feed distance, keeping the array dense up to the last
 * answered row. A cleared field in the middle stays as a 0 rather than
 * collapsing the ones after it -- the numbers are positional (#1, #2, #3) and
 * renumbering them would move an attachment nobody touched.
 */
function writeDistance(distances: number[], index: number, value: number | undefined): number[] {
  const copy = [...distances];
  while (copy.length <= index) copy.push(0);
  copy[index] = value ?? 0;
  while (copy.length > 0 && copy[copy.length - 1] === 0) copy.pop();
  return copy;
}

const KNIFE_SIZES = ["1.5x5.0", "1.5x7.0", "2.0x7.0"] as const;
const VOLTAGES = ["220V", "400V", "415V", "480V"] as const;

const checkboxClass = "size-5 shrink-0 rounded border-slate-300 accent-brand";
/** Compact control height, matching the dense Qty/attribute rows in
 * item-options-editor.tsx rather than fieldInputClass's default 44px. */
const compactControlClass = "h-9";

/**
 * One label + control per row, used throughout this panel instead of the
 * label-above-control `FieldRow` -- with a dozen machine-specific fields
 * live at once, a stacked layout made this the tallest thing on the item
 * card. Mirrors the dense rows in item-options-editor.tsx (e.g. its "Qty"
 * control), just generalised to a labelled row rather than an inline span.
 */
function CompactField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={htmlFor} className="w-44 shrink-0 text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
    </div>
  );
}

/** A compact −/+ stepper. Markup mirrors the option-quantity control in
 * item-options-editor.tsx: a 36px square inside a 44px tap target. */
function Stepper({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="group focus-ring flex size-11 shrink-0 items-center justify-center rounded-lg disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span
        aria-hidden="true"
        className="flex size-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition-colors md:group-hover:bg-slate-50"
      >
        {children}
      </span>
    </button>
  );
}

/**
 * One rail-length field. Empty means "use the length the EasyLoader tables in
 * this quote add up to", which is the normal case, so the derived figure is
 * shown as the placeholder and spelled out underneath rather than written
 * into the input — a pre-filled box reads as a value someone chose, and the
 * next person to redraw the table would have no way to tell it apart from
 * one that was typed.
 */
function RailField({
  id,
  label,
  value,
  derived,
  onCommit,
}: {
  id: string;
  label: string;
  value: number | undefined;
  derived: number | null;
  onCommit: (value: number | undefined) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <CompactField label={label} htmlFor={id}>
        <input
          id={id}
          type="number"
          step="0.1"
          min={0}
          inputMode="decimal"
          placeholder={derived !== null ? String(derived) : "—"}
          defaultValue={value ?? ""}
          onBlur={(e) => onCommit(e.target.value === "" ? undefined : Number(e.target.value))}
          className={cn(fieldInputClass, compactControlClass, "w-28")}
        />
        {derived !== null && value === undefined ? (
          <span className="text-xs text-slate-500">from the EasyLoader table ({derived} m)</span>
        ) : null}
        {derived !== null && value !== undefined && value !== derived ? (
          <span className="text-xs text-amber-700">
            overrides the EasyLoader table ({derived} m)
          </span>
        ) : null}
      </CompactField>
    </div>
  );
}

type Drills = { required?: boolean; detail?: string } | undefined;

/**
 * The drills question, shared by the M-Series and the X-Calibre forms --
 * both print it, and both print the same warning that `"TBC" is not
 * acceptable`.
 *
 * The 22-character cap is an Excel artefact: rows 81-82 of the M-Series
 * workbook are tall hand-writing rows in a large font with no empty cell to
 * overflow into, so anything longer is clipped rather than wrapped. It goes
 * when these forms are redrawn as components.
 */
function DrillsField({
  itemId,
  drills,
  draft,
  save,
  setDraft,
}: {
  itemId: string;
  drills: Drills;
  draft: Record<string, unknown>;
  save: (next: Record<string, unknown>, kind: "spec" | "layout") => void;
  setDraft: (next: Record<string, unknown>) => void;
}) {
  return (
        <fieldset className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3">
          <legend className="px-1 text-xs font-medium text-slate-500">Drills</legend>
          <label className="flex min-h-11 items-center gap-2.5 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={drills?.required ?? false}
              // Ticking the box is the only control here that does not
              // write immediately. The printed form says "TBC" is not
              // acceptable, so `drillsSchema` refuses "drills required,
              // detail blank" -- which is precisely the half-answer a
              // tick on its own is. Hold it in the draft, let it reveal
              // the detail field, and write both halves together on
              // that field's blur. Unticking is a complete answer ("no
              // drills") and saves like everything else.
              onChange={(e) =>
                e.target.checked
                  ? setDraft({ ...draft, drills: { required: true, detail: "" } })
                  : save({ ...draft, drills: { required: false, detail: "" } }, "spec")
              }
              className={checkboxClass}
            />
            Drills required
          </label>
          {drills?.required ? (
            <CompactField label="Qty, type and size" htmlFor={`${itemId}-drills-detail`}>
              <input
                id={`${itemId}-drills-detail`}
                type="text"
                maxLength={22}
                defaultValue={drills?.detail ?? ""}
                onBlur={(e) =>
                  save({ ...draft, drills: { required: true, detail: e.target.value } }, "spec")
                }
                className={cn(fieldInputClass, compactControlClass, "flex-1 min-w-[10rem]")}
              />
            </CompactField>
          ) : null}
        </fieldset>
  );
}

type Props = {
  itemId: string;
  /** `Product.form` -- which order form this item prints on, or null for none. */
  form: ProductionForm | null;
  /** `Product.specs`, validated -- the table width is what decides whether
   * an EasyLoader needs the custom-width field below. */
  productSpecs: ProductSpecs;
  spec: Record<string, unknown>;
  /** True when the quote holds another machine the screen side could also
   * apply to — see the offer this panel shows after the side changes. */
  hasOtherMachines: boolean;
  /** `value -> imageUrl` for the "screenSide" `SpecImage` field (see
   * src/lib/queries/spec-images.ts's `getSpecImages`), fetched once per page
   * load and threaded down here the same way `showOptionIcons` is (see
   * ItemsSection) rather than fetched per item. A value with no entry
   * renders `SpecDiagram`'s placeholder box instead of a broken image —
   * expected until the owner uploads the real artwork. */
  screenSideImages: Record<string, string>;
  /**
   * Metres of rail the FabricPro-compatible EasyLoader tables in this quote
   * add up to, or null when there are none. Shown on a FabricPro card as the
   * value the form will print unless someone types over it -- the rails bolt
   * to the table, so re-typing a number the table already states is how the
   * two end up disagreeing. See `src/lib/production-forms/rails.ts`.
   */
  derivedRailLengthM: number | null;
  /**
   * How many single roll feed attachments this item sells (role
   * `EL_ROLL_FEED`, `EL-2020-RF` / `EL-2420-RF`), or 0 for none. The
   * attachment is an option, so it is picked in the options editor; what
   * belongs here is only where each one sits along the table, and asking for
   * a distance nobody ordered an attachment for is asking for nothing.
   */
  rollFeedQty: number;
  /** A finalized quote. The screen side and usage stay editable (they carry
   * no money — see `setProductionSpec`); the table layout does not, because
   * the modules it is built from are what the customer is charged. */
  readOnly?: boolean;
  /** Render the panel already open. Set for an EasyLoader, where this panel
   * is not a set of extra questions but the thing that builds and prices the
   * machine — leaving it behind a disclosure would hide the only place a
   * manager can put money on that item. */
  defaultOpen?: boolean;
};

/**
 * The per-item production spec editor: the machine questions the price list
 * doesn't cover (operator screen side, knife size, table sections, etc — see
 * `src/lib/production-forms`), collapsed behind a disclosure button that
 * surfaces how many required fields are still unanswered. Returns `null` for
 * an item with no form (software/service rows), so it's safe to mount
 * unconditionally from `ItemsList`.
 *
 * For an EasyLoader this is also where the machine is *built*. An EasyLoader
 * is a table assembled from 1.2 metre modules and the machine itself costs
 * nothing, so drawing the table is what puts money on the quote: the drive
 * modules, lengths, busbar and rail are written as option lines from this
 * layout (see `setEasyLoaderLayout`). Nothing is picked twice — the option
 * rows those produce are read-only in the options editor.
 *
 * Every other field writes through `setProductionSpec` immediately (select
 * `onChange`, text/number inputs `onBlur` — no separate Save button, mirrors
 * `ItemDiscountField`'s autosave-on-change feel without the debounce, since
 * these are discrete choices rather than free-typed text).
 */
export function ProductionSpecEditor({
  itemId,
  form: productForm,
  productSpecs,
  spec,
  hasOtherMachines,
  derivedRailLengthM,
  rollFeedQty,
  screenSideImages,
  readOnly = false,
  defaultOpen = false,
}: Props) {
  const form = resolveForm(productForm);
  const toast = useToast();
  const [open, setOpen] = useState(defaultOpen);
  const [draft, setDraft] = useState<Record<string, unknown>>(spec);
  const [error, setError] = useState<string | null>(null);
  // The side this card last set, while the offer to apply it to the rest of
  // the quote is still standing. Null means no offer on screen.
  const [offeredSide, setOfferedSide] = useState<string | null>(null);
  const [applying, startApplying] = useTransition();
  // How many of this card's own writes are still in flight. Only used to
  // decide whether an incoming `spec` may overwrite `draft` -- see below.
  const [inFlight, setInFlight] = useState(0);

  // This card's `spec` can change without this card having changed it: taking
  // the offer to apply a screen side across the quote rewrites every other
  // machine, and the revalidate that follows re-renders them with fresh
  // props. A `useState(spec)` initializer runs only on mount, so a card went
  // on showing the old side -- and its diagram -- until the page was
  // reloaded, even though the toast and the database were both right. Adopt
  // the server's value when it moves.
  //
  // Compared by value, not identity: every server render deserializes a new
  // object, so `!==` would fire on each refresh. And held back while one of
  // this card's own writes is in flight, or clicking a section stepper three
  // times would see the first write's revalidate arrive and yank the number
  // back to where it was two clicks ago. `inFlight` is state rather than a
  // ref precisely so that returning to zero re-renders and lets the sync
  // that was skipped happen now.
  const specKey = JSON.stringify(spec);
  const [syncedKey, setSyncedKey] = useState(specKey);
  if (inFlight === 0 && syncedKey !== specKey) {
    setSyncedKey(specKey);
    setDraft(spec);
  }

  if (!form) return null;

  const isEasyLoader = form.form === "EASYLOADER";

  async function save(next: Record<string, unknown>, kind: "spec" | "layout") {
    setDraft(next);
    setError(null);
    setInFlight((n) => n + 1);
    // An EasyLoader's layout also rewrites its option lines and its price,
    // so it goes through the documents action, which is DRAFT-gated. The
    // screen side and usage do not, so they keep the looser path that stays
    // available after finalize.
    const result =
      kind === "layout" ? await setEasyLoaderLayout(itemId, next) : await setProductionSpec(itemId, next);
    setInFlight((n) => n - 1);
    setError(result.error ?? null);
    if (result.error) {
      // The server rejected it, so `draft` is now showing something that was
      // never saved. Put it back rather than leaving a table on screen that
      // the quote does not charge for.
      setDraft(spec);
    }
  }

  function changeScreenSide(side: string) {
    void save({ ...draft, ui: side }, "spec");
    // Offered, never applied: the owner has machines that legitimately face
    // opposite ways within one line (a cutter's screen on one side, the
    // conveyor and FabricPro controls on the other), so this is the
    // manager's call to make and not a rule to enforce.
    setOfferedSide(hasOtherMachines ? side : null);
  }

  function applySideToQuote(side: string) {
    startApplying(async () => {
      const result = await applyScreenSideToQuote(itemId, side);
      setOfferedSide(null);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      const applied = result.appliedTo ?? [];
      toast.success(
        applied.length === 0
          ? `Every machine was already ${side}`
          : `Screen side ${side} applied to ${applied.slice(0, 2).join(", ")}${
              applied.length > 2 ? ` and ${applied.length - 2} more` : ""
            }`
      );
    });
  }

  const missing = form.requires.filter((key) => draft[key] === undefined);
  const drills = draft.drills as { required?: boolean; detail?: string } | undefined;
  const sections = (draft.sections as Section[] | undefined) ?? [];
  const rollFeedDistances = (draft.rollFeedDistancesMm as number[] | undefined) ?? [];
  const fabricProCompatible = (draft.fabricProCompatible as boolean | undefined) ?? false;
  // Absent means yes — `syncWithCutter` defaults to true, and a spec saved
  // before this field existed must read as the standard build, not as a
  // table somebody deliberately left unsynchronised.
  const syncWithCutter = (draft.syncWithCutter as boolean | undefined) ?? true;
  const totals = layoutTotals(sections);
  // "Operator screen side" everywhere except the EasyLoader, whose printed
  // form calls the same +Y/-Y choice "Control Box Side".
  const screenSideLabel = isEasyLoader ? "Control Box Side" : "Operator screen side";
  const currentSide = (draft.ui as string) ?? "-Y";

  const breakdown = [
    totals.driveModules > 0 ? `${totals.driveModules} × drive module` : null,
    totals.conveyorModules > 0 ? `${totals.conveyorModules} × 1.2m conveyor` : null,
    totals.staticModules > 0 ? `${totals.staticModules} × 1.2m static` : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="focus-ring inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 transition-colors hover:border-brand/40 hover:bg-slate-50 active:bg-slate-100 sm:w-auto"
      >
        <Settings2 className="size-4 text-slate-500" aria-hidden="true" />
        <span>
          {open ? "Close" : isEasyLoader ? "EasyLoader builder" : "Production spec"}
        </span>
        {isEasyLoader && totals.totalM > 0 ? (
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
            {totals.totalM} m
          </span>
        ) : null}
        {missing.length > 0 ? (
          <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
            {missing.length} missing
          </span>
        ) : null}
        <ChevronDown
          className={cn("size-4 text-slate-400 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div className="mt-2 flex flex-col gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          {isEasyLoader ? (
            <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3">
              <div>
                <p className="text-sm font-medium text-brand-dark">Table layout</p>
                <p className="text-xs text-slate-500">
                  Each click adds one 1.2 m module. A conveyor run drives from its first module, so
                  each one starts with a drive module.
                </p>
              </div>

              {Array.from({ length: MAX_SECTIONS }, (_, index) => {
                const section = sections[index];
                const modules = section ? modulesIn(section) : 0;
                const surface = section?.surface ?? "conveyor";
                return (
                  <div key={index} className="flex flex-wrap items-center gap-2">
                    <span className="w-20 shrink-0 text-xs text-slate-500">Section {index + 1}</span>
                    <div className="flex items-center gap-1.5">
                      <Stepper
                        label={`Remove a module from section ${index + 1}`}
                        disabled={readOnly || modules === 0}
                        onClick={() =>
                          save(
                            { ...draft, sections: writeSection(sections, index, modules - 1, surface) },
                            "layout"
                          )
                        }
                      >
                        <Minus className="size-3.5" />
                      </Stepper>
                      <span
                        className="w-24 shrink-0 text-center text-sm font-medium text-slate-700"
                        aria-label={`Section ${index + 1} length`}
                      >
                        {modules === 0 ? "—" : `${unitsToM(modules).toFixed(1)} m`}
                      </span>
                      <Stepper
                        label={`Add a module to section ${index + 1}`}
                        disabled={readOnly}
                        onClick={() =>
                          save(
                            { ...draft, sections: writeSection(sections, index, modules + 1, surface) },
                            "layout"
                          )
                        }
                      >
                        <Plus className="size-3.5" />
                      </Stepper>
                    </div>
                    <select
                      aria-label={`Section ${index + 1} surface`}
                      value={surface}
                      disabled={readOnly}
                      onChange={(e) =>
                        save(
                          {
                            ...draft,
                            sections: writeSection(
                              sections,
                              index,
                              modules,
                              e.target.value as Section["surface"]
                            ),
                          },
                          "layout"
                        )
                      }
                      className={cn(fieldInputClass, compactControlClass, "w-32")}
                    >
                      <option value="conveyor">Conveyor</option>
                      <option value="static">Static</option>
                    </select>
                    {modules > 0 ? (
                      <span className="text-xs text-slate-500">
                        {modules} {modules === 1 ? "module" : "modules"}
                      </span>
                    ) : null}
                  </div>
                );
              })}

              <div className="border-t border-slate-100 pt-2">
                {totals.totalModules > 0 ? (
                  <p className="text-sm text-slate-600">
                    Table: {totals.totalM} m ({breakdown.join(" + ")})
                  </p>
                ) : (
                  <p className="text-sm text-destructive">
                    No modules yet — this EasyLoader has nothing to price.
                  </p>
                )}
              </div>

              <label className="flex min-h-11 items-center gap-2.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={fabricProCompatible}
                  disabled={readOnly}
                  onChange={(e) => save({ ...draft, fabricProCompatible: e.target.checked }, "layout")}
                  className={checkboxClass}
                />
                FabricPro compatible
                <span className="text-xs text-slate-500">
                  adds a busbar and a support rail per module
                </span>
              </label>

              {/* Ticked by default — it is how an EasyLoader is normally
                  built, so the rare table that does not sync with a cutter is
                  the one that costs somebody a click. Nothing is charged for
                  it, so it is a build answer rather than an option line. */}
              <label className="flex min-h-11 items-center gap-2.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={syncWithCutter}
                  disabled={readOnly}
                  onChange={(e) => save({ ...draft, syncWithCutter: e.target.checked }, "spec")}
                  className={checkboxClass}
                />
                Synchronisation with the cutter
              </label>
            </div>
          ) : null}

          <CompactField label={screenSideLabel} htmlFor={`${itemId}-ui`}>
            <select
              id={`${itemId}-ui`}
              // screenSideSchema defaults to "-Y" (material right to left,
              // the M-Series form's printed "(STD)") -- shown preselected
              // here so a manager who never opens this panel still sees the
              // correct standard rather than a blank "—".
              value={currentSide}
              onChange={(e) => changeScreenSide(e.target.value)}
              className={cn(fieldInputClass, compactControlClass, "w-24")}
            >
              {SCREEN_SIDES.map((side) => (
                <option key={side} value={side}>
                  {side}
                </option>
              ))}
            </select>
            {/* Illustrates whichever side is currently selected -- Ross
                (owner meeting): "rather than showing plus or minus, show
                that image... to someone in another language, they might get
                confused." The dropdown stays; this sits beside it in the
                free space to the right (owner clarification). Falls back to
                SpecDiagram's own placeholder box until the owner uploads the
                real artwork for this value (Settings -> Catalogue). */}
            <SpecDiagram
              src={resolveSpecImage(screenSideImages, currentSide)}
              alt={`${screenSideLabel}: ${currentSide}`}
            />
          </CompactField>

          {offeredSide ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand/30 bg-white p-2">
              <span className="text-sm text-slate-700">
                Apply {offeredSide} to the other machines in this quote?
              </span>
              <Button
                type="button"
                variant="outline"
                disabled={applying}
                onClick={() => applySideToQuote(offeredSide)}
                className="h-9"
              >
                {applying ? "Applying…" : "Apply"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={applying}
                onClick={() => setOfferedSide(null)}
                className="h-9"
              >
                Keep separate
              </Button>
            </div>
          ) : null}

          {form.form === "X_CALIBRE" ? (
            <>
              {/* No knife size: the X-Calibre form prints one, 2.4 x 8.5. */}
              <CompactField label="Voltage (optional)" htmlFor={`${itemId}-voltage`}>
                <select
                  id={`${itemId}-voltage`}
                  value={(draft.voltage as string) ?? ""}
                  onChange={(e) =>
                    save({ ...draft, voltage: e.target.value === "" ? undefined : e.target.value }, "spec")
                  }
                  className={cn(fieldInputClass, compactControlClass, "w-28")}
                >
                  <option value="">—</option>
                  {VOLTAGES.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </CompactField>

              <DrillsField itemId={itemId} drills={drills} draft={draft} save={save} setDraft={setDraft} />

              <CompactField label="Special notes (optional)" htmlFor={`${itemId}-special-notes`}>
                <input
                  id={`${itemId}-special-notes`}
                  type="text"
                  defaultValue={(draft.specialNotes as string) ?? ""}
                  onBlur={(e) => save({ ...draft, specialNotes: e.target.value }, "spec")}
                  className={cn(fieldInputClass, compactControlClass, "flex-1 min-w-[10rem]")}
                />
              </CompactField>
            </>
          ) : null}

          {form.form === "L_SERIES" ? (
            <>
              {/* Model, cutting length and cutting surface are not asked:
                  they are `Product.specs.widthCode` / `.extended` / `.belt`,
                  so L-320EF already says "extended, felt, 320". Asking again
                  would only create two answers that can disagree. The tools
                  row is not here either -- every tool on it is a priced
                  `L_TOOL` option, and the form's "replace X with Qty" is the
                  option line's own quantity. */}
              <CompactField label="Voltage" htmlFor={`${itemId}-l-voltage`}>
                <select
                  id={`${itemId}-l-voltage`}
                  value={(draft.voltage as string) ?? ""}
                  onChange={(e) =>
                    save({ ...draft, voltage: e.target.value === "" ? undefined : e.target.value }, "spec")
                  }
                  className={cn(fieldInputClass, compactControlClass, "w-32")}
                >
                  <option value="">—</option>
                  <option value="220/230">220/230</option>
                  <option value="other">Other</option>
                </select>
              </CompactField>

              {draft.voltage === "other" ? (
                <CompactField label="Voltage (VAC)" htmlFor={`${itemId}-l-voltage-other`}>
                  <input
                    id={`${itemId}-l-voltage-other`}
                    type="text"
                    maxLength={20}
                    defaultValue={(draft.voltageOtherVac as string) ?? ""}
                    onBlur={(e) => save({ ...draft, voltageOtherVac: e.target.value }, "spec")}
                    className={cn(fieldInputClass, compactControlClass, "w-32")}
                  />
                </CompactField>
              ) : null}

              <CompactField label="Shipping" htmlFor={`${itemId}-l-shipping`}>
                <select
                  id={`${itemId}-l-shipping`}
                  value={(draft.shipping as string) ?? ""}
                  onChange={(e) =>
                    save({ ...draft, shipping: e.target.value === "" ? undefined : e.target.value }, "spec")
                  }
                  className={cn(fieldInputClass, compactControlClass, "w-56")}
                >
                  <option value="">—</option>
                  <option value="complete">Complete (whole)</option>
                  <option value="crate-disassembled">Wood crate (disassembled)</option>
                  <option value="crate-whole">Wood crate (whole)</option>
                </select>
              </CompactField>

              <CompactField label="Special notes (optional)" htmlFor={`${itemId}-l-notes`}>
                <input
                  id={`${itemId}-l-notes`}
                  type="text"
                  defaultValue={(draft.specialNotes as string) ?? ""}
                  onBlur={(e) => save({ ...draft, specialNotes: e.target.value }, "spec")}
                  className={cn(fieldInputClass, compactControlClass, "flex-1 min-w-[10rem]")}
                />
              </CompactField>
            </>
          ) : null}

          {form.form === "M_SERIES" ? (
            <>
              <CompactField label="Knife size" htmlFor={`${itemId}-knife-size`}>
                <select
                  id={`${itemId}-knife-size`}
                  value={(draft.knifeSize as string) ?? ""}
                  onChange={(e) => save({ ...draft, knifeSize: e.target.value }, "spec")}
                  className={cn(fieldInputClass, compactControlClass, "w-32")}
                >
                  <option value="">—</option>
                  {KNIFE_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </CompactField>

              <CompactField label="Voltage (optional)" htmlFor={`${itemId}-voltage`}>
                <select
                  id={`${itemId}-voltage`}
                  value={(draft.voltage as string) ?? ""}
                  onChange={(e) =>
                    save({ ...draft, voltage: e.target.value === "" ? undefined : e.target.value }, "spec")
                  }
                  className={cn(fieldInputClass, compactControlClass, "w-28")}
                >
                  <option value="">—</option>
                  {VOLTAGES.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </CompactField>

              <DrillsField itemId={itemId} drills={drills} draft={draft} save={save} setDraft={setDraft} />

              <CompactField label="Special notes (optional)" htmlFor={`${itemId}-special-notes`}>
                <input
                  id={`${itemId}-special-notes`}
                  type="text"
                  maxLength={28}
                  defaultValue={(draft.specialNotes as string) ?? ""}
                  onBlur={(e) => save({ ...draft, specialNotes: e.target.value }, "spec")}
                  className={cn(fieldInputClass, compactControlClass, "flex-1 min-w-[10rem]")}
                />
              </CompactField>
            </>
          ) : null}

          {isEasyLoader ? (
            <>
              <CompactField label="Used as" htmlFor={`${itemId}-usage`}>
                <select
                  id={`${itemId}-usage`}
                  // usage defaults to "onload" -- shown preselected for the
                  // same reason the screen side is, above.
                  value={(draft.usage as string) ?? "onload"}
                  onChange={(e) => save({ ...draft, usage: e.target.value }, "spec")}
                  className={cn(fieldInputClass, compactControlClass, "w-32")}
                >
                  <option value="onload">On load</option>
                  <option value="offload">Off load</option>
                </select>
              </CompactField>

              {/* The printed form has a box for two widths and a "Custom
                  ___mm" line for the rest; the field exists exactly when the
                  box does not -- see `easyLoaderPrintedWidthCell`. */}
              {easyLoaderPrintedWidthCell(productSpecs) === null ? (
                <CompactField label="Custom width (mm)" htmlFor={`${itemId}-custom-width`}>
                  <input
                    id={`${itemId}-custom-width`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={9999}
                    defaultValue={(draft.customWidthMm as number) ?? ""}
                    onBlur={(e) =>
                      save(
                        {
                          ...draft,
                          customWidthMm: e.target.value === "" ? undefined : Number(e.target.value),
                        },
                        "spec"
                      )
                    }
                    className={cn(fieldInputClass, compactControlClass, "w-28")}
                  />
                </CompactField>
              ) : null}

              {/* One row per attachment sold. The printed form has four, and
                  so does the option's quantity cap; a fifth would have
                  nowhere to print. Jeff does not fit these -- the parts ship
                  and the service crew installs them on site -- so this is
                  written for whoever is holding the sheet at the customer's
                  factory, not for the workshop. */}
              {rollFeedQty > 0 ? (
                <fieldset className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3">
                  <legend className="px-1 text-xs font-medium text-slate-500">
                    Roll feed — distance from X = 0
                  </legend>
                  {Array.from({ length: Math.min(rollFeedQty, MAX_ROLL_FEEDS) }, (_, index) => (
                    <CompactField
                      key={index}
                      label={`#${index + 1} distance (mm)`}
                      htmlFor={`${itemId}-roll-feed-${index}`}
                    >
                      <input
                        id={`${itemId}-roll-feed-${index}`}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={99999}
                        disabled={readOnly}
                        defaultValue={rollFeedDistances[index] ?? ""}
                        onBlur={(e) =>
                          save(
                            {
                              ...draft,
                              rollFeedDistancesMm: writeDistance(
                                rollFeedDistances,
                                index,
                                e.target.value === "" ? undefined : Number(e.target.value)
                              ),
                            },
                            "spec"
                          )
                        }
                        className={cn(fieldInputClass, compactControlClass, "w-28")}
                      />
                    </CompactField>
                  ))}
                </fieldset>
              ) : null}
            </>
          ) : null}

          {form.form === "FABRICPRO" ? (
            <>
              {/* Both rails are the same length, and that length is a fact
                  about the EasyLoader table this FabricPro runs over — so
                  when a table in this quote is marked FabricPro compatible,
                  the number arrives on its own and the field is left empty
                  rather than pre-filled. Typing one overrides it, for the
                  case the quote cannot see: a customer extending a table
                  they already own. */}
              <RailField
                id={`${itemId}-rail-length`}
                label="Travel platform rail length (m)"
                value={draft.railLengthM as number | undefined}
                derived={derivedRailLengthM}
                onCommit={(value) => save({ ...draft, railLengthM: value }, "spec")}
              />

              <RailField
                id={`${itemId}-power-rail-length`}
                label="Electrical power rail length (m)"
                value={draft.powerRailLengthM as number | undefined}
                derived={derivedRailLengthM}
                onCommit={(value) => save({ ...draft, powerRailLengthM: value }, "spec")}
              />

              {/* Ex-Works was here. It is a delivery term the quote states,
                  and a second copy on the build sheet reads as something the
                  workshop sets (Vadym, 2026-09-11). */}
            </>
          ) : null}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
