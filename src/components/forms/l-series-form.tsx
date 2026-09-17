import type { OptionRole } from "@prisma/client";
import type { FormContext } from "@/lib/production-forms/types";
import { EndUserSection, FormSheet, provenance } from "./form-sheet";
import { Footnote, InlineValue, Label, OfficeUse, Section, Tick, TickGrid, WriteIn } from "./primitives";
import { PathWorksSection, ScreenSideBlock, hasRole } from "./m-series-form";

/**
 * The L-Series order form.
 *
 * Three rows are read off the product rather than asked, because the code
 * already says them: `Model` from `Product.specs.widthCode`, `Cutting length`
 * from `.extended` (175 standard, 316 extended) and `Cutting surface` from
 * `.belt`. `L-320EF` means extended, felt, 320 — asking a salesperson to
 * restate any of that would only create a second answer that can disagree
 * with the first.
 *
 * **The tools row prints what was sold, under the catalogue's own names.**
 * The paper form has nine fixed labels and they do not map cleanly onto the
 * catalogue: its `RKT-40` is a 40 mm round knife while the sheet says "48 mm
 * dia.", and "DRG (roller)" and "Driven 28 mm, 5-sided" have no code at all.
 * Printing a guessed mapping would send the workshop the wrong tool, so each
 * sold `L_TOOL` line prints as itself, with its quantity in the box — which
 * is exactly what the printed form asks for ("box shows the quantity when
 * more than one is required"). When production confirms the mapping this can
 * become the nine labels again; until then nothing is lost and nothing is
 * invented. See docs/specs/2026-09-11-order-forms-backlog.md §E.1.
 */

const OPTIONS: Array<{ role: OptionRole; code: string; desc?: string }> = [
  { role: "OFD", code: "OFD", desc: "Offload Display" },
  { role: "PM", code: "PM", desc: "Pattern Match" },
  { role: "PRM", code: "PRM", desc: "Production Manager" },
  { role: "OFP", code: "OFP", desc: "Offload Printer" },
  { role: "ABR", code: "ABR", desc: "Air Brush" },
  { role: "HFV", code: "HFV", desc: "High Flow Vacuum" },
  { role: "BCR", code: "BCR", desc: "Barcode Reader" },
  { role: "IJP", code: "IJP", desc: "Ink Jet Printer" },
  { role: "CRATE", code: "CRATE" },
  { role: "HDC", code: "HDC", desc: "Head Cam" },
  { role: "JTP", code: "JetPen" },
  { role: "APM", code: "APM", desc: "requires PTWS and ANT" },
];

const WIDTHS = [180, 220, 320] as const;

