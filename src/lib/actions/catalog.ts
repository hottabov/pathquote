/**
 * The catalogue action layer's public face: one import path,
 * `@/lib/actions/catalog`, over the modules in `./catalog/`.
 *
 * The actions themselves used to live here, all six concerns in one file.
 * They now sit one concern per module — the product rows and their order,
 * the global options, the image column each of those (and a series) carries,
 * the region-keyed price rows, an option's series compatibility, and the
 * conflict groups — and this file only re-exports them. Every consumer in
 * src/app/ and src/components/ keeps the import it already had; a split that
 * made 20-odd call sites chase their action to a new path would have been a
 * worse trade than the god-file it replaced.
 *
 * The re-exports are named rather than `export *` so this file also reads as
 * the inventory of what the catalogue layer offers, and so an action added
 * to a module below is a deliberate addition here rather than an accident of
 * a wildcard.
 *
 * This file carries NO `"use server"` directive, and must not: the
 * directive's transform registers the async functions a module *declares*,
 * and a module that only re-exports declares none — `next build` rejects the
 * result outright ("The module has no exports at all"). Each module in
 * `./catalog/` carries the directive instead, which is where it belongs: an
 * action is registered once, at its declaration, and a re-export of it here
 * is the same action reference, not a second one wrapping it. The types
 * likewise come from the two directive-free modules (`./_shared` for the
 * shared result shape, `./catalog/_internal` for the price target), since a
 * `"use server"` module may export only async functions.
 */

export type { ActionResult } from "./_shared";
export type { PriceTarget } from "./catalog/_internal";

export {
  createProduct,
  updateProduct,
  deleteProduct,
  reorderProducts,
} from "./catalog/products";

export { createOption, updateOption, deleteOption } from "./catalog/options";

export { updateProductImage, updateOptionImage, updateSeriesImage } from "./catalog/images";

export { upsertPrice } from "./catalog/prices";

export { setOptionCompatibility } from "./catalog/compatibility";

export {
  createConflictGroup,
  updateConflictGroupName,
  deleteConflictGroup,
  setConflictGroupMembers,
} from "./catalog/conflict-groups";
