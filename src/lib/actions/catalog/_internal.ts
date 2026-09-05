/**
 * The internals the catalogue-action modules in this directory share: the
 * Prisma error test both code-keyed editors need, the two `FormData`
 * readers behind the product and option forms, and the target shape
 * `upsertPrice` is called with.
 *
 * Like `src/lib/actions/_shared.ts` and its sibling
 * `src/lib/actions/documents/_internal.ts`, this file deliberately carries
 * NO `"use server"` directive — such a module may only export async
 * functions, and none of the below is one. `PriceTarget` is here for that
 * reason rather than for reuse: it is `upsertPrice`'s own parameter type,
 * but the barrel and `price-editor.tsx` both need it by name, and a plain
 * module is the one place a type can be exported without leaning on the
 * fact that types are erased before that check runs.
 *
 * A helper used by only one module in this directory stays private there
 * (`sanitizeProductDescription` in products.ts); only what crosses a module
 * boundary — or crosses out to a component, as `PriceTarget` does — earns a
 * place here. A helper whose callers reach past this directory altogether,
 * as the image-URL validator images.ts once kept privately does, belongs one
 * level up in `_shared.ts` instead, since this file is off-limits outside
 * `src/lib/actions/catalog/`. Nothing outside
 * `src/lib/actions/catalog/` should import from this file, the underscore
 * prefix marking it internal to this split the same way `_shared.ts` marks
 * itself internal to the action layer as a whole.
 */

import { Prisma } from "@prisma/client";

export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function readProductForm(formData: FormData) {
  return {
    code: formData.get("code"),
    name: formData.get("name"),
    description: formData.get("description"),
    active: formData.get("active"),
    noCommission: formData.get("noCommission"),
    sortOrder: formData.get("sortOrder"),
  };
}

export function readOptionForm(formData: FormData) {
  return {
    ...readProductForm(formData),
    shortDescription: formData.get("shortDescription"),
    attributeSchema: formData.get("attributeSchema"),
  };
}

export type PriceTarget = { productId: string; optionId?: never } | { optionId: string; productId?: never };

// A plain `"productId" in target` boolean doesn't let TypeScript narrow
// `target` at each later use site — only a real type-guard predicate,
// re-evaluated against the `target` expression itself, does that.
export function isProductPriceTarget(
  target: PriceTarget
): target is { productId: string; optionId?: never } {
  return "productId" in target;
}
