/**
 * Renders a component-backed order form to a standalone HTML file, so the
 * page can be checked by eye before it ever reaches a customer's workshop.
 *
 *   OUT=/tmp/forms npx tsx scripts/preview-form-html.ts
 *
 * Same purpose as scripts/preview-production-forms.ts, which does this for
 * the workbook-backed forms. Both exist until the xlsx path is deleted: this
 * is the "new" half of the side-by-side the render spec's §10 sign-off gate
 * asks production to look at.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { FormDocument } from "@/components/forms/form-sheet";
import { formComponent } from "@/components/forms/registry";
import type { FormContext } from "@/lib/production-forms/types";
import type { ProductionForm } from "@prisma/client";

const OUT = process.env.OUT ?? path.join(process.cwd(), ".preview-forms");
mkdirSync(OUT, { recursive: true });

/** A placeholder diagram: the cutter seen from above with the screen on the
 * named side. Inline SVG as a data URI so the preview needs no uploads. */
function sideDiagram(label: string): string {
  const plus = label.startsWith("+");
  const screenX = plus ? 132 : 18;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">' +
    '<rect width="180" height="180" fill="#fff"/>' +
    '<rect x="42" y="46" width="96" height="88" rx="6" fill="#e8ecf6" stroke="#9aa4bf" stroke-width="3"/>' +
    '<rect x="' + screenX + '" y="74" width="30" height="32" rx="4" fill="#1f3d7a"/>' +
    '<text x="90" y="28" font-family="Helvetica" font-size="22" text-anchor="middle" fill="#1f3d7a">' +
    label +
    "</text>" +
    "</svg>";
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

const base = {
  distributorName: "Pathfinder Australia Pty Ltd",
  authorName: "Ross Martin",
  company: {
    name: "Bilt Automotive Trim Pty Ltd",
    addressLines: ["42 Fitzgerald Road", "Laverton North VIC 3026", "Australia"],
    industry: "Automotive interiors",
  },
  contact: {
    fullName: "Daniel Whitcombe",
    position: "Production Manager",
    phone: "+61 3 9314 8800",
    email: "d.whitcombe@biltautotrim.com.au",
  },
  rails: null,
  documentNumber: "Q-AU-2026-014",
  itemIndex: 1,
  itemCount: 3,
  generatedAt: new Date("2026-09-11T00:00:00Z"),
  logo: null,
  // Stand-ins for the uploaded SpecImage pair, so the preview shows the frame
  // the real diagrams will sit in rather than a gap. The PDF route passes
  // marks here instead (see its `screenSideImages`).
  screenSideImages: {
    "+Y": sideDiagram("+Y"),
    "-Y": sideDiagram("\u2212Y"),
  },
};

const option = (code: string, role: string, qty = 1, attributes: Record<string, unknown> | null = null) => ({
  id: code,
  code,
  role,
  qty,
  attributes,
});

const CASES: Array<{ form: ProductionForm; ctx: FormContext }> = [
  {
    form: "M_SERIES",
    ctx: {
      ...base,
      software: [
        { code: "PTW-I", specs: { softwareMode: "integrated" } },
        { code: "PDG", specs: { pathworksModule: "PDG" } },
        { code: "ANT-V6", specs: { pathworksModule: "ANT_V6" } },
      ],
      softwareCodes: ["PTW-I", "PDG", "ANT-V6"],
      item: {
        id: "i1",
        code: "M-7220",
        name: "M-Series Cutting Machine 7cm × 227cm",
        kind: "MACHINE",
        form: "M_SERIES",
        specs: { modelTier: "M7", widthCode: 220, cutWidthCm: 227, cutHeightCm: 7 },
        spec: {
          ui: "-Y",
          knifeSize: "1.5x7.0",
          voltage: "415V",
          drills: { required: true, detail: "4 × Ø3 mm carbide" },
          specialNotes: "Screen side must match the EasyLoader on Line 1.",
        },
        // Every M-compatible option in the catalogue, so the preview shows
        // the fullest sheet the form can be asked to print.
        options: [
          ...[
            ["ABR-M", "ABR"], ["AFP", "AFP"], ["APM-M", "APM"], ["BCR-M", "BCR"],
            ["Crate-M-220", "CRATE"], ["DMT", "DMT"], ["DR2", "DR2"], ["DRG-1", "DRG_1"],
            ["DRG-2", "DRG_2"], ["DRG-3", "DRG_3"], ["HDC-M", "HDC"], ["HFV-M", "HFV"],
            ["IJP", "IJP"], ["IKA", "IKA"], ["MRK", "MRK"], ["OFD-M", "OFD"], ["OFJ", "OFJ"],
            ["OFP-M", "OFP"], ["PM-M", "PM"], ["PRM-M", "PRM"], ["TR220", "TRANSFORMER"],
            ["TR480", "TRANSFORMER"], ["PTW-I", "PTW_I"], ["PDG", "PDG"], ["WPL", "WPL"],
            ["ANT-V5", "ANT_V5"], ["ANT-V6", "ANT_V6"], ["LSC", "LSC"], ["PRA", "PRA"],
          ].map(([code, role]) => option(code, role)),
          option("MTS", "MTS", 1, { metres: 12 }),
          option("MTS-M", "MTS_TRAVEL", 3),
        ],
        optionCodes: [],
        optionAttributes: {},
        optionQtys: [],
      },
    } as unknown as FormContext,
  },
  {
    form: "X_CALIBRE",
    ctx: {
      ...base,
      software: [
        { code: "PTW-I", specs: { softwareMode: "integrated" } },
        { code: "PDG", specs: { pathworksModule: "PDG" } },
        { code: "ANT-V6", specs: { pathworksModule: "ANT_V6" } },
      ],
      softwareCodes: ["PTW-I", "PDG", "ANT-V6"],
      item: {
        id: "i2",
        code: "X-10220",
        name: "X-Calibre Cutting Machine 10cm × 227cm",
        kind: "MACHINE",
        form: "X_CALIBRE",
        specs: { modelTier: "X10", widthCode: 220, cutWidthCm: 227, cutHeightCm: 10 },
        spec: {
          ui: "-Y",
          voltage: "415V",
          drills: { required: true, detail: "2 × Ø5 mm carbide" },
          specialNotes: "Interface side must match the EasyLoader.",
        },
        options: [
          option("HDC-M", "HDC"),
          option("OFD-M", "OFD"),
          option("Crate-M-220", "CRATE"),
          option("MTS", "MTS", 1, { metres: 14 }),
        ],
        optionCodes: [],
        optionAttributes: {},
        optionQtys: [],
      },
    } as unknown as FormContext,
  },
  {
    form: "EASYLOADER",
    ctx: {
      ...base,
      software: [],
      softwareCodes: [],
      itemIndex: 2,
      item: {
        id: "i3",
        code: "EL-2420",
        name: "EasyLoader Spreading Table 2420 mm",
        kind: "TABLE",
        form: "EASYLOADER",
        specs: { tableWidthMm: 2420 },
        spec: {
          ui: "-Y",
          usage: "onload",
          syncWithCutter: true,
          fabricProCompatible: true,
          sections: [
            { lengthM: 4.8, surface: "conveyor" },
            { lengthM: 2.4, surface: "static" },
          ],
          rollFeedDistancesMm: [300, 1500],
        },
        options: [
          option("EL-2420-RF", "EL_ROLL_FEED", 2),
          option("ST620-2420", "EL_ROLL_HOLDER"),
          option("Crate-EL", "CRATE"),
        ],
        optionCodes: [],
        optionAttributes: {},
        optionQtys: [],
      },
    } as unknown as FormContext,
  },
  {
    form: "FABRICPRO",
    ctx: {
      ...base,
      software: [],
      softwareCodes: [],
      itemIndex: 3,
      // Paired with the EasyLoader above: one FabricPro runs over one table.
      rails: { tableId: "i3", tableCode: "EL-2420", lengthM: 7.2 },
      item: {
        id: "i4",
        code: "FP-220",
        name: "FabricPro Spreader 220",
        kind: "SPREADER",
        form: "FABRICPRO",
        specs: { widthCode: 220, cutWidthCm: 220 },
        spec: { ui: "-Y" },
        options: [option("Crate-FP", "CRATE")],
        optionCodes: [],
        optionAttributes: {},
        optionQtys: [],
      },
    } as unknown as FormContext,
  },
  {
    form: "EASYFEEDER",
    ctx: {
      ...base,
      software: [],
      softwareCodes: [],
      itemIndex: 3,
      item: {
        id: "i7",
        code: "EF-2420",
        name: "EasyFeeder 2420",
        kind: "ACCESSORY",
        form: "EASYFEEDER",
        specs: { tableWidthMm: 2420 },
        spec: {},
        options: [],
        optionCodes: [],
        optionAttributes: {},
        optionQtys: [],
      },
    } as unknown as FormContext,
  },
  {
    form: "HDRF",
    ctx: {
      ...base,
      software: [],
      softwareCodes: [],
      itemIndex: 2,
      item: {
        id: "i6",
        code: "HDRF-220",
        name: "Heavy Duty Roll Feeder 220",
        kind: "ACCESSORY",
        form: "HDRF",
        specs: { widthCode: 220 },
        spec: {},
        options: [option("Crate-HDRF-220", "CRATE")],
        optionCodes: [],
        optionAttributes: {},
        optionQtys: [],
      },
    } as unknown as FormContext,
  },
  {
    form: "L_SERIES",
    ctx: {
      ...base,
      software: [
        { code: "PTW-I", specs: { softwareMode: "integrated" } },
        { code: "PDG", specs: { pathworksModule: "PDG" } },
      ],
      softwareCodes: ["PTW-I", "PDG"],
      itemIndex: 1,
      itemCount: 1,
      documentNumber: "Q-AU-2026-033",
      item: {
        id: "i5",
        code: "L-220F",
        name: "L-Series Cutting Machine 226cm, felt belt",
        kind: "MACHINE",
        form: "L_SERIES",
        specs: { widthCode: 220, cutWidthCm: 226, belt: "felt", extended: false },
        spec: {
          ui: "-Y",
          voltage: "220/230",
          specialNotes: "2 × 30° drag blades in addition to the standard set.",
        },
        options: [
          option("RKT-28", "L_TOOL", 2),
          option("DKT-45", "L_TOOL", 1),
          option("NTT", "L_TOOL", 1),
          option("OFD-L", "OFD"),
          option("PM-L", "PM"),
          option("Crate-L-220", "CRATE"),
        ],
        optionCodes: [],
        optionAttributes: {},
        optionQtys: [],
      },
    } as unknown as FormContext,
  },
];

for (const { form, ctx } of CASES) {
  const Component = formComponent(form);
  if (!Component) {
    console.log(`${form}: no component yet, skipped`);
    continue;
  }
  const body = renderToStaticMarkup(
    FormDocument({ children: Component({ ctx }) })
  );
  const file = path.join(OUT, `${form.toLowerCase()}.html`);
  writeFileSync(file, `<!doctype html><html><head><meta charSet="utf-8"></head><body>${body}</body></html>`);
  console.log(`${form}: ${file}`);
}
