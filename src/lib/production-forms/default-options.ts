import type { OptionRole, ProductKind, ProductionForm } from "@prisma/client";

/**
 * Options a product is added to a quote WITH. The manager can still take any
 * of them off in the options panel -- these are a starting point, not a rule.
 *
 * Two sources, merged:
 *
 * - By the form the item prints on. FabricPro: the crate (Vadym, 2026-09-17
 *   -- "Crate завжди входить в замовлення"). Production builds the crate and
 *   packs the machine in it, so it is on every order.
 * - On every product that ships or runs: its installation and training
 *   (Vadym, 2026-10-16 -- "усі опції які повʼязані з тренінгом та
 *   інсталляцією обраними по замовчуванню"). That is the `INSTALL` and
 *   `TRAINING` services and the EasyLoader's `EL_INSTALL`, which is priced
 *   from the table and so starts at nothing until one is drawn
 *   (src/lib/production-forms/el-install.ts). Not on a SERVICE product (the
 *   catch-all service line, RSP) or a CREDIT: those are not something that
 *   gets installed.
 *
 * Roles, not codes: the catalogue decides which option of the role fits the
 * product (by compatibility), and a rename there changes nothing here.
 */
export const DEFAULT_OPTION_ROLES_BY_FORM: Partial<Record<ProductionForm, OptionRole[]>> = {
  FABRICPRO: ["CRATE"],
};

export const SERVICE_DEFAULT_ROLES: readonly OptionRole[] = ["INSTALL", "TRAINING", "EL_INSTALL"];

const NO_SERVICE_DEFAULTS: ReadonlySet<ProductKind> = new Set<ProductKind>(["SERVICE", "CREDIT"]);

export function defaultOptionRoles(product: {
  form: ProductionForm | null | undefined;
  kind: ProductKind | null | undefined;
}): OptionRole[] {
  const byForm = product.form ? (DEFAULT_OPTION_ROLES_BY_FORM[product.form] ?? []) : [];
  const services = product.kind && NO_SERVICE_DEFAULTS.has(product.kind) ? [] : SERVICE_DEFAULT_ROLES;
  return [...byForm, ...services];
}

/** A candidate as `addItem` reads it: an option compatible with the product
 * and priced in the quote's region, already sorted by the catalogue order. */
export type DefaultOptionCandidate = {
  role: OptionRole | null;
  /** True when the option's compatibility names this product itself, not
   * just its series -- the catalogue saying "this one, for this model". */
  fitsProduct: boolean;
  /** The `OptionConflictGroup`s the option belongs to. */
  conflictGroupIds: string[];
};

/**
 * Which of the candidates to add: at most one per role.
 *
 * A role with one candidate adds it. With several, an option tied to this
 * product by name narrows the field first. If several still remain they are
 * added only when they are alternatives of one another -- all in one
 * conflict group, like the M-Series installation static vs. with MTS -- and
 * then the first in catalogue order. Several unrelated ones (the L-Series'
 * two installation sizes, both fitted to the whole series) mean the
 * catalogue cannot say which is right for this model, so none is added and
 * the manager picks: a wrong installation priced silently is worse than an
 * empty box.
 */
export function pickDefaultOptions<T extends DefaultOptionCandidate>(roles: OptionRole[], candidates: T[]): T[] {
  return roles.flatMap((role) => {
    const ofRole = candidates.filter((option) => option.role === role);
    const forProduct = ofRole.filter((option) => option.fitsProduct);
    const pool = forProduct.length > 0 ? forProduct : ofRole;
    if (pool.length === 0) return [];
    if (pool.length === 1) return [pool[0]];
    const [first, ...rest] = pool;
    const shared = first.conflictGroupIds.find((groupId) =>
      rest.every((option) => option.conflictGroupIds.includes(groupId))
    );
    return shared ? [first] : [];
  });
}
