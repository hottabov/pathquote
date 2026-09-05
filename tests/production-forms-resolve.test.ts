import { describe, it, expect } from "vitest";
import {
  resolveForm,
  specSchemaForForm,
  buildPatches,
  missingRequirements,
  unmatchedOptions,
} from "../src/lib/production-forms/resolve";
import type { FormContext, FormItem, FormSpec } from "../src/lib/production-forms/types";
import { formContext, formItem, formOption } from "./helpers/fixtures";

/** The codes of the options a form has no box for -- what the Additional
 * items sheet prints. The route matches the lines by id; the tests read the
 * codes because that is what a person recognises. */
const unmatchedOptionCodes = (spec: FormSpec, ctx: FormContext) =>
  unmatchedOptions(spec, ctx).map((option) => option.code);

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
    expect(missingRequirements(form, result.success && result.data)).toEqual(["drills"]);
  });
});

describe("buildPatches", () => {
  it("ticks the model and width boxes from the product's specs", () => {
    const patches = buildPatches(resolveForm("M_SERIES")!, formContext());
    const cells = patches.map((p) => p.cell);
    expect(cells).toContain("J25");
    expect(cells).toContain("J29");
    expect(cells).not.toContain("H25");
  });

  it("ticks every model and width the form prints", () => {
    const expectModel = (modelTier: string, widthCode: number, model: string, width: string) => {
      const item = formItem({ specs: { modelTier, widthCode } });
      const cells = buildPatches(resolveForm("M_SERIES")!, formContext({ item })).map((p) => p.cell);
      expect(cells, `${modelTier} ${widthCode}`).toContain(model);
      expect(cells, `${modelTier} ${widthCode}`).toContain(width);
    };
    expectModel("M3", 180, "H25", "H29");
    expectModel("M5", 220, "J25", "J29");
    expectModel("M7", 300, "L25", "L29");
    expectModel("M10", 390, "O25", "O29");
  });

  it("ticks no model or width box for a product with no specs", () => {
    const cells = buildPatches(resolveForm("M_SERIES")!, formContext({ item: formItem({ specs: {} }) })).map(
      (p) => p.cell,
    );
    for (const cell of ["H25", "J25", "L25", "O25", "H29", "J29", "L29", "O29"]) {
      expect(cells).not.toContain(cell);
    }
  });

  it("writes X into every tick cell", () => {
    const patches = buildPatches(resolveForm("M_SERIES")!, formContext());
    expect(patches.find((p) => p.cell === "J25")?.value).toBe("X");
  });

  it("ticks an option against its role's box, whatever its catalogue code", () => {
    // ABR-M and ABR-X both carry role ABR; the code is not consulted.
    const patches = buildPatches(
      resolveForm("M_SERIES")!,
      formContext({ item: formItem({ options: [formOption("ABR-M", "ABR"), formOption("HDC-X", "HDC")] }) }),
    );
    const cells = patches.map((p) => p.cell);
    expect(cells).toContain("J52");
    expect(cells).toContain("F52");
  });

  it("ticks nothing for an option with no role", () => {
    const patches = buildPatches(
      resolveForm("M_SERIES")!,
      formContext({ item: formItem({ options: [formOption("ABR-M", null)] }) }),
    );
    expect(patches.map((p) => p.cell)).not.toContain("J52");
  });

  it("ticks PathWorks modules only alongside the integrated PathWorks", () => {
    const withIntegrated = buildPatches(
      resolveForm("M_SERIES")!,
      formContext({ software: [PTW_I, ANT_V6] }),
    ).map((p) => p.cell);
    expect(withIntegrated).toContain("J64");

    const withStandalone = buildPatches(
      resolveForm("M_SERIES")!,
      formContext({ software: [PTW_S, ANT_V6] }),
    ).map((p) => p.cell);
    expect(withStandalone).not.toContain("J64");

    const moduleAlone = buildPatches(resolveForm("M_SERIES")!, formContext({ software: [ANT_V6] })).map(
      (p) => p.cell,
    );
    expect(moduleAlone).not.toContain("J64");
  });

  it("omits value cells whose source is empty", () => {
    const patches = buildPatches(
      resolveForm("M_SERIES")!,
      formContext({ company: { name: "Relaxvanguard", addressLines: [], industry: null } }),
    );
    const cells = patches.map((p) => p.cell);
    expect(cells).not.toContain("H14");
    expect(cells).not.toContain("H21");
  });

  it("writes the MTS metres attribute as a string", () => {
    const patches = buildPatches(
      resolveForm("M_SERIES")!,
      formContext({ item: formItem({ options: [formOption("MTS", "MTS", { attributes: { metres: 14 } })] }) }),
    );
    expect(patches.find((p) => p.cell === "M73")?.value).toBe("14");
    expect(patches.map((p) => p.cell)).toContain("D72");
  });
});

