import type { OptionRole } from "@prisma/client";
import type { ProductSpecs } from "@/lib/validation/product-specs";
import type { FormContext } from "./types";

/**
 * The PathWorks section every cutter form prints (M-Series, X-Calibre,
 * L-Series): the integrated licence and the programs that run in it.
 *
 * Software reaches a quote two ways, and both must tick the same box
 * (Vadym, 2026-09-16 -- "софт існує як окремі товари так і опції до машин"):
 *
 * - as an OPTION on the machine -- `PTW-I`, `PDG`, `ANT-V6` ... each with a
 *   role of its own (migration z44). That is the everyday path, and the line
 *   belongs to this machine, so its box is ticked from the line.
 * - as a SOFTWARE product on the quote, for laptop-only installs. Those tick
 *   a cutter's form only while the INTEGRATED licence (`softwareMode:
 *   "integrated"`) is on the quote too -- with the standalone licence they
 *   belong on the Software Order Form, a different order.
 *
 * The standalone licence (`PTW-S`) is never an option and has no box here.
 */
export type PathWorksBox = {
  role: OptionRole;
  code: string;
  desc: string;
  /** The `Product.specs.pathworksModule` a software PRODUCT carries for the same program. */
  module?: NonNullable<ProductSpecs["pathworksModule"]>;
};

export const PATHWORKS_BOXES: PathWorksBox[] = [
  { role: "PTW_I", code: "PTW-I", desc: "PathWorks Integrated" },
  { role: "PDG", code: "PDG", desc: "PhotoDigitiser", module: "PDG" },
  { role: "WPN", code: "WPN", desc: "Wizard Panel", module: "WPN" },
  { role: "WPL", code: "WPL", desc: "PoolLiner Wizard", module: "WPL" },
  { role: "ANT_V5", code: "ANT-V5", desc: "AutoNester V5", module: "ANT_V5" },
  { role: "ANT_V6", code: "ANT-V6", desc: "AutoNester V6", module: "ANT_V6" },
  { role: "LSC", code: "LSC", desc: "LS Convert" },
  { role: "PRA", code: "PRA", desc: "Production Analyst" },
];

/** Every role the PathWorks section prints a box for -- part of each cutter spec's `covers`. */
export const PATHWORKS_ROLES: OptionRole[] = PATHWORKS_BOXES.map((box) => box.role);

/**
 * PathWorks modules sold on this quote with no PathWorks licence to run
 * them in.
 *
 * Not an error -- a customer who already owns PathWorks buys modules for it
 * and nothing is wrong -- which is why it reads as a remark rather than a
 * refusal wherever it is shown. It only became visible after finalisation,
 * on the order forms, which is the one moment it is too late to ask.
 *
 * Deliberately one function with two callers (the readiness rail and the
 * order-forms section) rather than the same two lines written out in each:
 * the builder saying nothing while the forms warn, or the reverse, is the
 * failure this is meant to prevent.
 *
 * Only SOFTWARE *products* count, on both sides of the test -- a module
 * bought as an option on a machine is not looked at here, because that is
 * the rule the order forms have always applied and widening it silently
 * would change which quotes warn.
 */
export function pathWorksModulesWithoutHost(
  software: ReadonlyArray<{ specs: ProductSpecs }>
): boolean {
  return (
    software.some((s) => s.specs.pathworksModule !== undefined) &&
    !software.some((s) => s.specs.softwareMode !== undefined)
  );
}

/** Whether the quote carries the integrated PathWorks as a SOFTWARE product. */
function integratedProductOnQuote(ctx: FormContext): boolean {
  return ctx.software.some((s) => s.specs.softwareMode === "integrated");
}

/** Whether a PathWorks box is ticked on this item's form. */
export function pathWorksTicked(ctx: FormContext, box: PathWorksBox): boolean {
  if (ctx.item.options.some((option) => option.role === box.role)) return true;

  if (!integratedProductOnQuote(ctx)) return false;
  if (box.role === "PTW_I") return true;
  if (box.module) return ctx.software.some((s) => s.specs.pathworksModule === box.module);
  // LSC and PRA carry no module spec; the product is known by its code.
  return ctx.software.some((s) => s.code === box.code);
}
