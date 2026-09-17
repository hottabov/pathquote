import type { OptionRole } from "@prisma/client";
import type { FormContext } from "@/lib/production-forms/types";
import { EndUserSection, FormSheet, provenance } from "./form-sheet";
import {
  Footnote,
  Label,
  OfficeUse,
  OptionColumn,
  OptionColumns,
  Section,
  SectionRow,
  Tick,
  TickGrid,
} from "./primitives";
import {
  DrillsAndNotesSection,
  MACHINE_OFFICE_FIELDS,
  MtsSection,
  PathWorksSection,
  PowerTicks,
  ScreenSideBlock,
  hasRole,
} from "./m-series-form";

/**
 * The X-Calibre order form.
 *
 * Close cousin of the M-Series, and it shares that form's PathWorks, MTS,
 * drills and office blocks outright. Three things differ, and each is a fact
 * about the machine rather than a styling choice:
 *
 * - **One model, two widths.** The catalogue sells `X-10180` and `X-10220`
 *   and nothing else, so the model row is a single `X10` box. The trimmed
 *   X3/X5/X7 rows and the 390 width are gone from the catalogue, not merely
 *   unsold.
 * - **One knife.** `2.4 × 8.5` is the only size, so it prints as a standard
 *   rather than as a question -- hence no `knifeSize` in the production spec.
 * - **Three standard options.** `IKA`, `AFP` and `HFV` are fitted to every
 *   X-Calibre and are not sold, so they print in their own column with the
 *   grey standard mark. They are deliberately absent from the spec's
 *   `covers`: if one ever does arrive as a priced line, it belongs on the
 *   Additional items sheet where somebody will see it.
 */

const SELECTED: Array<{ role: OptionRole; code: string; desc: string }> = [
  { role: "HDC", code: "HDC", desc: "Head Cam" },
  { role: "BCR", code: "BCR", desc: "Barcode Reader" },
  { role: "OFJ", code: "OFJ", desc: "Offload Projector" },
  { role: "OFD", code: "OFD", desc: "Offload Display" },
  { role: "OFP", code: "OFP", desc: "Offload Printer" },
  { role: "DR2", code: "DR2", desc: "Secondary Drill, AUX" },
  { role: "PRM", code: "PRM", desc: "Production Manager" },
  { role: "DMT", code: "DMT", desc: "DuctMasTer" },
];

const STANDARD = [
  { code: "IKA", desc: "Ice Knife Air" },
  { code: "AFP", desc: "Auto Foot Pressure" },
  { code: "HFV", desc: "High Flow Vac 22kw" },
];

const WIDTHS = [180, 220] as const;

export function XCalibreForm({ ctx }: { ctx: FormContext }) {
  const spec = ctx.item.spec as { ui?: string; voltage?: string };
  const side = spec.ui ?? "-Y";

  return (
    <FormSheet ctx={ctx} title="X-Calibre Order Form">
      <EndUserSection ctx={ctx} />

      <Section title="Machine">
        <div className="pf-two" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div>
            <Label>Model</Label>
            <TickGrid variant="row">
              <Tick lead on={ctx.item.specs.modelTier === "X10"}>
                X10
              </Tick>
            </TickGrid>
            <div style={{ margin: "2.8mm 0 1.5mm" }}>
              <Label>Width</Label>
            </div>
            <TickGrid variant="row">
              {WIDTHS.map((width) => (
                <Tick key={width} lead on={ctx.item.specs.widthCode === width}>
                  <span className="pf-num">{width}</span>
                </Tick>
              ))}
            </TickGrid>
          </div>
          <ScreenSideBlock ctx={ctx} side={side} />
        </div>
      </Section>

      <Section title="Options">
        <OptionColumns>
          <OptionColumn caption="Selected">
            {SELECTED.map((box) => (
              <Tick key={box.code} on={hasRole(ctx, box.role)} code={box.code} desc={box.desc} />
            ))}
          </OptionColumn>
          <OptionColumn caption="Power &amp; packing">
            <PowerTicks ctx={ctx} voltage={spec.voltage} />
            <Tick on={hasRole(ctx, "CRATE")} code="CRATE" />
          </OptionColumn>
          <OptionColumn caption="Standard — always fitted">
            {STANDARD.map((box) => (
              <Tick key={box.code} std code={box.code} desc={box.desc} />
            ))}
          </OptionColumn>
        </OptionColumns>
      </Section>

      <PathWorksSection ctx={ctx} />

      <SectionRow>
        <Section title="Knife size">
          <TickGrid variant="row">
            <Tick lead std>
              <span className="pf-num">2.4 × 8.5</span>{" "}
              <span className="pf-desc" style={{ fontSize: "7pt" }}>
                (std)
              </span>
            </Tick>
          </TickGrid>
        </Section>
        <MtsSection ctx={ctx} />
      </SectionRow>

      <DrillsAndNotesSection ctx={ctx} warn="state drills or “no drill”" />

      <OfficeUse fields={MACHINE_OFFICE_FIELDS} signature="Salesman confirmation — signed" />

      <Footnote
        note="IKA, AFP and HFV are fitted to every X-Calibre and are not order options."
        provenance={provenance(ctx, "x-calibre")}
      />
    </FormSheet>
  );
}
