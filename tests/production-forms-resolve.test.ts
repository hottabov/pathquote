import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  resolveForm,
  specSchemaForForm,
  buildPatches,
  missingRequirements,
  unmatchedOptions,
} from "../src/lib/production-forms/resolve";
import { PATHWORKS_BOXES, pathWorksTicked } from "../src/lib/production-forms/pathworks";
import { EasyLoaderForm } from "../src/components/forms/easyloader-form";
import { FabricProForm } from "../src/components/forms/fabricpro-form";
import { FormDocument } from "../src/components/forms/form-sheet";
import type { FormContext, FormItem, FormSpec } from "../src/lib/production-forms/types";
import { formContext, formItem, formOption, xlsxForm } from "./helpers/fixtures";

/** The codes of the options a form has no box for -- what the Additional
 * items sheet prints. The route matches the lines by id; the tests read the
 * codes because that is what a person recognises. */
const unmatchedOptionCodes = (spec: FormSpec, ctx: FormContext) =>
  unmatchedOptions(spec, ctx).map((option) => option.code);

const marked = (html: string, state: "pf-on" | "pf-std"): string[] =>
  [...html.matchAll(new RegExp(`class="pf-tick[^"]*${state}"[^>]*>(.*?)</label>`, "g"))].map((m) =>
    m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  );

const PTW_I = { code: "PTW(I)", specs: { softwareMode: "integrated" as const } };
const PTW_S = { code: "PTW(S)", specs: { softwareMode: "standalone" as const } };
const ANT_V6 = { code: "ANT-V6", specs: { pathworksModule: "ANT_V6" as const } };

describe("resolveForm", () => {
  it("resolves every form the catalogue can name", () => {
    expect(resolveForm("M_SERIES")?.id).toBe("m-series");
    expect(resolveForm("EASYLOADER")?.id).toBe("easyloader");
    expect(resolveForm("FABRICPRO")?.id).toBe("fabricpro");
  });

  // `applyScreenSideToQuote` writes a screen side to exactly the items this
  // returns a form for. Software modules, services and a cutter whose form
  // has not been built yet all carry no `Product.form`; a screen side is a
  // fact about a thing an operator stands in front of, and none of these is.
  it("resolves nothing for a product with no form", () => {
    expect(resolveForm(null)).toBeNull();
    expect(resolveForm(undefined)).toBeNull();
  });
});

describe("specSchemaForForm", () => {
  it("returns the M-Series schema for the M-Series form", () => {
    expect(specSchemaForForm("M_SERIES")).toBeDefined();
  });

  it("returns null for an item with no form", () => {
    expect(specSchemaForForm(null)).toBeNull();
  });

  // The path `setProductionSpec` actually takes: look the schema up by the
  // item's product's form, then parse whatever the editor sent. The editor
  // sends one field spread over the spec already stored, so on an M-Series
  // item that has none yet the very first choice a manager makes -- a knife
  // size, from the top of the panel -- arrives as this. It has to be
  // storable; the download button stays disabled on `missingRequirements`
  // until the rest of the form is answered.
  it("stores the first field chosen on an M-Series item with no spec yet", () => {
    const form = resolveForm("M_SERIES")!;
    const result = specSchemaForForm("M_SERIES")!.safeParse({ knifeSize: "1.5x5.0" });
    expect(result.success).toBe(true);
    expect(missingRequirements(form, result.success && result.data)).toEqual([]);
  });
});

// The M-Series, EasyLoader and FabricPro all moved off the workbook
// (2026-09-16): `buildPatches` is an `XlsxFormSpec`-only concern now, so the
// generic engine behaviour it used to be exercised against on those forms is
// checked here against EasyFeed, which is still xlsx and shares the same header
// and crate-tick helpers every remaining xlsx form uses (see
// `specs/shared-header.ts`). Anything specific to the EasyLoader or
// FabricPro layouts is checked directly against the rendered component that
// owns it now (see the "EasyLoader form" and "FabricPro form" blocks below,
// and tests/table-forms-render.test.tsx).
const easyFeedItem = (overrides: Partial<FormItem> = {}) =>
  formItem({
    id: "i",
    code: "EF-2420",
    name: "EasyFeed 2420",
    kind: "ACCESSORY",
    form: "EASYFEED",
    specs: { tableWidthMm: 2420 },
    spec: {},
    ...overrides,
  });

describe("buildPatches", () => {
  it("writes X into every tick cell", () => {
    const patches = buildPatches(xlsxForm("EASYFEED"), formContext({ item: easyFeedItem() }));
    expect(patches.find((p) => p.cell === "J28")?.value).toBe("X");
  });

  it("ticks nothing for an option with no role", () => {
    const patches = buildPatches(
      xlsxForm("EASYFEED"),
      formContext({ item: easyFeedItem({ options: [formOption("Crate-EF", null)] }) }),
    );
    expect(patches.map((p) => p.cell)).not.toContain("D60");
  });

  it("omits value cells whose source is empty", () => {
    const patches = buildPatches(
      xlsxForm("EASYFEED"),
      formContext({
        item: easyFeedItem(),
        company: { name: "Relaxvanguard", addressLines: [], industry: null },
      }),
    );
    const cells = patches.map((p) => p.cell);
    expect(cells).not.toContain("I15");
    expect(cells).not.toContain("I23");
  });
});

