import type { OptionRole } from "@prisma/client";
import type { FormContext } from "@/lib/production-forms/types";
import { PATHWORKS_BOXES, pathWorksTicked } from "@/lib/production-forms/pathworks";
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

/** One option box: its code, its plain name, and whether it is standard fitment. */
type OptionBox = { role: OptionRole; code: string; desc?: string; std?: true };

/**
 * The options grid, three across, read left to right. Codes are the form's
 * own labels, which are base codes (`ABR`, not `ABR-M`) -- the catalogue's
 * suffixes are a pricing detail the workshop has no use for, which is why a
 * box matches on `Option.role`.
 *
 * Every M-compatible option in the catalogue has a box here (checked against
 * the 2026-09-16 dump); the transformers sit in the power row below. `VRB`
 * is the one box with no option behind it: fitted to every machine, never
 * quoted, so it prints as standard.
 */
const OPTION_BOXES: OptionBox[] = [
  { role: "VRB", code: "VRB", desc: "Vac Resealing Blind", std: true },
  { role: "OFJ", code: "OFJ", desc: "Offload Projector" },
  { role: "HFV", code: "HFV", desc: "Vac High Flow 22kW" },

  { role: "PM", code: "PM", desc: "Pattern Match" },
  { role: "OFD", code: "OFD", desc: "Offload Display" },
  { role: "PRM", code: "PRM", desc: "Production Manager" },

  { role: "APM", code: "APM", desc: "Adaptive Pattern Matching" },
  { role: "OFP", code: "OFP", desc: "Offload Printer" },
  { role: "DMT", code: "DMT", desc: "DuctMasTer" },

  { role: "DRG_1", code: "DRG-1", desc: "Drag Knife, Olfa 45°" },
  { role: "IJP", code: "IJP", desc: "Ink Jet Printer" },
  { role: "IKA", code: "IKA", desc: "IceKnife Air" },

  { role: "DRG_2", code: "DRG-2", desc: "Drag Knife, Excellite 21°" },
  { role: "ABR", code: "ABR", desc: "Air Brush" },
  { role: "AFP", code: "AFP", desc: "Auto Foot Pressure" },

  { role: "DRG_3", code: "DRG-3", desc: "Drag Knife, Carbide 45°" },
  { role: "MRK", code: "MRK", desc: "Marking Tool" },
  { role: "DR2", code: "DR2", desc: "Secondary Drill, AUX" },

  { role: "HDC", code: "HDC", desc: "HeadCam" },
  { role: "BCR", code: "BCR", desc: "Barcode Reader" },
  { role: "CRATE", code: "CRATE", desc: "Wooden crate" },
];

/** The supply voltage, which is a production-spec answer rather than an option. */
export const VOLTAGES = ["220V", "400V", "415V", "480V"] as const;

/** The two transformers the catalogue sells, both role TRANSFORMER, told apart by code. */
export const TRANSFORMERS = [
  { code: "TR220", desc: "ext. xfmr" },
  { code: "TR480", desc: "int. xfmr" },
] as const;

/**
 * The power row: the supply voltage (a production-spec answer), then the
 * transformers sold as options. Any transformer the catalogue gains later
 * prints after the two known ones under its own code, rather than vanishing
 * into a box that does not name it.
 */
export function PowerTicks({ ctx, voltage }: { ctx: FormContext; voltage?: string }) {
  const transformers = ctx.item.options.filter((option) => option.role === "TRANSFORMER");
  const known = (code: string) => transformers.some((option) => option.code.startsWith(code));
  const others = transformers.filter((option) => !TRANSFORMERS.some((t) => option.code.startsWith(t.code)));

  return (
    <>
      {VOLTAGES.map((value) => (
        <Tick key={value} on={voltage === value}>
          <span className="pf-code pf-num">{value}</span>
        </Tick>
      ))}
      {TRANSFORMERS.map((t) => (
        <Tick key={t.code} on={known(t.code)} code={t.code} desc={t.desc} />
      ))}
      {others.map((option) => (
        <Tick key={option.id ?? option.code} on code={option.code} />
      ))}
    </>
  );
}

const KNIFE_SIZES = ["1.5x5.0", "1.5x7.0", "2.0x7.0"] as const;
const MODELS = ["M3", "M5", "M7", "M10"] as const;
const WIDTHS = [180, 220, 300, 390] as const;

/** Whether this item carries an option of that role. */
export function hasRole(ctx: FormContext, role: OptionRole): boolean {
  return ctx.item.options.some((option) => option.role === role);
}

/**
 * The PathWorks section, identical on every cutter form: the integrated
 * licence and the programs that run in it, ticked from the option lines on
 * this machine or from software products on the quote (see
 * src/lib/production-forms/pathworks.ts for which counts when).
 */
export function PathWorksSection({ ctx }: { ctx: FormContext }) {
  return (
    <Section title="PathWorks" hint="integrated licence only">
      <TickGrid variant="four">
        {PATHWORKS_BOXES.map((box) => (
          <Tick key={box.role} on={pathWorksTicked(ctx, box)} code={box.code} desc={box.desc} />
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

/** Drills and special notes, identical on both cutter forms. Yes/No plus the
 * detail when yes -- no warning tag (Vadym, 2026-09-17). */
export function DrillsAndNotesSection({ ctx }: { ctx: FormContext }) {
  const spec = ctx.item.spec as { drills?: { required?: boolean; detail?: string }; specialNotes?: string };
  return (
    <Section title="Drills &amp; notes">
      <div className="pf-two" style={{ gridTemplateColumns: "1.25fr 1fr", gap: "5mm" }}>
        <WriteIn label="Drills required">
          <div className="pf-yesno">
            <Tick on={spec.drills?.required === true}>Yes</Tick>
            {/* Unticked in the builder means no drills. */}
            <Tick on={spec.drills?.required !== true}>No</Tick>
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

  // The diagram sits level with the label, directly to the right of it, so
  // the block is no taller than the picture and the label line costs nothing.
  return (
    <div className="pf-sideblock">
      <div>
        {label ? <Label>{label}</Label> : null}
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
      </div>
      {diagram ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="pf-sidefig" src={diagram} alt={`Interface side ${side}`} />
      ) : null}
    </div>
  );
}

/**
 * The dates and the signature every machine form ends with. No dispatch
 * date: dispatch is logistics' business and is not printed on a workshop
 * sheet (Vadym, 2026-09-16).
 */
export const MACHINE_OFFICE_FIELDS = [
  "Machine serial no.",
  "Distribution date",
  "Person",
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
          {OPTION_BOXES.map((box) =>
            box.std ? (
              <Tick key={box.code} std code={box.code} desc={box.desc} />
            ) : (
              <Tick key={box.code} on={hasRole(ctx, box.role)} code={box.code} desc={box.desc} />
            )
          )}
        </TickGrid>
        <div className="pf-subrow">
          <Label>Power</Label>
          <TickGrid variant="row">
            <PowerTicks ctx={ctx} voltage={spec.voltage} />
          </TickGrid>
        </div>
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

      <DrillsAndNotesSection ctx={ctx} />

      <OfficeUse fields={MACHINE_OFFICE_FIELDS} signature="Salesman confirmation — signed" />

      <Footnote provenance={provenance(ctx, "m-series")} />
    </FormSheet>
  );
}
