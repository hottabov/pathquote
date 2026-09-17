import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HdrfForm } from "../src/components/forms/hdrf-form";
import { formComponent } from "../src/components/forms/registry";
import { coveredRoles, resolveForm, unmatchedOptions } from "../src/lib/production-forms/resolve";
import { formContext, formItem } from "./helpers/fixtures";

const crate = (width: number) =>
  ({ id: `c${width}`, code: `Crate-HDRF-${width}`, role: "CRATE", qty: 1, attributes: null }) as never;

const ctx = (code: string, specs: Record<string, unknown>, options: never[] = []) =>
  formContext({
    documentNumber: "Q-AU-2026-040",
    itemIndex: 1,
    itemCount: 1,
    generatedAt: new Date("2026-09-17T00:00:00Z"),
    logo: null,
    item: formItem({ code, form: "HDRF", kind: "ACCESSORY", specs, spec: {}, options }),
  });

const render = (c: ReturnType<typeof ctx>) => renderToStaticMarkup(<HdrfForm ctx={c} />);

/** The label text of every ticked box, in order. */
const ticked = (html: string) =>
  [...html.matchAll(/class="pf-tick[^"]*pf-on[^"]*"[^>]*>(.*?)<\/label>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").trim()
  );

describe("HDRF form", () => {
  it("is drawn by a component, not a workbook", () => {
    expect(resolveForm("HDRF")?.renderer).toBe("html");
    expect(formComponent("HDRF")).toBe(HdrfForm);
  });

  it.each([180, 220, 320])("ticks the HDRF-%i model box and nothing else without a crate", (width) => {
    const html = render(ctx(`HDRF-${width}`, { widthCode: width }));
    expect(ticked(html)).toEqual([`HDRF-${width}`]);
  });

  it("falls back to the product code when the width spec is missing", () => {
    expect(ticked(render(ctx("HDRF-220", {})))).toEqual(["HDRF-220"]);
  });

  it.each([180, 220, 320])("ticks the crate from the Crate-HDRF-%i option line", (width) => {
    const html = render(ctx(`HDRF-${width}`, { widthCode: width }, [crate(width)]));
    expect(ticked(html)).toContain(`Crate-HDRF-${width} Wooden crate`);
  });

  it("covers the crate, so it never lands on the Additional items sheet", () => {
    const spec = resolveForm("HDRF")!;
    expect(coveredRoles(spec)).toContain("CRATE");
    expect(unmatchedOptions(spec, ctx("HDRF-320", { widthCode: 320 }, [crate(320)]))).toEqual([]);
  });

  it("prints the provenance without the word generated", () => {
    expect(render(ctx("HDRF-180", { widthCode: 180 }))).toContain("HDRF · Q-AU-2026-040 · item 1 of 1 · 17.09.2026");
  });
});
