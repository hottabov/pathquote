import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { patchSheetXml, patchWorkbook } from "../src/lib/production-forms/xlsx-patch";
import { columnIndex, splitRef } from "../src/lib/production-forms/cell-ref";

const TEMPLATE = path.resolve(
  __dirname,
  "../src/lib/production-forms/templates/m-series-order-12.xlsx",
);
const SHEET = "xl/worksheets/sheet1.xml";

describe("patchSheetXml", () => {
  it("rewrites an existing cell as an inline string, keeping its style", () => {
    const xml = `<sheetData><row r="8"><c r="G8" s="42"/></row></sheetData>`;
    const out = patchSheetXml(xml, [{ cell: "G8", value: "Pathfinder" }]);
    expect(out).toContain(`<c r="G8" s="42" t="inlineStr">`);
    expect(out).toContain(`<t xml:space="preserve">Pathfinder</t>`);
  });

  it("drops an existing value from the cell it overwrites", () => {
    const xml = `<sheetData><row r="8"><c r="G8" s="42" t="s"><v>17</v></c></row></sheetData>`;
    const out = patchSheetXml(xml, [{ cell: "G8", value: "X" }]);
    expect(out).not.toContain("<v>17</v>");
    expect(out).not.toContain(`t="s"`);
  });

  it("inserts a cell that is absent, in column order", () => {
    const xml = `<sheetData><row r="8"><c r="D8"/><c r="M8"/></row></sheetData>`;
    const out = patchSheetXml(xml, [{ cell: "G8", value: "X" }]);
    const order = [...out.matchAll(/<c r="([A-Z]+8)"/g)].map((m) => m[1]);
    expect(order).toEqual(["D8", "G8", "M8"]);
  });

  it("appends a cell whose column is past every existing cell", () => {
    const xml = `<sheetData><row r="8"><c r="D8"/></row></sheetData>`;
    const out = patchSheetXml(xml, [{ cell: "M8", value: "X" }]);
    const order = [...out.matchAll(/<c r="([A-Z]+8)"/g)].map((m) => m[1]);
    expect(order).toEqual(["D8", "M8"]);
  });

  it("expands a self-closing row before inserting into it", () => {
    const xml = `<sheetData><row r="8" ht="12"/></sheetData>`;
    const out = patchSheetXml(xml, [{ cell: "G8", value: "X" }]);
    expect(out).toContain(`<row r="8" ht="12">`);
    expect(out).toContain(`<c r="G8" t="inlineStr">`);
    expect(out).toContain("</row>");
  });

  it("inserts a row that is absent, in row order", () => {
    const xml = `<sheetData><row r="5"/><row r="12"/></sheetData>`;
    const out = patchSheetXml(xml, [{ cell: "G8", value: "X" }]);
    const order = [...out.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]));
    expect(order).toEqual([5, 8, 12]);
  });

  it("escapes XML-significant characters", () => {
    const xml = `<sheetData><row r="8"><c r="G8"/></row></sheetData>`;
    const out = patchSheetXml(xml, [{ cell: "G8", value: `Smith & Sons <Pty>` }]);
    expect(out).toContain("Smith &amp; Sons &lt;Pty&gt;");
  });

  it("applies several patches to the same row", () => {
    const xml = `<sheetData><row r="25"><c r="H25"/></row></sheetData>`;
    const out = patchSheetXml(xml, [
      { cell: "H25", value: "X" },
      { cell: "J25", value: "X" },
      { cell: "O25", value: "X" },
    ]);
    const order = [...out.matchAll(/<c r="([A-Z]+25)"/g)].map((m) => m[1]);
    expect(order).toEqual(["H25", "J25", "O25"]);
  });
});

describe("patchWorkbook", () => {
  it("writes the requested values into the real template", () => {
    const patched = patchWorkbook(readFileSync(TEMPLATE), SHEET, [
      { cell: "G8", value: "Pathfinder Australia Pty Ltd" },
      { cell: "J25", value: "X" },
    ]);
    const xml = strFromU8(unzipSync(patched)[SHEET]);
    expect(xml).toContain("Pathfinder Australia Pty Ltd");
    expect(xml).toContain(`<c r="J25"`);
  });

  it("leaves the content of every other archive entry unchanged", () => {
    const original = unzipSync(readFileSync(TEMPLATE));
    const patched = unzipSync(
      patchWorkbook(readFileSync(TEMPLATE), SHEET, [{ cell: "G8", value: "Pathfinder" }]),
    );

    expect(Object.keys(patched).sort()).toEqual(Object.keys(original).sort());

    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    for (const name of Object.keys(original)) {
      if (name === SHEET) continue;
      expect(digest(patched[name]), `entry changed: ${name}`).toBe(digest(original[name]));
    }
  });

  it("preserves the embedded images and print settings", () => {
    const patched = unzipSync(
      patchWorkbook(readFileSync(TEMPLATE), SHEET, [{ cell: "G8", value: "Pathfinder" }]),
    );
    expect(patched["xl/media/image1.jpeg"]).toBeDefined();
    expect(patched["xl/printerSettings/printerSettings1.bin"]).toBeDefined();
    expect(strFromU8(patched[SHEET])).toContain("pageSetup");
  });
});


// --- was tests/cell-ref.test.ts: cell-ref helpers (src/lib/production-forms/cell-ref.ts) ------------------

describe("columnIndex", () => {
  it("maps A to 1", () => expect(columnIndex("A")).toBe(1));
  it("maps Z to 26", () => expect(columnIndex("Z")).toBe(26));
  it("maps AA to 27", () => expect(columnIndex("AA")).toBe(27));
  it("maps AZ to 52", () => expect(columnIndex("AZ")).toBe(52));
  it("orders G before M", () => expect(columnIndex("G")).toBeLessThan(columnIndex("M")));
  it("orders Z before AA", () => expect(columnIndex("Z")).toBeLessThan(columnIndex("AA")));
});

describe("splitRef", () => {
  it("splits a single-letter reference", () => {
    expect(splitRef("G8")).toEqual({ col: "G", colIndex: 7, row: 8 });
  });

  it("splits a two-letter reference", () => {
    expect(splitRef("AA108")).toEqual({ col: "AA", colIndex: 27, row: 108 });
  });

  it("throws on a malformed reference", () => {
    expect(() => splitRef("8G")).toThrow();
  });
});
