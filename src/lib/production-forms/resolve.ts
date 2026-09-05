import type { OptionRole, ProductionForm } from "@prisma/client";
import type { z } from "zod";
import { missingKeys } from "@/lib/validation/production-spec";
import { FORM_SPECS } from "./specs";
import type { CellPatch } from "./xlsx-patch";
import type { FormContext, FormItemOption, FormSpec } from "./types";

/**
 * Which form a quote item prints on. Keyed on `Product.form`, the column
 * that replaced matching the product code: a product with no form (software,
 * services, accessories, and machines whose form is not built yet) carries
 * null and gets none.
 */
export function resolveForm(form: ProductionForm | null | undefined): FormSpec | null {
  if (!form) return null;
  return FORM_SPECS.find((spec) => spec.form === form) ?? null;
}

/** The productionSpec schema for an item, or null when it prints no form. */
export function specSchemaForForm(form: ProductionForm | null | undefined): z.ZodTypeAny | null {
  return resolveForm(form)?.specSchema ?? null;
}

/** Which of a form's requirements this item has not answered yet. */
export function missingRequirements(spec: FormSpec, productionSpec: unknown): string[] {
  return missingKeys(productionSpec, spec.requires);
}

/**
 * Turns a spec plus a context into the exact list of cell writes. A tick is
 * the literal "X"; the cell's border and centring already live in the
 * template. Empty values are skipped so a missing optional never blanks a
 * cell that was meant to stay untouched.
 */
export function buildPatches(spec: FormSpec, ctx: FormContext): CellPatch[] {
  const patches: CellPatch[] = [];

  for (const { cell, from } of spec.values) {
    const value = from(ctx);
    if (value === null || value === undefined || value === "") continue;
    patches.push({ cell, value: String(value) });
  }

  for (const { cell, from } of spec.replaces) {
    const value = from(ctx);
    if (value === null || value === undefined) continue;
    patches.push({ cell, value });
  }

  for (const { cell, when } of spec.ticks) {
    if (when(ctx)) patches.push({ cell, value: "X" });
  }

  return patches;
}

/**
 * Options on this item that the form does not account for anywhere,
 * returned as the option lines themselves (id, code, role, qty) so the
 * caller can find the document line by `refId` rather than by a code the
 * catalogue may since have renamed.
 *
 * These are not dropped: they go on the "Additional items" sheet. An option
 * the workshop never sees is the worst thing this feature could do, so the
 * absence of a box has to be detectable rather than invisible -- which is
 * what `covers` on each option tick exists for.
 *
 * A tick is not the only way a form can account for an option, though. The
 * EasyLoader's table modules are represented by the three section rows and
 * the printed total rather than by a box of their own, and listing them
 * again on the Additional items sheet would tell the workshop the form had
 * missed something it did not miss. `coversOptions` is how a spec declares
 * that kind of coverage.
 *
 * Coverage is by `Option.role`. An option with no role is never covered: no
 * form has a box for it, by definition.
 */
export function unmatchedOptions(spec: FormSpec, ctx: FormContext): FormItemOption[] {
  const covered = new Set<OptionRole>([
    ...spec.ticks.map((tick) => tick.covers).filter((role): role is OptionRole => role !== undefined),
    ...(spec.coversOptions ?? []),
  ]);

  return ctx.item.options.filter((option) => option.role === null || !covered.has(option.role));
}
