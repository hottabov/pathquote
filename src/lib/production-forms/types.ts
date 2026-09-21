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

/**
 * Everything a form declares. There used to be two shapes here -- a workbook
 * patched at hard-coded cell addresses and a React component -- discriminated
 * by `renderer`. The last workbook form (Punchline) was dropped on 2026-09-18
 * at the owner's instruction, and with it the whole xlsx path
 * (`docs/superpowers/specs/2026-09-03-web-production-forms-design.md` §7.1),
 * so one shape is left. `renderer` survives as the marker of that: a spec
 * says out loud that a component draws it, and the render tests assert it
 * rather than trusting the absence of a template field.
 *
 * Layout is JSX and therefore not enumerable, so the coverage question --
 * "does this form have a box for option X?" -- cannot be assembled from the
 * layout the way it once was from the ticks, and is declared here instead.
 * That question is the safety-critical part of the engine: it is what sends
 * an option the form cannot express to the Additional items sheet rather
 * than letting it vanish.
 */
export type HtmlFormSpec = {
  id: string;
  title: string;
  /** The `Product.form` value this spec prints. */
  form: ProductionForm;
  renderer: "html";
  /** productionSpec keys that block generation while unanswered. */
  requires: string[];
  specSchema: z.ZodTypeAny;
  /** Option roles this form prints a box for. */
  covers: OptionRole[];
  /**
   * Option roles this form accounts for without a box of its own -- the
   * EasyLoader's table modules, which the section rows and the printed total
   * already represent. Without this they would be reported unmatched and
   * printed again on the Additional items sheet, telling the workshop the
   * form had missed something it did not miss.
   */
  coversOptions?: OptionRole[];
};

/**
 * Every order form is a component now, so there is nothing left to union.
 * The alias stays because the engine (`resolve.ts`, the PDF route, the
 * builder) asks "which form does this item print on?" and should not have to
 * care that the answer happens to be drawn as HTML.
 */
export type FormSpec = HtmlFormSpec;
