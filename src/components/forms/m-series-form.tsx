import type { OptionRole } from "@prisma/client";
import type { FormContext } from "@/lib/production-forms/types";
import type { ProductSpecs } from "@/lib/validation/product-specs";
import { EndUserSection, FormSheet, provenance } from "./form-sheet";
import { Footnote, InlineValue, Label, OfficeUse, Section, SectionRow, Tick, TickGrid, WriteIn } from "./primitives";

/**
 * The M-Series order form.
 *
 * Every row below is either a fact about the product (`Product.specs`), an
 * option the customer bought, or an answer from the item's `productionSpec`.
 * Nothing is transcribed by hand and nothing is a cell address -- which is
 * the whole point of the move off the workbook: a row inserted into a
 * template used to shift every address under it silently, and the `X` landed
 * in the wrong box.
 */

/** One option box: its code, its plain name, and whether it was sold. */
type OptionBox = { role: OptionRole; code: string; desc?: string };

/**
 * The options grid, in the order the printed form prints it: down the three
 * columns, not across. Codes are the form's own labels, which are base codes
 * (`ABR`, not `ABR-M`) -- the catalogue's suffixes are a pricing detail the
 * workshop has no use for, which is why a box matches on `Option.role`.
 */
const OPTION_BOXES: OptionBox[][] = [
  [
    { role: "VRB", code: "VRB", desc: "Vac Resealing Blind" },
    { role: "OFJ", code: "OFJ", desc: "Offload Projector" },
    { role: "HFV", code: "HFV", desc: "Vac High Flow 22kw" },
  ],
  [
    { role: "PM", code: "PM", desc: "Pattern Match" },
    { role: "OFD", code: "OFD", desc: "Offload Display" },
    { role: "PRM", code: "PRM", desc: "Production Manager" },
  ],
  [
    { role: "APM", code: "APM", desc: "Adaptive Pattern Matching" },
    { role: "OFP", code: "OFP", desc: "Offload Printer" },
    { role: "DMT", code: "DMT", desc: "DuctMasTer" },
  ],
  [
    { role: "DRG_3", code: "DRG-3", desc: "Drag Knife, carbide" },
    { role: "MRK", code: "MRK", desc: "Marking tool" },
    { role: "CRATE", code: "CRATE" },
  ],
  [
    { role: "DRG_1", code: "DRG-1", desc: "Drag Knife, snap off" },
    { role: "IJP", code: "IJP", desc: "Ink Jet Printer" },
  ],
  [
    { role: "HDC", code: "HDC", desc: "Head Cam" },
    { role: "ABR", code: "ABR", desc: "Air Brush" },
  ],
  [
    { role: "BCR", code: "BCR", desc: "Barcode Reader" },
    { role: "DR2", code: "DR2", desc: "Secondary Drill, AUX" },
  ],
  [
    { role: "IKA", code: "IKA", desc: "Ice Knife Air" },
    { role: "AFP", code: "AFP", desc: "Auto foot pressure" },
  ],
];

/** The voltage column, which is a production-spec answer rather than an option. */
const VOLTAGES = [
  { value: "220V", desc: "TR220 ext. xfmr" },
  { value: "400V", desc: undefined },
  { value: "415V", desc: undefined },
  { value: "480V", desc: "TR480 int. xfmr" },
] as const;

const PATHWORKS = [
  { module: "PDG", code: "PDG", desc: "PhotoDigitizer" },
  { module: "WPN", code: "WPN", desc: "Wizard Panel" },
  { module: "WPL", code: "WPL", desc: "Wizard Pool" },
  { module: "ANT_V5", code: "ANT T5.5", desc: "AutoNester" },
  { module: "ANT_V6", code: "ANT T6.0", desc: "AutoNester" },
] as const;

const KNIFE_SIZES = ["1.5x5.0", "1.5x7.0", "2.0x7.0"] as const;
const MODELS = ["M3", "M5", "M7", "M10"] as const;
const WIDTHS = [180, 220, 300, 390] as const;

