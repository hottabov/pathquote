import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EasyFeederForm } from "../src/components/forms/easyfeeder-form";
import { formComponent } from "../src/components/forms/registry";
import { formHasScreenSide, resolveForm, unmatchedOptions } from "../src/lib/production-forms/resolve";
import { formContext, formItem } from "./helpers/fixtures";

const ctx = (code: string, specs: Record<string, unknown>, options: never[] = []) =>
  formContext({
    documentNumber: "Q-AU-2026-041",
    itemIndex: 1,
    itemCount: 1,
    generatedAt: new Date("2026-09-17T00:00:00Z"),
    logo: null,
    item: formItem({ code, form: "EASYFEEDER", kind: "ACCESSORY", specs, spec: {}, options }),
  });

const render = (c: ReturnType<typeof ctx>) => renderToStaticMarkup(<EasyFeederForm ctx={c} />);

const ticked = (html: string) =>
  [...html.matchAll(/class="pf-tick[^"]*pf-on[^"]*"[^>]*>(.*?)<\/label>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").trim()
  );

describe("EasyFeeder form", () => {
  it("is drawn by a component, not a workbook", () => {
    expect(resolveForm("EASYFEEDER")?.renderer).toBe("html");
    expect(formComponent("EASYFEEDER")).toBe(EasyFeederForm);
  });

  it.each([2020, 2420, 3220, 4030])("ticks the EF-%i box and nothing else", (width) => {
    expect(ticked(render(ctx(`EF-${width}`, { tableWidthMm: width })))).toEqual([`EF-${width}`]);
  });

  it("falls back to the product code when the width spec is missing", () => {
    expect(ticked(render(ctx("EF-3220", {})))).toEqual(["EF-3220"]);
  });

  it("asks nothing but the model: no voltage, no side, no freight, no crate", () => {
    const html = render(ctx("EF-2420", { tableWidthMm: 2420 }));
    for (const text of ["Voltage", "Hz", "Control box", "side", "Freight", "Ex-Works", "Crate", "Other"]) {
      expect(html).not.toContain(text);
    }
    expect(formHasScreenSide("EASYFEEDER")).toBe(false);
  });

  it("keeps the header and the office block", () => {
    const html = render(ctx("EF-2420", { tableWidthMm: 2420 }));
    expect(html).toContain("EasyFeeder Order Form");
    expect(html).toContain("Office use only");
    expect(html).toContain("EASYFEEDER · Q-AU-2026-041 · item 1 of 1 · 17.09.2026");
  });

  it("sends any option to the Additional items sheet -- the form has no box for one", () => {
    const crate = { id: "c", code: "Crate-X", role: "CRATE", qty: 1, attributes: null } as never;
    expect(unmatchedOptions(resolveForm("EASYFEEDER")!, ctx("EF-2420", { tableWidthMm: 2420 }, [crate]))).toHaveLength(1);
  });
});
