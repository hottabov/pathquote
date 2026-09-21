import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { SoftwareForm } from "../src/components/forms/software-form";
import {
  SOFTWARE_BOXES,
  softwareQty,
  unlistedSoftware,
  type SoftwareFormContext,
  type SoftwareItem,
} from "../src/lib/production-forms/software";

/**
 * The Software Order Form: one sheet per quote, a box per program the
 * catalogue sells.
 */

const catalog = JSON.parse(
  readFileSync(path.resolve(__dirname, "../prisma/seed-data/catalog.json"), "utf8")
) as { series: Array<{ seriesCode: string; products: Array<{ code: string; name: string }> }> };

const ctx = (items: SoftwareItem[]): SoftwareFormContext => ({
  distributorName: "Pathfinder Australia Pty Ltd",
  authorName: "Ross Martin",
  company: { name: "Bilt Automotive Trim Pty Ltd", addressLines: ["42 Fitzgerald Road"], industry: "Automotive" },
  contact: { fullName: "Daniel Whitcombe", position: "Production Manager", phone: "+61 3 9314 8800", email: "d@b.au" },
  documentNumber: "Q-AU-2026-043",
  generatedAt: new Date("2026-09-18T00:00:00Z"),
  logo: null,
  items,
});

const render = (items: SoftwareItem[]) => renderToStaticMarkup(<SoftwareForm ctx={ctx(items)} />);

/** The label text of every ticked box, in order. */
const marked = (html: string, cls: "pf-on" | "pf-qty") =>
  [...html.matchAll(new RegExp(`class="pf-tick[^"]*${cls}[^"]*"[^>]*>(.*?)</label>`, "g"))].map((m) =>
    m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  );

describe("the printed list", () => {
  it("has a box for every SOFTWARE product in the catalogue, and no others", () => {
    const sw = catalog.series.find((series) => series.seriesCode === "SW")!;
    expect(new Set(SOFTWARE_BOXES.map((box) => box.code))).toEqual(new Set(sw.products.map((p) => p.code)));
    expect(SOFTWARE_BOXES).toHaveLength(9);
  });

  it("names each program as the catalogue does", () => {
    const names = new Map(
      catalog.series.find((series) => series.seriesCode === "SW")!.products.map((p) => [p.code, p.name])
    );
    for (const box of SOFTWARE_BOXES) expect(box.name, box.code).toBe(names.get(box.code));
  });
});

describe("softwareQty", () => {
  it("sums the lines for one code and ignores case", () => {
    const items = [
      { code: "ptw-s", name: "PathWorks Standalone", qty: 1 },
      { code: "PTW-S", name: "PathWorks Standalone", qty: 2 },
    ];
    expect(softwareQty(items, "PTW-S")).toBe(3);
    expect(softwareQty(items, "PDG")).toBe(0);
  });
});

describe("the sheet", () => {
  it("ticks only what the quote sold", () => {
    const html = render([{ code: "PDG", name: "PhotoDigitiser", qty: 1 }]);
    expect(marked(html, "pf-on")).toEqual(["PDG PhotoDigitiser"]);
  });

  it("prints the quantity in the box for more than one licence", () => {
    const html = render([{ code: "PTW-S", name: "PathWorks Standalone", qty: 2 }]);
    expect(marked(html, "pf-qty")).toEqual(["2 PTW-S PathWorks Standalone"]);
  });

  it("ticks nothing at all when no software was sold — the blank sheet", () => {
    expect(marked(render([]), "pf-on")).toEqual([]);
    expect(render([])).toContain("Software Order Form");
  });

  it("has no machine field: the sheet belongs to the quote, not to a machine", () => {
    const html = render([{ code: "LSC", name: "LS Convert", qty: 1 }]);
    expect(html).toContain("End user");
    expect(html).not.toContain("Machine");
  });

  it("names software with no box of its own rather than dropping it", () => {
    const extra = { code: "NEW-SW", name: "Something New", qty: 1 };
    expect(unlistedSoftware([extra]).map((item) => item.code)).toEqual(["NEW-SW"]);
    const html = render([extra]);
    expect(html).toContain("Also ordered");
    expect(marked(html, "pf-on")).toEqual(["NEW-SW Something New"]);
  });

  it("prints the provenance and where machine software is ordered instead", () => {
    const html = render([]);
    expect(html).toContain("SOFTWARE · Q-AU-2026-043 · 18.09.2026");
    expect(html).toContain("Software supplied with a machine is ordered on that machine&#x27;s own form");
  });
});