/** Whether this item carries an option of that role. */
export function hasRole(ctx: FormContext, role: OptionRole): boolean {
  return ctx.item.options.some((option) => option.role === role);
}

/**
 * PathWorks modules tick only when the quote carries the INTEGRATED
 * PathWorks. With the standalone licence they belong on the Software Order
 * Form instead -- two different orders, not a duplication.
 */
function hasIntegratedModule(ctx: FormContext, module: NonNullable<ProductSpecs["pathworksModule"]>): boolean {
  return (
    ctx.software.some((s) => s.specs.softwareMode === "integrated") &&
    ctx.software.some((s) => s.specs.pathworksModule === module)
  );
}

/**
 * The PathWorks row, identical on the M-Series and the X-Calibre: the five
 * modules the printed forms carry, ticked only when the quote holds the
 * INTEGRATED licence.
 */
export function PathWorksSection({ ctx }: { ctx: FormContext }) {
  return (
    <Section title="PathWorks" hint="integrated licence only">
      <TickGrid variant="five" stacked>
        {PATHWORKS.map((module) => (
          <Tick key={module.module} on={hasIntegratedModule(ctx, module.module)}>
            <span className="pf-code pf-num">{module.code}</span>
            <span className="pf-desc">{module.desc}</span>
          </Tick>
        ))}
      </TickGrid>
    </Section>
  );
}

/**
 * The Machine Transfer System block. The tick says one was sold; the figure
 * beside it is the travel distance typed against that option line, which is
 * also what decides how many metres of MTS-M the quote charges for (see
 * `mtsTravelMetres`).
 */
export function MtsSection({ ctx }: { ctx: FormContext }) {
  const mts = ctx.item.options.find((option) => option.role === "MTS");
  return (
    <Section title="Machine Transfer System">
      <div style={{ display: "flex", alignItems: "center", gap: "4mm", flexWrap: "wrap" }}>
        <Tick
          on={Boolean(mts)}
          code="MTS"
          style={{
            padding: "0.85mm 2.5mm",
            borderRadius: "0.7mm",
            background: mts ? "var(--tint-hit)" : undefined,
          }}
        />
        {mts ? (
          <InlineValue
            label="Travel distance, end to end"
            value={String(mts.attributes?.metres ?? "")}
            unit="metres"
          />
        ) : null}
      </div>
    </Section>
  );
}

/** Drills and special notes, identical on both cutter forms. */
export function DrillsAndNotesSection({ ctx, warn }: { ctx: FormContext; warn: string }) {
  const spec = ctx.item.spec as { drills?: { required?: boolean; detail?: string }; specialNotes?: string };
  return (
    <Section title="Drills &amp; notes">
      <div className="pf-two" style={{ gridTemplateColumns: "1.25fr 1fr", gap: "5mm" }}>
        <WriteIn label="Drills required" warn={warn}>
          <div className="pf-yesno">
            <Tick on={spec.drills?.required === true}>Yes</Tick>
            <Tick on={spec.drills?.required === false}>No</Tick>
          </div>
          <div className="pf-body">{spec.drills?.detail}</div>
        </WriteIn>
        <WriteIn label="Special notes — revert to salesperson">
          <div className="pf-body">{spec.specialNotes}</div>
        </WriteIn>
      </div>
    </Section>
  );
}

/**
 * The interface-side choice, printed the same way by every form that has one
 * -- the cutters call it the user interface side, the EasyLoader the control
 * box side and the FabricPro the operator side, but it is one answer and it
 * must look like one answer.
 *
 * Beside the boxes goes the diagram of the side that was chosen: the
 * admin-uploaded `SpecImage` pair (Settings -> Catalogue -> Spec diagrams)
 * that the builder already shows the salesperson, so the picture in the
 * workshop is the picture the choice was made from. Nothing is printed until
 * those diagrams are uploaded.
 *
 * `label` is omitted where the section band already names it, so the sheet
 * never says "Operator side" twice in a row.
 */