export function LSeriesForm({ ctx }: { ctx: FormContext }) {
  const spec = ctx.item.spec as {
    ui?: string;
    voltage?: string;
    voltageOtherVac?: string;
    specialNotes?: string;
  };
  const side = spec.ui ?? "-Y";
  // Extended either by the product code (L-320E) or by the priced
  // extension option (180-E, 220-E) on a standard machine.
  const extended = ctx.item.specs.extended === true || hasRole(ctx, "L_EXTENDED");
  const belt = ctx.item.specs.belt;
  const tools = ctx.item.options.filter((option) => option.role === "L_TOOL");

  return (
    <FormSheet ctx={ctx} title="L-Series Order Form" dense>
      <EndUserSection ctx={ctx} />

      <Section title="Machine">
        <div className="pf-two" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div>
            <Label>Model</Label>
            <TickGrid variant="row">
              {WIDTHS.map((width) => (
                <Tick key={width} lead on={ctx.item.specs.widthCode === width}>
                  L{width}
                </Tick>
              ))}
            </TickGrid>
            <div style={{ margin: "2.4mm 0 1.4mm" }}>
              <Label>Cutting length</Label>
            </div>
            <TickGrid variant="row">
              <Tick lead on={!extended}>
                <span className="pf-num">175</span>{" "}
                <span className="pf-desc" style={{ fontSize: "7pt" }}>
                  (std)
                </span>
              </Tick>
              <Tick lead on={extended}>
                <span className="pf-num">316</span>{" "}
                <span className="pf-desc" style={{ fontSize: "7pt" }}>
                  (E)
                </span>
              </Tick>
            </TickGrid>
          </div>
          <div>
            <ScreenSideBlock ctx={ctx} side={side} />
            <div style={{ margin: "2.4mm 0 1.4mm" }}>
              <Label>Cutting surface</Label>
            </div>
            <TickGrid variant="row">
              <Tick lead on={belt === "felt"}>
                Felt{" "}
                <span className="pf-desc" style={{ fontSize: "7pt" }}>
                  grey, porous
                </span>
              </Tick>
              <Tick lead on={belt === "urethane"}>
                Urethane{" "}
                <span className="pf-desc" style={{ fontSize: "7pt" }}>
                  white, perforated
                </span>
              </Tick>
            </TickGrid>
          </div>
        </div>
      </Section>

      <Section title="Tools">
        <TickGrid>
          {/* MRK first and always: the printed form says "standard on all",
              and it is removed only when IJP, JetPen or ABR is fitted -- a
              rule the footnotes state and an OptionConflictGroup enforces. */}
          <Tick std code="MRK" desc="standard on all" />
          {tools.map((tool) => (
            <Tick key={tool.id ?? tool.code} qty={tool.qty} code={tool.code} />
          ))}
        </TickGrid>
        {tools.length === 0 ? (
          <p className="pf-terms">No tools ordered.</p>
        ) : null}
      </Section>

      {/* No shipping row: packing and delivery are logistics' document, not
          the workshop's (Vadym, 2026-09-16). */}
      <Section title="Voltage">
        <TickGrid variant="row">
          <Tick lead on={spec.voltage === "220/230"}>
            <span className="pf-num">220 / 230</span>
          </Tick>
          <Tick lead on={spec.voltage === "other"}>
            Other <InlineValue value={spec.voltageOtherVac ?? ""} unit="VAC" />
          </Tick>
        </TickGrid>
      </Section>

      <Section title="Options">
        <TickGrid>
          {OPTIONS.map((box) => (
            <Tick key={box.code} on={hasRole(ctx, box.role)} code={box.code} desc={box.desc} />
          ))}
          {/* The Leather Nesting System is a product in its own right, not an
              option, so it is ticked from the quote holding one rather than
              from a line on this item. */}
          <Tick on={ctx.item.code.startsWith("LNS-")} code="LNS" desc="Leather Nesting System" />
        </TickGrid>
      </Section>

      <PathWorksSection ctx={ctx} />

      <Section title="Special notes">
        <WriteIn>
          <div className="pf-body">{spec.specialNotes}</div>
        </WriteIn>
      </Section>

      <OfficeUse
        fields={[
          "Machine serial no.",
          "System reg. no.",
          "Distribution date",
          "Person",
          "Client expected install",
          "Actual install date",
        ]}
      />

      <div className="pf-notes">
        <div>
          <span className="pf-cap">Fitting rules</span>
          <ul>
            <li>MRK is included as standard, and is removed when IJP, JetPen or ABR is ordered.</li>
            <li>MRK, IJP, JetPen and ABR are mutually exclusive — only one can be fitted.</li>
            <li>The roll feeder is not included when ordered with an EasyFeeder.</li>
            <li>State the consumables required in Special notes — for example 30° drag, notch, 5-sided driven.</li>
          </ul>
        </div>
        <div>
          <span className="pf-cap">Consumables included with the tool order</span>
          <ul className="pf-num">
            <li>28 mm dia. — 2 × #380019</li>
            <li>48 mm dia. — 2 × #380015</li>
            <li>DRG — 2 × #380018 (45°) or 2 × #380017 (30°) or 2 × #380016 (0°, notch)</li>
            <li>Driven 28 mm — #380032-5 or #380032-10</li>
          </ul>
        </div>
      </div>

      <Footnote provenance={provenance(ctx, "l-series")} />
    </FormSheet>
  );
}
