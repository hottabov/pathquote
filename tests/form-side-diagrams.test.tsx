import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FormDocument } from "../src/components/forms/form-sheet";
import { formComponent } from "../src/components/forms/registry";
import { formContext, formItem } from "./helpers/fixtures";
import type { FormContext } from "../src/lib/production-forms/types";
import type { ProductionForm } from "@prisma/client";

/**
 * Every form that asks which side the operator stands on prints the same
 * thing: the two boxes, and the diagram of the side that was chosen. The
 * diagrams are the admin-uploaded `SpecImage` pair the builder already shows
 * beside the dropdown (Settings -> Catalogue -> Spec diagrams), so the sheet
 * in the workshop and the screen the salesperson used carry the same picture.
 *
 * Asserted across all five forms in one table rather than form by form: "it
 * should look the same everywhere" is the requirement, and a per-form test
 * lets one form drift.
 */
const SIDE_IMAGES = { "+Y": "pq-pdf-image:plus-y.png", "-Y": "pq-pdf-image:minus-y.png" };

const SECTIONS = [
  { lengthM: 4.8, surface: "conveyor" },
  { lengthM: 2.4, surface: "static" },
];

const ITEM: Record<ProductionForm, Record<string, unknown>> = {
  M_SERIES: {
    code: "M-7220",
    specs: { modelTier: "M7", widthCode: 220, cutWidthCm: 227, cutHeightCm: 7 },
    spec: { knifeSize: "1.5x7.0", drills: { required: false, detail: "" } },
  },
  X_CALIBRE: {
    code: "X-10220",
    specs: { modelTier: "X10", widthCode: 220, cutWidthCm: 227, cutHeightCm: 10 },
    spec: { drills: { required: false, detail: "" } },
  },
  L_SERIES: {
    code: "L-320",
    specs: { widthCode: 320, belt: "felt", extended: false },
    spec: {},
  },
  EASYLOADER: { code: "EL-2420", specs: { tableWidthMm: 2420 }, spec: { usage: "onload", sections: SECTIONS } },
  FABRICPRO: { code: "FP-220", specs: { widthCode: 220, cutWidthCm: 220 }, spec: {} },
  EASYFEEDER: {},
  HDRF: {},
  PUNCHLINE: {},
  FP_TROLLEY: {},
  LNS: {},
};

const FORMS = ["M_SERIES", "X_CALIBRE", "L_SERIES", "EASYLOADER", "FABRICPRO"] as const;

const render = (form: (typeof FORMS)[number], side: string, over: Partial<FormContext> = {}) => {
  const Component = formComponent(form)!;
  const fixture = ITEM[form];
  const ctx = formContext({
    screenSideImages: SIDE_IMAGES,
    item: formItem({
      code: fixture.code as string,
      form,
      specs: fixture.specs as never,
      spec: { ui: side, ...(fixture.spec as object) },
      options: [],
    }),
    ...over,
  });
  return renderToStaticMarkup(FormDocument({ children: Component({ ctx }) }));
};

const images = (html: string) => [...html.matchAll(/<img[^>]*class="pf-sidefig"[^>]*>/g)].map((m) => m[0]);

describe.each(FORMS)("%s: the operator-side diagram", (form) => {
  it("prints the diagram of the side that was chosen, and only that one", () => {
    const html = render(form, "+Y");
    expect(images(html)).toHaveLength(1);
    expect(images(html)[0]).toContain("plus-y.png");
    expect(images(html)[0]).not.toContain("minus-y.png");
  });

  it("follows the choice to the other side", () => {
    expect(images(render(form, "-Y"))[0]).toContain("minus-y.png");
  });

  it("prints no image at all until the diagrams are uploaded", () => {
    expect(images(render(form, "+Y", { screenSideImages: {} }))).toHaveLength(0);
  });
});

describe("the blue section bands", () => {
  /** The grey text a section band can carry beside its title. */
  const hints = (html: string) =>
    [...html.matchAll(/class="pf-hint">(.*?)<\/span>/g)].map((m) => m[1]);

  // How to fill the form in is not information the workshop needs, and on a
  // generated sheet it is wrong twice over: nobody ticks these boxes by hand
  // (Vadym, 2026-09-11).
  it.each(FORMS)("%s carries no form-filling hints", (form) => {
    const banned = ["tick one", "must match the cutter", "one model", "multiple of 1.2"];
    for (const hint of hints(render(form, "-Y"))) {
      for (const phrase of banned) expect(hint.toLowerCase(), form).not.toContain(phrase);
    }
  });

  it("keeps the PathWorks licence note, which says what is being sold rather than how to fill the form in", () => {
    expect(hints(render("M_SERIES", "-Y"))).toContain("integrated licence only");
  });
});

describe("what the forms no longer print", () => {
  it("drops the M-Series list of mutually exclusive options -- the quote cannot produce that pair", () => {
    expect(render("M_SERIES", "-Y")).not.toContain("Mutually exclusive");
  });

  it("drops the FabricPro manilla-folder instructions", () => {
    const html = render("FABRICPRO", "-Y");
    expect(html).not.toContain("Office handling");
    expect(html).not.toContain("manilla folder");
  });

  it("puts the FabricPro model and operator side on one row, as the cutter forms do", () => {
    const html = render("FABRICPRO", "-Y");
    const row = /<div class="pf-secrow"[^>]*>[\s\S]*?Model[\s\S]*?Operator side[\s\S]*?<\/div>/.test(html);
    expect(row).toBe(true);
  });
});