export function ScreenSideBlock({
  ctx,
  side,
  label = "User interface side",
}: {
  ctx: FormContext;
  side: string;
  label?: string | null;
}) {
  const diagram = ctx.screenSideImages[side];

  return (
    <div>
      {label ? <Label>{label}</Label> : null}
      <div className="pf-sideblock">
        <TickGrid variant="col">
          <Tick lead on={side === "+Y"}>
            +Y
          </Tick>
          <Tick lead on={side === "-Y"}>
            −Y{" "}
            <span className="pf-desc" style={{ fontSize: "7pt" }}>
              (std)
            </span>
          </Tick>
        </TickGrid>
        {diagram ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="pf-sidefig" src={diagram} alt={`Interface side ${side}`} />
        ) : null}
      </div>
    </div>
  );
}

/** The six dates and the signature every machine form ends with. */
export const MACHINE_OFFICE_FIELDS = [
  "Machine serial no.",
  "Distribution date",
  "Person",
  "Dispatch date",
  "Client expected install",
  "Actual install date",
];

export function MSeriesForm({ ctx }: { ctx: FormContext }) {
  const spec = ctx.item.spec as {
    ui?: string;
    knifeSize?: string;
    voltage?: string;
    drills?: { required?: boolean; detail?: string };
    specialNotes?: string;
  };
  const side = spec.ui ?? "-Y";

  return (
    <FormSheet ctx={ctx} title="M-Series Order Form">
      <EndUserSection ctx={ctx} />

      <Section title="Machine">
        <div className="pf-two" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div>
            <Label>Model</Label>
            <TickGrid variant="four">
              {MODELS.map((model) => (
                <Tick key={model} lead on={ctx.item.specs.modelTier === model}>
                  {model}
                </Tick>
              ))}
            </TickGrid>
            <div style={{ margin: "2.8mm 0 1.5mm" }}>
              <Label>Width</Label>
            </div>
            <TickGrid variant="four">
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
        <TickGrid>
          {/* Eight rows of three, read left to right -- the same order the
              printed form uses. The third cell of the last four rows is a
              voltage, which is a production-spec answer rather than an
              option, so those rows carry two boxes and a voltage. */}
          {OPTION_BOXES.flatMap((row, index) => {
            const cells = row.map((box) => (
              <Tick
                key={box.code}
                // VRB is fitted to every machine and never quoted, so it
                // prints as a fact rather than from an option line.
                on={box.role === "VRB" ? true : hasRole(ctx, box.role)}
                code={box.code}
                desc={box.desc}
              />
            ));

            const voltage = VOLTAGES[index - (OPTION_BOXES.length - VOLTAGES.length)];
            if (row.length < 3 && voltage) {
              cells.push(
                <Tick key={voltage.value} on={spec.voltage === voltage.value}>
                  <span className="pf-code pf-num">{voltage.value}</span>
                  {voltage.desc ? <span className="pf-desc"> {voltage.desc}</span> : null}
                </Tick>
              );
            }
            return cells;
          })}
        </TickGrid>
      </Section>

      <PathWorksSection ctx={ctx} />

      <SectionRow>
        <Section title="Knife size">
          <TickGrid variant="row">
            {KNIFE_SIZES.map((size) => (
              <Tick key={size} lead on={spec.knifeSize === size}>
                <span className="pf-num">{size.replace("x", " × ")}</span>
              </Tick>
            ))}
          </TickGrid>
        </Section>
        <MtsSection ctx={ctx} />
      </SectionRow>

      <DrillsAndNotesSection ctx={ctx} warn="“TBC” not accepted" />

      <OfficeUse fields={MACHINE_OFFICE_FIELDS} signature="Salesman confirmation — signed" />

      <Footnote provenance={provenance(ctx, "m-series")} />
    </FormSheet>
  );
}
