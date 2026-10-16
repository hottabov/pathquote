import type { ProductionForm } from "@prisma/client";

// Whether a form asks for the +Y/-Y operator side, stated without the form
// specs: every spec carries its zod `specSchema`, so importing `resolve.ts`
// from a client component put the zod runtime into the builder's JavaScript
// (audit 2026-10-16, PERF-08). The builder's item list only needs this one
// yes/no per item, so it lives here, with nothing but the enum behind it.
//
// The rule is the same one `resolveForm(form) !== null && !NO_SCREEN_SIDE`
// expressed in resolve.ts: every ProductionForm value has a spec
// (tests/screen-side.test.ts holds that true), so "has a spec" is "is a
// form", and only the set below says no.

/**
 * The Heavy Duty Roll Feeder and the Leather Nesting System have no screen
 * and no control box, and the Fabric Trolley is not a machine at all -- it
 * is a trolley, with nothing an operator stands at and no side to be built
 * for (Vadym, 2026-09-22). The builder does not ask any of them, "apply this
 * side to the quote" skips them, and the quotation prints no side line for
 * them.
 *
 * The EasyFeeder was in that set too ("the form asks for the model only",
 * Vadym, 2026-09-17) and came back out on 2026-09-22: the side is now printed
 * on the customer's quote (see `screenSideLabel`), because the director's
 * point is that it decides where the equipment stands, and a side nobody can
 * choose is a side the quote cannot state. Its control box is asked for the
 * same way every other one is.
 */
export const NO_SCREEN_SIDE: ReadonlySet<ProductionForm> = new Set<ProductionForm>(["HDRF", "LNS", "FP_TROLLEY"]);

export function formHasScreenSide(form: ProductionForm | null | undefined): boolean {
  return form != null && !NO_SCREEN_SIDE.has(form);
}
