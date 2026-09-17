import type { OptionRole, ProductionForm } from "@prisma/client";

/**
 * Options a machine is added to a quote WITH, by the form it prints on.
 *
 * FabricPro: the crate (Vadym, 2026-09-17 -- "Crate завжди входить в
 * замовлення"). Production builds the crate and packs the machine in it, so
 * it is on every order; the manager can still take it off in the options
 * panel, and the form ticks it from the option line either way.
 *
 * A role, not a code: the catalogue picks the crate compatible with the
 * product (`Crate-FP`), and a rename there changes nothing here.
 */
export const DEFAULT_OPTION_ROLES: Partial<Record<ProductionForm, OptionRole[]>> = {
  FABRICPRO: ["CRATE"],
};

export function defaultOptionRoles(form: ProductionForm | null | undefined): OptionRole[] {
  return form ? (DEFAULT_OPTION_ROLES[form] ?? []) : [];
}

/**
 * Which of the candidate options to add: the first per role, in the order
 * given (the caller sorts). Two compatible crates would be two crates, so a
 * role never yields more than one line.
 */
export function pickDefaultOptions<T extends { role: OptionRole | null }>(roles: OptionRole[], candidates: T[]): T[] {
  return roles.flatMap((role) => candidates.find((option) => option.role === role) ?? []);
}