describe("unmatchedOptions", () => {
  it("returns the option lines themselves, so the route can match by id", () => {
    const context = formContext({ item: formItem({ options: [formOption("EDS-500", "EDS", { qty: 3 })] }) });
    expect(unmatchedOptions(resolveForm("M_SERIES")!, context)).toEqual([
      { id: "opt-EDS-500", code: "EDS-500", role: "EDS", qty: 3, attributes: null },
    ]);
  });

  it("reports nothing when every option has a box", () => {
    const context = formContext({
      item: formItem({ options: [formOption("ABR-M", "ABR"), formOption("HDC-M", "HDC"), formOption("MTS", "MTS")] }),
    });
    expect(unmatchedOptionCodes(resolveForm("M_SERIES")!, context)).toEqual([]);
  });

  it("reports an option whose role has no box on this form", () => {
    const context = formContext({ item: formItem({ options: [formOption("ABR-M", "ABR"), formOption("EDS-500", "EDS")] }) });
    expect(unmatchedOptionCodes(resolveForm("M_SERIES")!, context)).toEqual(["EDS-500"]);
  });

  it("reports an option with no role at all", () => {
    const context = formContext({ item: formItem({ options: [formOption("1.0mm dia punch", null)] }) });
    expect(unmatchedOptionCodes(resolveForm("M_SERIES")!, context)).toEqual(["1.0mm dia punch"]);
  });

  it("does not treat a tick driven by the production spec as covering an option", () => {
    // The L_TOOL role exists in the catalogue, but the M-Series form has no
    // box for it -- only its knife size row, which comes from the spec.
    const context = formContext({ item: formItem({ options: [formOption("1.0mm dia punch", "L_TOOL")] }) });
    expect(unmatchedOptionCodes(resolveForm("M_SERIES")!, context)).toEqual(["1.0mm dia punch"]);
  });
});

describe("missingRequirements", () => {
  it("reports nothing for a complete spec", () => {
    expect(missingRequirements(resolveForm("M_SERIES")!, formItem().spec)).toEqual([]);
  });

  it("reports every requirement when the spec is empty", () => {
    // "ui" is not among them: screenSideSchema defaults to -Y, so it can
    // never be missing.
    expect(missingRequirements(resolveForm("M_SERIES")!, {})).toEqual(["knifeSize", "drills"]);
  });

  it("reports drills when they are required with no detail", () => {
    const spec = { ui: "+Y", knifeSize: "1.5x5.0", drills: { required: true, detail: "" } };
    expect(missingRequirements(resolveForm("M_SERIES")!, spec)).toEqual(["drills"]);
  });
});

describe("EasyLoader form", () => {
  const elItem = (overrides: Partial<FormItem> = {}) =>
    formItem({
      id: "i",
      code: "EL-2420",
      name: "EasyLoader 2420",
      kind: "TABLE",
      form: "EASYLOADER",
      specs: { tableWidthMm: 2420 },
      spec: { ui: "-Y", usage: "onload", sections: [{ lengthM: 2.4, surface: "static" }] },
      ...overrides,
    });
  const form = resolveForm("EASYLOADER")!;

  it("ticks the printed width box for a standard model", () => {
    const cells = buildPatches(form, formContext({ item: elItem() })).map((p) => p.cell);
    expect(cells).toContain("I33");
    expect(cells).not.toContain("I35");

    const narrow = buildPatches(form, formContext({ item: elItem({ specs: { tableWidthMm: 2020 } }) })).map(
      (p) => p.cell,
    );
    expect(narrow).toContain("I31");
    expect(narrow).not.toContain("I35");
  });

  it("ticks Custom and rewrites the label for a non-standard width", () => {
    const item = elItem({ code: "EL-3220", specs: { tableWidthMm: 3220 }, spec: { ...elItem().spec, customWidthMm: 3220 } });
    const patches = buildPatches(form, formContext({ item }));
    expect(patches.find((p) => p.cell === "I35")?.value).toBe("X");
    expect(patches.find((p) => p.cell === "J35")?.value).toContain("3220mm");
  });

  it("ticks Custom for a table whose width is not recorded", () => {
    const cells = buildPatches(form, formContext({ item: elItem({ specs: {} }) })).map((p) => p.cell);
    expect(cells).toContain("I35");
  });

  it("writes each table section length and surface", () => {
    const item = elItem({
      spec: {
        ...elItem().spec,
        sections: [
          { lengthM: 2.4, surface: "static" },
          { lengthM: 1.2, surface: "conveyor" },
        ],
      },
    });
    const patches = buildPatches(form, formContext({ item }));
    expect(patches.find((p) => p.cell === "I43")?.value).toBe("2.4");
    expect(patches.find((p) => p.cell === "I45")?.value).toBe("X");
    expect(patches.find((p) => p.cell === "I47")?.value).toBe("1.2");
    expect(patches.find((p) => p.cell === "K49")?.value).toBe("X");
  });

  it("requires only usage -- screen side defaults and an empty section list means one undivided table", () => {
    expect(missingRequirements(form, {})).toEqual(["usage"]);
  });

  it("ticks the roll holder box from the option's role, whatever its width-specific code", () => {
    const holder = "ST620 Roll Holder- Used to dispense perforated underlay paper.";
    for (const code of [`EL-2020 #${holder}`, `EL-2420 ${holder}`]) {
      const item = elItem({ options: [formOption(code, "EL_ROLL_HOLDER")] });
      expect(buildPatches(form, formContext({ item })).map((p) => p.cell), code).toContain("D69");
    }
  });

  it("ticks the sync and crate boxes from their roles", () => {
    const item = elItem({ options: [formOption("Crate-EL", "CRATE"), formOption("EL-2420 Sync", "EL_SYNC")] });
    const cells = buildPatches(form, formContext({ item })).map((p) => p.cell);
    expect(cells).toContain("D71");
    expect(cells).toContain("D56");
  });

  it("does not report the crate or roll holder as unmapped options", () => {
    const item = elItem({
      options: [formOption("Crate-EL", "CRATE"), formOption("EL-2420 ST620-2420 Roll Holder", "EL_ROLL_HOLDER")],
    });
    expect(unmatchedOptionCodes(form, formContext({ item }))).toEqual([]);
  });

  // Added up from the sections rather than from the options sold: the
  // options are now derived from the sections, so the layout is the only
  // number there is.
  it("prints the total table length at M54, added up from the sections", () => {
    const item = elItem({
      spec: {
        ...elItem().spec,
        sections: [
          { lengthM: 7.2, surface: "conveyor" },
          { lengthM: 2.4, surface: "static" },
        ],
      },
    });
    const patches = buildPatches(form, formContext({ item }));
    expect(patches.find((p) => p.cell === "M54")?.value).toBe("Total Table is 9.6 m");
  });

  it("omits the M54 total for a table with no modules", () => {
    const item = elItem({ spec: { ...elItem().spec, sections: [] } });
    const patches = buildPatches(form, formContext({ item }));
    expect(patches.find((p) => p.cell === "M54")).toBeUndefined();
  });
});

