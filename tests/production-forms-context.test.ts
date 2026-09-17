import { describe, it, expect } from "vitest";
import { buildFormContexts, companyAddressLines } from "../src/lib/production-forms/context";

const baseDocument = {
  id: "doc1",
  number: "Q-AU-2026-001",
  entitySnapshot: { entityName: "Pathfinder Australia Pty Ltd" },
  region: { entityName: "Pathfinder Australia Pty Ltd" },
  author: { name: "Vadym H" },
  company: {
    name: "Relaxvanguard",
    street: "12 Industrial Drive",
    city: "Dandenong South",
    state: "VIC",
    postcode: "3175",
    country: "AU",
    deliverySameAsMain: true,
    deliveryStreet: null,
    deliveryCity: null,
    deliveryState: null,
    deliveryPostcode: null,
    deliveryCountry: null,
    industry: { name: "Automotive" },
  },
  contact: { firstName: "John", lastName: "Smith", position: "Manager", phone: "+61 3", email: "j@e.com" },
  items: [
    {
      id: "item1",
      code: "M5220",
      name: "M-Series",
      lineGroup: 1,
      productionSpec: { ui: "+Y" },
      product: {
        kind: "MACHINE",
        form: "M_SERIES",
        specs: { cutHeightCm: 5, cutWidthCm: 227, widthCode: 220, modelTier: "M5" },
      },
      lines: [
        { kind: "OPTION", refId: "opt-mts", code: "MTS", name: "Machine Transfer System", qty: 1, attributes: { metres: 14 } },
        { kind: "OPTION", refId: "opt-abr", code: "ABR-M", name: "Air Brush", qty: 1, attributes: null },
      ],
    },
    {
      id: "item2",
      code: "PTW(I)",
      name: "PathWorks Integrated",
      lineGroup: 1,
      productionSpec: null,
      product: { kind: "SOFTWARE", form: null, specs: { softwareMode: "integrated" } },
      lines: [],
    },
    {
      id: "item3",
      code: "SERVICE",
      name: "Service",
      lineGroup: 1,
      productionSpec: null,
      product: { kind: "SERVICE", form: null, specs: null },
      lines: [],
    },
  ],
  lines: [],
  optionsById: {
    "opt-mts": { id: "opt-mts", role: "MTS", unitLengthM: null },
    "opt-abr": { id: "opt-abr", role: "ABR", unitLengthM: null },
  },
};

describe("companyAddressLines", () => {
  it("joins city, state and postcode onto one line", () => {
    expect(companyAddressLines(baseDocument.company)).toEqual([
      "12 Industrial Drive",
      "Dandenong South VIC 3175",
      "Australia",
    ]);
  });

  it("skips absent parts rather than leaving gaps", () => {
    const lines = companyAddressLines({ ...baseDocument.company, state: null, postcode: null });
    expect(lines).toEqual(["12 Industrial Drive", "Dandenong South", "Australia"]);
  });
});

describe("buildFormContexts", () => {
  it("builds one context per item whose product has a form", () => {
    const contexts = buildFormContexts(baseDocument as never);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].item.code).toBe("M5220");
  });

  it("carries the product's kind, form and specs onto the item", () => {
    const item = buildFormContexts(baseDocument as never)[0].item;
    expect(item.kind).toBe("MACHINE");
    expect(item.form).toBe("M_SERIES");
    expect(item.specs).toEqual({ cutHeightCm: 5, cutWidthCm: 227, widthCode: 220, modelTier: "M5" });
  });

  it("reads unusable specs as none rather than throwing", () => {
    const doc = {
      ...baseDocument,
      items: [{ ...baseDocument.items[0], product: { ...baseDocument.items[0].product, specs: { bogus: 1 } } }],
    };
    expect(buildFormContexts(doc as never)[0].item.specs).toEqual({});
  });

  it("gives a custom item with no product no form and the accessory kind", () => {
    const doc = {
      ...baseDocument,
      items: [{ ...baseDocument.items[0], product: null }, baseDocument.items[1]],
    };
    expect(buildFormContexts(doc as never)).toHaveLength(0);
  });

  it("takes the distributor from the frozen entity snapshot", () => {
    expect(buildFormContexts(baseDocument as never)[0].distributorName).toBe(
      "Pathfinder Australia Pty Ltd",
    );
  });

  it("falls back to the live region entity when there is no snapshot", () => {
    const doc = { ...baseDocument, entitySnapshot: null };
    expect(buildFormContexts(doc as never)[0].distributorName).toBe("Pathfinder Australia Pty Ltd");
  });

  it("joins each option line to its catalogue role", () => {
    const item = buildFormContexts(baseDocument as never)[0].item;
    expect(item.options).toEqual([
      { id: "opt-mts", code: "MTS", role: "MTS", qty: 1, attributes: { metres: 14 } },
      { id: "opt-abr", code: "ABR-M", role: "ABR", qty: 1, attributes: null },
    ]);
  });

  it("leaves an option whose catalogue row is gone with no role rather than dropping it", () => {
    const doc = { ...baseDocument, optionsById: {} };
    const item = buildFormContexts(doc as never)[0].item;
    expect(item.options.map((o) => [o.code, o.role])).toEqual([
      ["MTS", null],
      ["ABR-M", null],
    ]);
  });

  it("derives the legacy code views from the options", () => {
    const item = buildFormContexts(baseDocument as never)[0].item;
    expect(item.optionCodes).toEqual(["MTS", "ABR-M"]);
    expect(item.optionAttributes["MTS"]).toEqual({ metres: 14 });
    expect(item.optionQtys).toEqual([
      { code: "MTS", qty: 1 },
      { code: "ABR-M", qty: 1 },
    ]);
  });

  it("carries a quantity greater than one through, not just presence", () => {
    const doc = {
      ...baseDocument,
      items: [
        {
          ...baseDocument.items[0],
          lines: [
            { kind: "OPTION", refId: "opt-conv", code: "EL-2420 Additional 1.2M lengths", name: "Additional 1.2M lengths", qty: 6, attributes: null },
          ],
        },
        baseDocument.items[1],
      ],
      optionsById: { "opt-conv": { id: "opt-conv", role: "EL_CONVEYOR", unitLengthM: 1.2 } },
    };
    const item = buildFormContexts(doc as never)[0].item;
    expect(item.options).toEqual([
      { id: "opt-conv", code: "EL-2420 Additional 1.2M lengths", role: "EL_CONVEYOR", qty: 6, attributes: null },
    ]);
    expect(item.optionQtys).toEqual([{ code: "EL-2420 Additional 1.2M lengths", qty: 6 }]);
  });

  it("exposes the SOFTWARE items with their specs, and nothing else without a form", () => {
    const ctx = buildFormContexts(baseDocument as never)[0];
    expect(ctx.software).toEqual([{ code: "PTW(I)", specs: { softwareMode: "integrated" } }]);
    expect(ctx.softwareCodes).toEqual(["PTW(I)"]);
  });

});

