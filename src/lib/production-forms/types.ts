import type { OptionRole, ProductKind, ProductionForm } from "@prisma/client";
import type { z } from "zod";
import type { ProductSpecs } from "@/lib/validation/product-specs";

/** One option line on a quote item, joined to its catalogue row. */
export type FormItemOption = {
  /** `Option.id` (the line's `refId`), or null for a line with no catalogue row. */
  id: string | null;
  code: string;
  /** `Option.role` -- what the forms tick and cover by. Null means no form has a box for it. */
  role: OptionRole | null;
  qty: number;
  /** `DocumentLine.attributes`, e.g. `{ metres: 14 }`. */
  attributes: Record<string, unknown> | null;
};

/** One quote item, flattened for form rendering. */
export type FormItem = {
  id: string;
  code: string;
  name: string;
  /** `Product.kind`; ACCESSORY for a custom item with no product. */
  kind: ProductKind;
  /** `Product.form` -- which order form this item prints on, or null for none. */
  form: ProductionForm | null;
  /** `Product.specs`, validated (see `readProductSpecs`). */
  specs: ProductSpecs;
  spec: Record<string, unknown>;
  /** Option lines on this item, each with its catalogue role. */
  options: FormItemOption[];
  /**
   * Legacy views of `options`, derived in context.ts -- kept for the sheet
   * and other consumers that still read codes. New code reads `options`.
   */
  /** @deprecated derived from `options` */
  optionCodes: string[];
  /** @deprecated derived from `options` */
  optionAttributes: Record<string, Record<string, unknown>>;
  /** @deprecated derived from `options` */
  optionQtys: { code: string; qty: number }[];
};

/** Everything a form needs that is not the item itself. */
export type FormContext = {
  distributorName: string;
  authorName: string;
  company: { name: string; addressLines: string[]; industry: string | null };
  contact: { fullName: string; position: string | null; phone: string | null; email: string | null };
  deliveryAddressLines: string[];
  /**
   * Every SOFTWARE item on the document with its specs, so a form can ask
   * whether the integrated PathWorks was sold and which modules came with it.
   */
  software: Array<{ code: string; specs: ProductSpecs }>;
  /** @deprecated derived from `software` */
  softwareCodes: string[];
  item: FormItem;
};

export type FormSpec = {
  id: string;
  title: string;
  template: string;
  /** Path of the worksheet inside the xlsx zip. */
  sheetPath: string;
  /** The `Product.form` value this spec prints. */
  form: ProductionForm;
  /** Written into blank cells. */
  values: Array<{ cell: string; from: (ctx: FormContext) => string | number | null | undefined }>;
  /** Overwrites printed label text -- rare, and declared separately so it is visible. */
  replaces: Array<{ cell: string; from: (ctx: FormContext) => string | null | undefined }>;
  /**
   * `covers` names the option role a tick consumes. It is what lets the
   * engine work out which of an item's options the form has no box for --
   * a tick's `when` alone cannot say that, and an option that silently
   * vanishes is the worst failure this feature could have. Ticks driven by
   * the product's specs or the production spec leave it undefined.
   */
  ticks: Array<{ cell: string; when: (ctx: FormContext) => boolean; covers?: OptionRole }>;
  /**
   * Option roles this form accounts for without a tick of their own -- the
   * EasyLoader's table modules, which the section rows and the printed total
   * already represent. Without this they would be reported unmatched and
   * printed again on the Additional items sheet, telling the workshop the
   * form had missed something it did not miss.
   */
  coversOptions?: OptionRole[];
  /** productionSpec keys that block generation while unanswered. */
  requires: string[];
  specSchema: z.ZodTypeAny;
};