describe("FabricPro form", () => {
  const fpItem = (overrides: Partial<FormItem> = {}) =>
    formItem({
      id: "i",
      code: "FP-220",
      name: "FabricPro 220",
      kind: "SPREADER",
      form: "FABRICPRO",
      specs: { cutWidthCm: 220, widthCode: 220 },
      spec: { ui: "+Y", travelPlatform: true, railLengthM: 6 },
      ...overrides,
    });
  const form = resolveForm("FABRICPRO")!;

  it("ticks the model, screen side and travel platform", () => {
    const cells = buildPatches(form, formContext({ item: fpItem() })).map((p) => p.cell);
    expect(cells).toEqual(expect.arrayContaining(["J27", "O41", "J44", "J46"]));
  });

  it("ticks one model box per width family", () => {
    const cellFor = (widthCode: number) =>
      buildPatches(form, formContext({ item: fpItem({ specs: { widthCode } }) }))
        .map((p) => p.cell)
        .filter((cell) => ["H27", "J27", "M27"].includes(cell));
    expect(cellFor(180)).toEqual(["H27"]);
    expect(cellFor(220)).toEqual(["J27"]);
    expect(cellFor(300)).toEqual(["M27"]);
  });

  it("ticks no model box for a spreader whose width is not recorded", () => {
    const cells = buildPatches(form, formContext({ item: fpItem({ specs: {} }) })).map((p) => p.cell);
    expect(cells).not.toEqual(expect.arrayContaining(["H27"]));
    expect(cells).not.toEqual(expect.arrayContaining(["J27"]));
    expect(cells).not.toEqual(expect.arrayContaining(["M27"]));
  });

  it("writes the travel rail length", () => {
    const patches = buildPatches(form, formContext({ item: fpItem() }));
    expect(patches.find((p) => p.cell === "N46")?.value).toBe("6");
  });

  it("requires nothing -- screen side defaults to -Y", () => {
    expect(missingRequirements(form, {})).toEqual([]);
  });
});

describe("coversOptions", () => {
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
  const form = resolveForm("EASYLOADER")!;

  it("does not report the table module options as unmatched", () => {
    // They have no tick of their own -- the section rows and the printed
    // total are how the form states them -- so without coversOptions they
    // would be printed again on the Additional items sheet.
    expect(unmatchedOptionCodes(form, formContext({ item: elItem() }))).toEqual([]);
  });

  it("still reports an option the form genuinely has no place for", () => {
    const context = formContext({ item: elItem([formOption("EDS-500", "EDS")]) });
    expect(unmatchedOptionCodes(form, context)).toEqual(["EDS-500"]);
  });
});
