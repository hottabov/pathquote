import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EasyLoaderForm } from "../src/components/forms/easyloader-form";
import { FabricProForm } from "../src/components/forms/fabricpro-form";
import { FormDocument } from "../src/components/forms/form-sheet";
import { formComponent } from "../src/components/forms/registry";
import { coveredRoles, resolveForm } from "../src/lib/production-forms/resolve";
import { formContext, formItem } from "./helpers/fixtures";
import type { FormContext } from "../src/lib/production-forms/types";

const option = (code: string, role: string, qty = 1) => ({ id: code, code, role, qty, attributes: null }) as never;

const SECTIONS = [
  { lengthM: 4.8, surface: "conveyor" },
  { lengthM: 2.4, surface: "static" },
];

const meta = {
  documentNumber: "Q-AU-2026-014",
  itemIndex: 2,
  itemCount: 3,
  generatedAt: new Date("2026-09-11T00:00:00Z"),
  logo: null,
};

const elCtx = (spec: Record<string, unknown> = {}, options: unknown[] = [], over: Partial<FormContext> = {}) =>
  formContext({
    ...meta,
    item: formItem({
      code: "EL-2420",
      form: "EASYLOADER",
      specs: { tableWidthMm: 2420 },
      spec: { ui: "-Y", usage: "onload", sections: SECTIONS, ...spec },
      options: options as never,
    }),
    ...over,
  });

const fpCtx = (spec: Record<string, unknown> = {}, over: Partial<FormContext> = {}) =>
  formContext({
    ...meta,
    item: formItem({
      code: "FP-220",
      form: "FABRICPRO",
      specs: { widthCode: 220, cutWidthCm: 220 },
      spec: { ui: "-Y", ...spec },
      options: [],
    }),
    ...over,
  });

const renderEl = (ctx: FormContext = elCtx()) =>
  renderToStaticMarkup(FormDocument({ children: EasyLoaderForm({ ctx }) }));
const renderFp = (spec: Record<string, unknown> = {}, over: Partial<FormContext> = {}) =>
  renderToStaticMarkup(FormDocument({ children: FabricProForm({ ctx: fpCtx(spec, over) }) }));

const marked = (html: string, state: "pf-on" | "pf-std"): string[] =>
  [...html.matchAll(new RegExp(`class="pf-tick[^"]*${state}"[^>]*>(.*?)</label>`, "g"))].map((m) =>
    m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  );

describe("the EasyLoader form", () => {
  it("draws the table it was built from, and totals it", () => {
    const html = renderEl();
    expect(html).toContain(">4.8</span>");
    expect(html).toContain(">2.4</span>");
    expect(html).toContain("<b>7.2 m</b>");
  });

  it("marks the sections nobody ordered as not ordered", () => {
    const html = renderEl();
    expect(html.match(/Not ordered/g)?.length).toBe(2);
  });

  it("ticks the printed width the product is, and Custom for one with no box", () => {
    expect(marked(renderEl(), "pf-on").join(" | ")).toContain("2420 mm");

    const wide = elCtx({ customWidthMm: 3220 }, [], {
      item: formItem({
        code: "EL-3220",
        form: "EASYLOADER",
        specs: { tableWidthMm: 3220 },
        spec: { sections: SECTIONS, customWidthMm: 3220 },
      }),
    });
    expect(marked(renderEl(wide), "pf-on").join(" | ")).toContain("Custom");
  });

  it("ticks synchronisation unless a manager unticked it", () => {
    expect(marked(renderEl(), "pf-on").join(" | ")).toContain("Synchronisation");
    expect(marked(renderEl(elCtx({ syncWithCutter: false })), "pf-on").join(" | ")).not.toContain("Synchronisation");
  });

  it("prints the roll feed quantity from the option and its distances from the spec", () => {
    const html = renderEl(elCtx({ rollFeedDistancesMm: [300, 1500] }, [option("EL-2420-RF", "EL_ROLL_FEED", 2)]));
    expect(html).toContain(">2</span>");
    expect(html).toContain(">300</span>");
    expect(html).toContain(">1500</span>");
  });

  it("prints the FabricPro rails when no FabricPro claimed this table", () => {
    const unclaimed = elCtx({ fabricProCompatible: true }, [], {
      rails: { tableId: "item1", tableCode: "EL-2420", lengthM: 7.2 },
    });
    expect(renderEl(unclaimed)).toContain("FabricPro rails");
    expect(renderEl(unclaimed)).toContain("7.2 m");
  });

  it("stays silent when a FabricPro claimed this table -- that form prints them", () => {
    expect(renderEl(elCtx({ fabricProCompatible: true }))).not.toContain("FabricPro rails");
  });

  it("prints no rails for a table nobody made FabricPro compatible", () => {
    expect(renderEl()).not.toContain("FabricPro rails");
  });
});

describe("the FabricPro form", () => {
  /** The table this FabricPro was paired with -- one machine, one table. */
  const rails = { rails: { tableId: "el", tableCode: "EL-2420", lengthM: 7.2 } };

  it("takes both rail lengths from the table this machine runs over", () => {
    const html = renderFp({}, rails);
    expect(html.match(/>7\.2<\/span>/g)?.length).toBe(2);
  });

  it("names the table the lengths came from, so nobody has to guess which", () => {
    expect(renderFp({}, rails)).toContain("EL-2420");
  });

  it("prints empty rail rows when no table in the quote is FabricPro compatible", () => {
    const html = renderFp();
    expect(html).toContain("Travel platform rail");
    expect(html).not.toContain(">7.2</span>");
  });

  it("lets a typed length override one rail without touching the other", () => {
    const html = renderFp({ railLengthM: 9.6 }, rails);
    expect(html).toContain(">9.6</span>");
    expect(html).toContain(">7.2</span>");
  });

  // The delivery term is a commercial fact and the quote already states it;
  // printing it again on a build sheet invites the workshop to treat it as
  // something they set (Vadym, 2026-09-11).
  it("says nothing about Ex-Works -- the quote carries the delivery terms", () => {
    expect(renderFp({ exWorks: true })).not.toContain("Ex-Works");
  });

  it("marks the travel platform as fitted rather than asking for it", () => {
    const html = renderFp();
    expect(marked(html, "pf-std").join(" | ")).toContain("Travel platform");
    // Jeff, 2026-09-11: every machine has one, so it is never a question.
    expect(html).not.toContain("must be fitted to support the safety system");
  });

  it("no longer claims one operator side is the only one available", () => {
    expect(renderFp()).not.toContain("currently the only side available");
  });

  it("ticks the model the product is", () => {
    expect(marked(renderFp(), "pf-on").join(" | ")).toContain("FP-220");
  });
});

describe("both table forms", () => {
  it.each([
    ["EASYLOADER", EasyLoaderForm],
    ["FABRICPRO", FabricProForm],
  ] as const)("%s is registered and covers what its spec claims", (form, Component) => {
    expect(formComponent(form)).toBe(Component);
    // Coverage is what keeps a sold option off the Additional items sheet.
    expect(coveredRoles(resolveForm(form)!).size).toBeGreaterThan(0);
  });
});