describe("pathWorksTicked", () => {
  const ptwI = PATHWORKS_BOXES.find((box) => box.role === "PTW_I")!;
  const antV6 = PATHWORKS_BOXES.find((box) => box.role === "ANT_V6")!;

  it("ticks from the option line on the machine itself", () => {
    const ctx = formContext({ item: formItem({ options: [formOption("PDG", "PDG")] }) });
    expect(pathWorksTicked(ctx, PATHWORKS_BOXES.find((box) => box.role === "PDG")!)).toBe(true);
  });

  it("ticks PathWorks modules only alongside the integrated PathWorks", () => {
    const withIntegrated = formContext({ software: [PTW_I, ANT_V6] });
    expect(pathWorksTicked(withIntegrated, antV6)).toBe(true);

    const withStandalone = formContext({ software: [PTW_S, ANT_V6] });
    expect(pathWorksTicked(withStandalone, antV6)).toBe(false);

    const moduleAlone = formContext({ software: [ANT_V6] });
    expect(pathWorksTicked(moduleAlone, antV6)).toBe(false);
  });

  it("ticks PTW-I itself from the integrated software product alone", () => {
    const ctx = formContext({ software: [PTW_I] });
    expect(pathWorksTicked(ctx, ptwI)).toBe(true);
  });
});

describe("unmatchedOptions", () => {
  const mSeries = resolveForm("M_SERIES")!;

  it("returns the option lines themselves, so the route can match by id", () => {
    const context = formContext({ item: formItem({ options: [formOption("EDS-500", "EDS", { qty: 3 })] }) });
    expect(unmatchedOptions(mSeries, context)).toEqual([
      { id: "opt-EDS-500", code: "EDS-500", role: "EDS", qty: 3, attributes: null },
    ]);
  });

  it("reports nothing when every option has a box", () => {
    const context = formContext({
      item: formItem({ options: [formOption("ABR-M", "ABR"), formOption("HDC-M", "HDC"), formOption("MTS", "MTS")] }),
    });
    expect(unmatchedOptionCodes(mSeries, context)).toEqual([]);
  });

  it("reports an option whose role has no box on this form", () => {
    const context = formContext({ item: formItem({ options: [formOption("ABR-M", "ABR"), formOption("EDS-500", "EDS")] }) });
    expect(unmatchedOptionCodes(mSeries, context)).toEqual(["EDS-500"]);
  });

  it("reports an option with no role at all", () => {
    const context = formContext({ item: formItem({ options: [formOption("1.0mm dia punch", null)] }) });
    expect(unmatchedOptionCodes(mSeries, context)).toEqual(["1.0mm dia punch"]);
  });

  it("does not treat a tick driven by the production spec as covering an option", () => {
    // The L_TOOL role exists in the catalogue, but the M-Series form has no
    // box for it -- only its knife size row, which comes from the spec.
    const context = formContext({ item: formItem({ options: [formOption("1.0mm dia punch", "L_TOOL")] }) });
    expect(unmatchedOptionCodes(mSeries, context)).toEqual(["1.0mm dia punch"]);
  });
});

describe("missingRequirements", () => {
  const mSeries = resolveForm("M_SERIES")!;

  it("reports nothing for a complete spec", () => {
    expect(missingRequirements(mSeries, formItem().spec)).toEqual([]);
  });

  it("reports every requirement when the spec is empty", () => {
    // "ui" is not among them: screenSideSchema defaults to -Y, so it can
    // never be missing.
    expect(missingRequirements(mSeries, {})).toEqual(["knifeSize"]);
  });

  it("reports drills when they are required with no detail", () => {
    const spec = { ui: "+Y", knifeSize: "1.5x5.0", drills: { required: true, detail: "" } };
    expect(missingRequirements(mSeries, spec)).toEqual(["drills"]);
  });
});

