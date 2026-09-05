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
  const fabricProCompatible = (draft.fabricProCompatible as boolean | undefined) ?? false;
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
            </>
          ) : null}

          {form.form === "FABRICPRO" ? (
            <>
              <label className="flex min-h-11 items-center gap-2.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={(draft.travelPlatform as boolean) ?? false}
                  onChange={(e) => save({ ...draft, travelPlatform: e.target.checked }, "spec")}
                  className={checkboxClass}
                />
                Travel platform
              </label>

              <CompactField label="Travel platform rail length (m, optional)" htmlFor={`${itemId}-rail-length`}>
                <input
                  id={`${itemId}-rail-length`}
                  type="number"
                  step="0.1"
                  min={0}
                  inputMode="decimal"
                  defaultValue={(draft.railLengthM as number) ?? ""}
                  onBlur={(e) =>
                    save(
                      { ...draft, railLengthM: e.target.value === "" ? undefined : Number(e.target.value) },
                      "spec"
                    )
                  }
                  className={cn(fieldInputClass, compactControlClass, "w-28")}
                />
              </CompactField>

              <CompactField
                label="Electrical power rail length (m, optional)"
                htmlFor={`${itemId}-power-rail-length`}
              >
                <input
                  id={`${itemId}-power-rail-length`}
                  type="number"
                  step="0.1"
                  min={0}
                  inputMode="decimal"
                  defaultValue={(draft.powerRailLengthM as number) ?? ""}
                  onBlur={(e) =>
                    save(
                      {
                        ...draft,
                        powerRailLengthM: e.target.value === "" ? undefined : Number(e.target.value),
                      },
                      "spec"
                    )
                  }
                  className={cn(fieldInputClass, compactControlClass, "w-28")}
                />
              </CompactField>

              <label className="flex min-h-11 items-center gap-2.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={(draft.exWorks as boolean) ?? false}
                  onChange={(e) => save({ ...draft, exWorks: e.target.checked }, "spec")}
                  className={checkboxClass}
                />
                Ex-Works
              </label>

              <label className="flex min-h-11 items-center gap-2.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={(draft.crate as boolean) ?? false}
                  onChange={(e) => save({ ...draft, crate: e.target.checked }, "spec")}
                  className={checkboxClass}
                />
                Crate required
              </label>
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
