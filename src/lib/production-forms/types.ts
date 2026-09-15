import type { OptionRole, ProductKind, ProductionForm } from "@prisma/client";
import type { z } from "zod";
import type { ProductSpecs } from "@/lib/validation/product-specs";
import type { RailAssignment } from "./rails";

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
  /**
   * The EasyLoader table this form prints rail lengths off, or null when
   * there is none to print.
   *
   * A FabricPro's rails belong to the table it travels over, and one machine
   * travels over one table -- so this is a *pairing*, made once for the whole
   * document in `assignRails` and read here rather than each form summing the
   * tables itself (which gave two FabricPros the same doubled length). On a
   * FabricPro context it is the table that machine was paired with; on an
   * EasyLoader context it is the table itself, and only while no FabricPro
   * claimed it. See `rails.ts`.
   */
  rails: RailAssignment | null;
  /**
   * The quote this form was made from, and where this page sits in it.
   * Printed in the meta strip and again in the footnote, so somebody holding
   * the sheet a month later can find the quote without asking. The paper
   * forms carried none of this -- they were filled in by hand from a quote
   * the filler had in front of them.
   */
  documentNumber: string;
  /** 1-based, for "item 2 of 3". */
  itemIndex: number;
  itemCount: number;
  generatedAt: Date;
  /** The entity logo as a data URI, or null to print the name instead. */
  logo: string | null;
  /**
   * `screenSide` value -> image src, for the diagram of the operator/control
   * box side. The same admin-uploaded `SpecImage` pair the builder shows
   * beside the dropdown (Settings -> Catalogue -> Spec diagrams), so the
   * sheet in the workshop carries the picture the salesperson chose from.
   *
   * A src, not a file name: the PDF route passes marks that
   * `inlineSheetImages` swaps for bytes (Gotenberg's Chromium cannot fetch
   * an auth-gated /api/files URL), a preview script can pass a path, and a
   * test can pass anything. Empty until the diagrams are uploaded, and then
   * no form prints an image -- never a broken one.
   */
  screenSideImages: Record<string, string>;
  item: FormItem;
};

/** What turns a spec into a printed page. */
export type FormRenderer = "xlsx" | "html";

/** Everything a form declares regardless of how it is drawn. */
type FormSpecBase = {
  id: string;
  title: string;
  /** The `Product.form` value this spec prints. */
  form: ProductionForm;
  /** productionSpec keys that block generation while unanswered. */
  requires: string[];
  specSchema: z.ZodTypeAny;
  /**
   * Option roles this form accounts for without a tick of their own -- the
   * EasyLoader's table modules, which the section rows and the printed total
   * already represent. Without this they would be reported unmatched and
   * printed again on the Additional items sheet, telling the workshop the
   * form had missed something it did not miss.
   */
  coversOptions?: OptionRole[];
};

/**
 * A form drawn by patching the original workbook. The three cell arrays are
 * the whole of its layout, and they are what
 * `docs/superpowers/specs/2026-09-03-web-production-forms-design.md` §7.1
 * deletes: every one of these becomes a component. Nothing new should be
 * written in this shape.
 */
export type XlsxFormSpec = FormSpecBase & {
  renderer: "xlsx";
  template: string;
  /** Path of the worksheet inside the xlsx zip. */
  sheetPath: string;
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
};

/**
 * A form drawn as a React component. Its layout is JSX and therefore not
 * enumerable, so the coverage question -- "does this form have a box for
 * option X?" -- can no longer be assembled from the ticks and is declared
 * here instead. That question is the safety-critical part of the engine: it
 * is what sends an option the form cannot express to the Additional items
 * sheet rather than letting it vanish.
 */
export type HtmlFormSpec = FormSpecBase & {
  renderer: "html";
  /** Option roles this form prints a box for. */
  covers: OptionRole[];
};

export type FormSpec = XlsxFormSpec | HtmlFormSpec;

/** Narrowing helper: only an xlsx spec has cells to patch. */
export function isXlsxForm(spec: FormSpec): spec is XlsxFormSpec {
  return spec.renderer === "xlsx";
}