/**
 * A FabricPro runs over one table, so each FabricPro form has to print that
 * table's rail lengths rather than every compatible table added together.
 * The manager types nothing: the pairing follows document order.
 */
describe("buildFormContexts: rails", () => {
  const el = (id: string, code: string, lengthM: number, fabricProCompatible = true) => ({
    id,
    code,
    name: "EasyLoader",
    lineGroup: 1,
    productionSpec: { fabricProCompatible, sections: [{ lengthM, surface: "conveyor" }] },
    product: { kind: "TABLE", form: "EASYLOADER", specs: {} },
    lines: [],
  });

  const fp = (id: string, code: string) => ({
    id,
    code,
    name: "FabricPro",
    lineGroup: 1,
    productionSpec: {},
    product: { kind: "SPREADER", form: "FABRICPRO", specs: { widthCode: 220 } },
    lines: [],
  });

  const railsByItem = (items: unknown[]) => {
    const contexts = buildFormContexts({ ...baseDocument, items } as never);
    return new Map(contexts.map((ctx) => [ctx.item.id, ctx.rails]));
  };

  it("gives each FabricPro the table it runs over, not the sum of both", () => {
    const rails = railsByItem([el("el1", "EL-2420", 7.2), el("el2", "EL-2020", 4.8), fp("fp1", "FP-220"), fp("fp2", "FP-180")]);

    expect(rails.get("fp1")).toEqual({ tableId: "el1", tableCode: "EL-2420", lengthM: 7.2 });
    expect(rails.get("fp2")).toEqual({ tableId: "el2", tableCode: "EL-2020", lengthM: 4.8 });
  });

  it("leaves a claimed table's own form without rails -- the FabricPro form prints them", () => {
    const rails = railsByItem([el("el1", "EL-2420", 7.2), fp("fp1", "FP-220")]);

    expect(rails.get("el1")).toBeNull();
    expect(rails.get("fp1")?.lengthM).toBe(7.2);
  });

  it("prints a third table's rails on its own form when only two FabricPros were sold", () => {
    const rails = railsByItem([
      el("el1", "EL-2420", 7.2),
      el("el2", "EL-2020", 4.8),
      el("el3", "EL-3220", 3.6),
      fp("fp1", "FP-220"),
      fp("fp2", "FP-180"),
    ]);

    expect(rails.get("el3")).toEqual({ tableId: "el3", tableCode: "EL-3220", lengthM: 3.6 });
    expect(rails.get("el1")).toBeNull();
  });

  it("skips an incompatible table: the FabricPro pairs with the next compatible one", () => {
    const rails = railsByItem([el("el1", "EL-2420", 7.2, false), el("el2", "EL-2020", 4.8), fp("fp1", "FP-220")]);

    expect(rails.get("fp1")).toEqual({ tableId: "el2", tableCode: "EL-2020", lengthM: 4.8 });
    expect(rails.get("el1")).toBeNull();
  });

  it("leaves a FabricPro with no table to run over unassigned", () => {
    const rails = railsByItem([fp("fp1", "FP-220")]);
    expect(rails.get("fp1")).toBeNull();
  });
});

describe("buildFormContexts: spec diagrams", () => {
  it("hands every context the operator-side diagrams, so each form prints the one that was chosen", () => {
    const images = { "+Y": "pq-pdf-image:plus.png", "-Y": "pq-pdf-image:minus.png" };
    const contexts = buildFormContexts(baseDocument as never, { screenSideImages: images });

    expect(contexts[0].screenSideImages).toEqual(images);
  });

  it("passes an empty map when nothing has been uploaded, rather than leaving the field undefined", () => {
    expect(buildFormContexts(baseDocument as never)[0].screenSideImages).toEqual({});
  });
});
