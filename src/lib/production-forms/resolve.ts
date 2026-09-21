import type { OptionRole, ProductionForm } from "@prisma/client";
import type { z } from "zod";
import { missingKeys } from "@/lib/validation/production-spec";
import { FORM_SPECS } from "./specs";
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

/**
 * Whether a form asks for the +Y/-Y operator side. The Heavy Duty Roll Feeder
 * and the Leather Nesting System have no screen and no control box, so the
 * builder does not ask and "apply this side to the quote" skips them. The
 * EasyFeeder's form asks for the model only (Vadym, 2026-09-17).
 */
const NO_SCREEN_SIDE: ReadonlySet<ProductionForm> = new Set(["HDRF", "LNS", "EASYFEEDER"]);

export function formHasScreenSide(form: ProductionForm | null | undefined): boolean {
  return resolveForm(form) !== null && !NO_SCREEN_SIDE.has(form!);
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
 * Options on this item that the form does not account for anywhere,
 * returned as the option lines themselves (id, code, role, qty) so the
 * caller can find the document line by `refId` rather than by a code the
 * catalogue may since have renamed.
 *
 * These are not dropped: they go on the "Additional items" sheet. An option
 * the workshop never sees is the worst thing this feature could do, so the
 * absence of a box has to be detectable rather than invisible -- which is
 * what a spec's `covers` exists for.
 *
 * A box is not the only way a form can account for an option, though. The
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
  const covered = coveredRoles(spec);
  return ctx.item.options.filter((option) => option.role === null || !covered.has(option.role));
}

/**
 * Every option role this form accounts for: the boxes it prints (`covers`)
 * plus what it states without a box of its own (`coversOptions`).
 *
 * Both are declared rather than derived. A form's layout is JSX and its
 * boxes are not enumerable, so nothing can read the coverage back off the
 * page -- which is why the workbook forms, whose ticks *were* enumerable and
 * carried their own `covers`, assembled this list instead. That path went
 * with the last of them (2026-09-18) and this is now one set union.
 */
export function coveredRoles(spec: FormSpec): Set<OptionRole> {
  return new Set<OptionRole>([...spec.covers, ...(spec.coversOptions ?? [])]);
}
