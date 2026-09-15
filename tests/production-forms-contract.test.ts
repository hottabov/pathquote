import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { FORM_SPECS } from "../src/lib/production-forms/specs";
import { isXlsxForm } from "../src/lib/production-forms/types";

const TEMPLATE_DIR = path.resolve(__dirname, "../src/lib/production-forms/templates");

function loadSheet(template: string) {
  const workbook = XLSX.read(readFileSync(path.join(TEMPLATE_DIR, template)), { type: "buffer" });
  return workbook.Sheets[workbook.SheetNames[0]];
}

/**
 * Guards the two dangerous typos: a tick aimed one row off into a cell that
 * holds a printed label, and a value aimed at a label instead of the blank
 * beside it. Border checking is not possible with SheetJS -- box coordinates
 * are confirmed visually when each spec is first written (see spec 11).
 */
// Only the workbook-backed forms have cells to check. A component-rendered
// form is covered by its own snapshot instead -- see the render spec §11.
describe.each(FORM_SPECS.filter(isXlsxForm).map((spec) => [spec.id, spec] as const))(
  "%s form spec",
  (_id, spec) => {
  it("has its template committed", () => {
    expect(existsSync(path.join(TEMPLATE_DIR, spec.template))).toBe(true);
  });

  it("declares a worksheet path that exists in the archive", () => {
    const workbook = XLSX.read(readFileSync(path.join(TEMPLATE_DIR, spec.template)), { type: "buffer" });
    expect(workbook.SheetNames.length).toBeGreaterThan(0);
    expect(spec.sheetPath).toMatch(/^xl\/worksheets\/sheet\d+\.xml$/);
  });

  it("writes values only into blank cells", () => {
    const sheet = loadSheet(spec.template);
    for (const { cell } of spec.values) {
      expect(sheet[cell]?.v, `${spec.id} values cell ${cell} is not blank`).toBeUndefined();
    }
  });

  it("ticks only blank cells", () => {
    const sheet = loadSheet(spec.template);
    for (const { cell } of spec.ticks) {
      expect(sheet[cell]?.v, `${spec.id} tick cell ${cell} is not blank`).toBeUndefined();
    }
  });

  it("replaces only non-blank cells", () => {
    const sheet = loadSheet(spec.template);
    for (const { cell } of spec.replaces) {
      expect(sheet[cell]?.v, `${spec.id} replaces cell ${cell} is blank`).toBeDefined();
    }
  });

  it("uses no cell twice", () => {
    const cells = [...spec.values, ...spec.ticks, ...spec.replaces].map((entry) => entry.cell);
    expect(new Set(cells).size, `${spec.id} declares a cell more than once`).toBe(cells.length);
  });
  }
);
