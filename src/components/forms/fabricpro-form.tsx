import type { FormContext } from "@/lib/production-forms/types";
import { EndUserSection, FormSheet, provenance } from "./form-sheet";
import { Footnote, InlineValue, OfficeUse, Section, SectionRow, Tick, TickGrid } from "./primitives";
import { ScreenSideBlock, hasRole } from "./m-series-form";

/**
 * The FabricPro order form.
 *
 * Three corrections from Jeff (2026-09-11) are applied here and are the
 * reason this does not match the mockup line for line:
 *
 * - **The Travel Platform tick is gone.** It is fitted to every machine, so
 *   it is a fact rather than a question; only its length is asked. The
 *   mockup still prints the box.
 * - **The "currently the only side available" note is gone.** Both sides
 *   ship. Leaving it would tell the workshop the opposite of the truth.
 * - The voltage note stays until somebody says what the alternatives are:
 *   Jeff is building a machine with a transformer now, but the catalogue has
 *   no transformer option compatible with the FP series, so inventing a row
 *   of voltages here would be guessing. Tracked in the backlog.
 *
 * The two rail lengths are not typed on this form unless somebody overrides
 * them: they belong to the EasyLoader table this machine runs over -- the one
 * it was paired with, not every compatible table in the quote added together
 * (a FabricPro cannot straddle two tables). The pairing is `ctx.rails`; see
 * `rails.ts`.
 *
 * Freight is gone with the same reasoning as the priced options: Ex-Works is
 * a delivery term the quote states, and restating it on a build sheet invites
 * the workshop to treat it as theirs to set (Vadym, 2026-09-11).
 */

const MODELS = [
  { widthCode: 180, label: "FP-180" },
  { widthCode: 220, label: "FP-220" },
  { widthCode: 300, label: "FP-300" },
];

export function FabricProForm({ ctx }: { ctx: FormContext }) {
  const spec = ctx.item.spec as {
    ui?: string;
    railLengthM?: number;
    powerRailLengthM?: number;
  };
  const side = spec.ui ?? "-Y";
  const derived = ctx.rails?.lengthM ?? null;
  const railM = spec.railLengthM ?? derived;
  const powerRailM = spec.powerRailLengthM ?? derived;
  // Named so the workshop can see which table the figure belongs to on a
  // quote that carries several -- and so a wrong pairing is visible rather
  // than silent.
  const railSource = derived !== null && ctx.rails ? ctx.rails.tableCode : null;

  return (
    <FormSheet ctx={ctx} title="Fabric Pro Order Form">
      <EndUserSection ctx={ctx} />

      {/* Two short columns on one band, the way the cutter forms print model
          and side together -- neither fills a row on its own. */}
      <SectionRow>
        <Section title="Model">
          <TickGrid variant="col">
            {MODELS.map((model) => (
              <Tick key={model.label} lead on={ctx.item.specs.widthCode === model.widthCode}>
                {model.label}
              </Tick>
            ))}
          </TickGrid>
          <div style={{ margin: "3mm 0 1.5mm" }}>
            <span className="pf-lb">Voltage / Hz</span>
          </div>
          <TickGrid variant="col">
            <Tick lead on>
              <span className="pf-num">220–240 / 50–60</span>{" "}
              <span className="pf-desc" style={{ fontSize: "7pt" }}>
                currently the only voltage available
              </span>
            </Tick>
          </TickGrid>
        </Section>

        <Section title="Operator side">
          <ScreenSideBlock ctx={ctx} side={side} label={null} />
        </Section>
      </SectionRow>

      <Section title="Options">
        {/* Fitted to every machine, so it prints as a standard rather than as
            a box somebody has to remember to tick. */}
        <TickGrid variant="one">
          <Tick std>
            Travel platform <span className="pf-desc">— fitted to every machine, supports the safety system</span>
          </Tick>
        </TickGrid>

        <div className={railM ? "pf-optrow pf-on" : "pf-optrow"}>
          <Tick on={Boolean(railM)}>
            Travel platform rail
            {railSource ? <span className="pf-desc"> — table {railSource}</span> : null}
          </Tick>
          <InlineValue label="Length" value={railM ?? ""} unit="metres" />
        </div>
        <div className={powerRailM ? "pf-optrow pf-on" : "pf-optrow"}>
          <Tick on={Boolean(powerRailM)}>
            Electrical power rail
            {railSource ? <span className="pf-desc"> — table {railSource}</span> : null}
          </Tick>
          <InlineValue label="Length" value={powerRailM ?? ""} unit="metres" />
        </div>

        <div className="pf-opts pf-one" style={{ marginTop: "0.6mm" }}>
          <Tick on={hasRole(ctx, "CRATE")}>
            Wooden crate <span className="pf-desc">— built and packed by production</span>
          </Tick>
        </div>
      </Section>

      <OfficeUse
        fields={[
          "Machine serial no.",
          "Distribution date",
          "Person",
          "Packed by",
          "Date",
          "Checked by",
          "Date",
          "Client expected install",
          "Actual install date",
        ]}
      />

      <Footnote
        note="Operator side must match the cutter and the EasyLoader on the same production line."
        provenance={provenance(ctx, "fabricpro")}
      />
    </FormSheet>
  );
}
