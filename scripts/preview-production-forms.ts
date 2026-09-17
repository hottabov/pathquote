/**
 * Renders every production form spec against a full sample context and
 * writes the patched workbooks to a directory, so each page can be converted
 * and checked by eye.
 *
 *   OUT=/tmp/forms npx tsx scripts/preview-production-forms.ts
 *   soffice --headless --convert-to pdf --outdir /tmp/forms /tmp/forms/*.xlsx
 *
 * This is not a nicety. The design spec (docs/specs/2026-09-01-production-
 * order-forms-design.md §8) requires one printed page per new form to be
 * looked at before it ships, because the contract test cannot see the two
 * failures that actually happen: a value written into the cell a label
 * overflows into, and a tick one row off its box. Both are invisible in the
 * spreadsheet and obvious on the page.
 *
 * It earned its keep immediately: it showed that the HDRF "HDRF 320" box is
 * M28 and not the narrow column its two neighbours use, and that the Leather
 * Nesting Station's address block has two rows rather than three.
 */
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { FORM_SPECS } from "@/lib/production-forms/specs";
import { buildPatches } from "@/lib/production-forms/resolve";
import { patchWorkbook } from "@/lib/production-forms/xlsx-patch";
import { isXlsxForm } from "@/lib/production-forms/types";
import type { FormContext } from "@/lib/production-forms/types";

const OUT = process.env.OUT ?? path.join(process.cwd(), ".preview-forms");
const TEMPLATES = path.join(process.cwd(), "src/lib/production-forms/templates");

/** Long enough in every field to show clipping where a cell is too narrow. */
function sampleContext(
  form: string,
  specs: Record<string, unknown>,
  spec: Record<string, unknown> = {}
): FormContext {
  return {
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
    deliveryAddressLines: [
      "Bilt Automotive Trim — Plant 2",
      "8 Dohertys Road, Altona North",
      "VIC 3025, Australia",
    ],
    software: [],
    softwareCodes: [],
    rails: null,
    item: {
      id: "preview",
      code: "SAMPLE",
      name: "Sample",
      kind: "MACHINE",
      form,
      specs,
      spec,
      options: [{ id: "crate", code: "Crate", role: "CRATE", qty: 1, attributes: null }],
      optionCodes: ["Crate"],
      optionAttributes: {},
      optionQtys: [{ code: "Crate", qty: 1 }],
    },
  } as unknown as FormContext;
}

/** One representative configuration per form. */
const CASES: Record<string, FormContext> = {
  punchline: sampleContext("PUNCHLINE", { widthCode: 220 }, { exWorks: true }),
  "fabric-trolley": sampleContext("FP_TROLLEY", {}),
  "leather-nesting": sampleContext("LNS", {}),
};

mkdirSync(OUT, { recursive: true });

for (const spec of FORM_SPECS) {
  const context = CASES[spec.id];
  if (!isXlsxForm(spec)) {
    console.log(`${spec.id}: rendered as a component, nothing to patch`);
    continue;
  }
  if (!context) {
    console.log(`${spec.id}: no preview case, skipped`);
    continue;
  }
  const patches = buildPatches(spec, context);
  const template = new Uint8Array(readFileSync(path.join(TEMPLATES, spec.template)));
  writeFileSync(path.join(OUT, `${spec.id}.xlsx`), patchWorkbook(template, spec.sheetPath, patches));
  console.log(`${spec.id}: ${patches.length} patches -> ${spec.id}.xlsx`);
}