// The EasyLoader is drawn by `EasyLoaderForm` now, not patched into a
// workbook (2026-09-16) -- see src/lib/production-forms/specs/easyloader.ts.
// Its tick-by-tick layout is exercised in tests/table-forms-render.test.tsx
// and its synchronisation default in tests/standard-fitment.test.ts; what is
// left to check here is the roll-holder tick reading the option's role
// rather than its code, the crate tick, and coverage (`unmatchedOptions`),
// none of which needs a rendered page's exact cell positions.
describe("EasyLoader form", () => {
  const easyLoader = resolveForm("EASYLOADER")!;
  const elItem = (overrides: Partial<FormItem> = {}) =>
    formItem({
      id: "i",
      code: "EL-2420",
      name: "EasyLoader 2420",
      kind: "TABLE",
      form: "EASYLOADER",
      specs: { tableWidthMm: 2420 },
      spec: { ui: "-Y", usage: "onload", sections: [] },
      ...overrides,
    });
  const renderEl = (item: FormItem) => renderToStaticMarkup(FormDocument({ children: EasyLoaderForm({ ctx: formContext({ item }) }) }));

  it("requires only usage -- screen side defaults and an empty section list means one undivided table", () => {
    expect(missingRequirements(easyLoader, {})).toEqual(["usage"]);
  });

  it("ticks the roll holder box from the option's role, whatever its width-specific code", () => {
    const holder = "ST620 Roll Holder- Used to dispense perforated underlay paper.";
    for (const code of [`EL-2020 #${holder}`, `EL-2420 ${holder}`]) {
      const item = elItem({ options: [formOption(code, "EL_ROLL_HOLDER")] });
      expect(marked(renderEl(item), "pf-on"), code).toContain(
        "Perforated paper roll holder attachment — with bar and cones"
      );
    }
  });

  it("ticks the crate box from its role", () => {
    const item = elItem({ options: [formOption("Crate-EL", "CRATE")] });
    expect(marked(renderEl(item), "pf-on")).toContain(
      "Wooden crate — built and packed by production"
    );
  });

  it("does not report the crate or roll holder as unmapped options", () => {
    const context = formContext({
      item: elItem({
        options: [formOption("Crate-EL", "CRATE"), formOption("EL-2420 ST620-2420 Roll Holder", "EL_ROLL_HOLDER")],
      }),
    });
    expect(unmatchedOptionCodes(easyLoader, context)).toEqual([]);
  });
});

// The FabricPro is drawn by `FabricProForm` now, not patched into a workbook
// (2026-09-16) -- see src/lib/production-forms/specs/fabricpro.ts. Its
// model, screen side, rail-length and standard-fitment ticks are exercised
// in tests/table-forms-render.test.tsx; what is left to check here is that
// it asks for nothing (screen side defaults) and ticks its crate from the
// option's role.
describe("FabricPro form", () => {
  const fabricPro = resolveForm("FABRICPRO")!;
  const fpItem = (overrides: Partial<FormItem> = {}) =>
    formItem({
      id: "i",
      code: "FP-220",
      name: "FabricPro 220",
      kind: "SPREADER",
      form: "FABRICPRO",
      specs: { cutWidthCm: 220, widthCode: 220 },
      spec: { ui: "+Y" },
      ...overrides,
    });

  it("requires nothing -- screen side defaults to -Y", () => {
    expect(missingRequirements(fabricPro, {})).toEqual([]);
  });

  it("ticks the crate box from its role", () => {
    const item = fpItem({ options: [formOption("Crate-FP", "CRATE")] });
    const html = renderToStaticMarkup(FormDocument({ children: FabricProForm({ ctx: formContext({ item }) }) }));
    expect(marked(html, "pf-on")).toContain("Wooden crate — built and packed by production");
  });
});

// `coversOptions` names the EasyLoader's table-module roles, which have no
// tick of their own -- the section rows and the printed total already
// represent them. Without it they would be reported unmatched and printed
// again on the Additional items sheet. This is coverage logic, not layout,
// so it is checked against `resolveForm`/`unmatchedOptions` directly.
describe("coversOptions", () => {
  const easyLoader = resolveForm("EASYLOADER")!;
  const elItem = (extra: FormItem["options"] = []) =>
    formItem({
      id: "i",
      code: "EL-2420",
      name: "EasyLoader 2420",
      kind: "TABLE",
      form: "EASYLOADER",
      specs: { tableWidthMm: 2420 },
      spec: { ui: "-Y", usage: "onload", sections: [] },
      options: [
        formOption("EL-2420 Additional 1.2M lengths", "EL_CONVEYOR", { qty: 6 }),
        formOption("EL-2420 Static table 1.2M lengths", "EL_STATIC", { qty: 2 }),
        formOption("EL-2420 Drive Module (first 1.2M)", "EL_DRIVE"),
        formOption("EL-2420 Busbar", "EL_BUSBAR", { qty: 9 }),
        formOption("EL-2420 Rail", "EL_RAIL", { qty: 9 }),
        ...extra,
      ],
    });

  it("does not report the table module options as unmatched", () => {
    // They have no tick of their own -- the section rows and the printed
    // total are how the form states them -- so without coversOptions they
    // would be printed again on the Additional items sheet.
    expect(unmatchedOptionCodes(easyLoader, formContext({ item: elItem() }))).toEqual([]);
  });

  it("still reports an option the form genuinely has no place for", () => {
    const context = formContext({ item: elItem([formOption("EDS-500", "EDS")]) });
    expect(unmatchedOptionCodes(easyLoader, context)).toEqual(["EDS-500"]);
  });
});
