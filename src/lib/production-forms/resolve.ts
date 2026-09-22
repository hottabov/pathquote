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
 * and the Leather Nesting System have no screen and no control box, and the
 * Fabric Trolley is not a machine at all -- it is a trolley, with nothing an
 * operator stands at and no side to be built for (Vadym, 2026-09-22). The
 * builder does not ask any of them, "apply this side to the quote" skips
 * them, and the quotation prints no side line for them.
 *
 * The EasyFeeder was in that set too ("the form asks for the model only",
 * Vadym, 2026-09-17) and came back out on 2026-09-22: the side is now printed
 * on the customer's quote (see `screenSideLabel`), because the director's
 * point is that it decides where the equipment stands, and a side nobody can
 * choose is a side the quote cannot state. Its control box is asked for the
 * same way every other one is.
 */
const NO_SCREEN_SIDE: ReadonlySet<ProductionForm> = new Set(["HDRF", "LNS", "FP_TROLLEY"]);

export function formHasScreenSide(form: ProductionForm | null | undefined): boolean {
  return resolveForm(form) !== null && !NO_SCREEN_SIDE.has(form!);
}

/**
 * What this form calls its +Y/-Y answer, in the customer's terms as well as
 * the workshop's -- one answer, three names, because the thing the operator
 * stands at differs: the cutters have a screen, the EasyLoader and the
 * EasyFeeder a control box, and the FabricPro's form says simply "Operator
 * side".
 *
 * One function rather than a ternary at each call site: the builder's panel,
 * the production form and now the quotation all print this label, and a
 * machine that is a "control box" on the workshop sheet and an "operator
 * screen" on the customer's quote reads as two different questions.
 *
 * Sentence case, because it is printed mid-page on the quote as well as as a
 * field label in the builder. Returns the cutter wording for a form with no
 * side at all (`formHasScreenSide` is the gate; this never has to answer
 * "none").
 */
export function screenSideLabel(form: ProductionForm | null | undefined): string {
  if (form === "EASYLOADER" || form === "EASYFEEDER") return "Control box side";
  if (form === "FABRICPRO") return "Operator side";
  return "Operator screen side";
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
