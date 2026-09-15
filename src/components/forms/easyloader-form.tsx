import type { FormContext } from "@/lib/production-forms/types";
import { easyLoaderPrintedWidthCell } from "@/lib/production-forms/specs/easyloader";
import { layoutTotals, MAX_SECTIONS, type Section as TableSection } from "@/lib/production-forms/table-sections";
import { EndUserSection, FormSheet, provenance } from "./form-sheet";
import { Footnote, InlineValue, OfficeUse, Section, SectionRow, Tick, TickGrid } from "./primitives";
import { ScreenSideBlock, hasRole } from "./m-series-form";

/**
 * The EasyLoader order form.
 *
 * An EasyLoader is a table assembled from 1.2 metre modules, and the machine
 * itself prices at nothing: every part of it is an option. So the sheet's
 * centre is the table drawing -- section by section, each with its length and
 * whether it is static or a conveyor -- and the total under it is what the
 * quote actually charges for (`layoutTotals`).
 *
 * The one thing printed here that the paper form never had is the FabricPro
 * rails, and only when the quote holds no FabricPro. The rails bolt to this
 * table, so their length is known here; with a FabricPro in the quote they
 * print on that form instead, because stores pick them for whoever builds it.
 * Printing both would have two sets picked. See `rails.ts`.
 */

const SECTION_NOTES = ["Drive section", "", ""];

export function EasyLoaderForm({ ctx }: { ctx: FormContext }) {
  const spec = ctx.item.spec as {
    ui?: string;
    usage?: string;
    customWidthMm?: number;
    sections?: TableSection[];
    fabricProCompatible?: boolean;
    syncWithCutter?: boolean;
    rollFeedDistancesMm?: number[];
  };
  const side = spec.ui ?? "-Y";
  const usage = spec.usage ?? "onload";
  const sections = spec.sections ?? [];
  const totals = layoutTotals(sections);
  const printedWidth = easyLoaderPrintedWidthCell(ctx.item.specs);
  const rollFeedQty = ctx.item.options
    .filter((option) => option.role === "EL_ROLL_FEED")
    .reduce((sum, option) => sum + option.qty, 0);
  const distances = spec.rollFeedDistancesMm ?? [];
  // `ctx.rails` is set on a table's own form only while no FabricPro claimed
  // it -- a customer who already owns the machine, or three tables sold with
  // two. With a FabricPro in the quote the lengths print on that form, and
  // two printed lengths would have stores pick two sets of rails.
  const railM = ctx.rails?.lengthM ?? null;

  return (
    <FormSheet ctx={ctx} title="EasyLoader Order Form">
      <EndUserSection ctx={ctx} />

      <Section title="Width">
        <TickGrid variant="col">
          <Tick lead on={printedWidth === "I31"}>
            <span className="pf-num">2020 mm</span>{" "}
            <span className="pf-desc" style={{ fontSize: "7pt" }}>
              matched for 1800 mm spreading
            </span>
          </Tick>
          <Tick lead on={printedWidth === "I33"}>
            <span className="pf-num">2420 mm</span>{" "}
            <span className="pf-desc" style={{ fontSize: "7pt" }}>
              matched for 2200 mm spreading
            </span>
          </Tick>
          {/* Any width the row has no box for -- EL-3220 and EL-4030 today.
              The figure comes from the product, or from the custom width a
              manager typed when the product has none. */}
          <Tick lead on={printedWidth === null}>
            Custom{" "}
            <InlineValue
              value={printedWidth === null ? (spec.customWidthMm ?? ctx.item.specs.tableWidthMm ?? "") : ""}
              unit="mm"
            />{" "}
            <span className="pf-desc" style={{ fontSize: "7pt" }}>
              must be confirmed prior to order
            </span>
          </Tick>
        </TickGrid>
      </Section>

      <SectionRow>
        <Section title="To be used as">
          <TickGrid variant="row">
            <Tick lead on={usage === "onload"}>
              On Load
            </Tick>
            <Tick lead on={usage === "offload"}>
              Off Load
            </Tick>
          </TickGrid>
        </Section>
        <Section title="Control box side">
          {/* The same block the cutter forms print: one answer, one look --
              and the section band already names it, so no second label. */}
          <ScreenSideBlock ctx={ctx} side={side} label={null} />
        </Section>
      </SectionRow>

      <Section title="Table sections">
        <div className="pf-sectbl">
          <div className="pf-hdr">
            <span>Section</span>
            <span>Length</span>
            <span>Surface</span>
            <span />
          </div>
          {Array.from({ length: MAX_SECTIONS }, (_, index) => {
            const section = sections[index];
            const ordered = Boolean(section);
            return (
              <div key={index} className={ordered ? "pf-rw" : "pf-rw pf-empty"}>
                <span className="pf-name">Section {index + 1}</span>
                <span className="pf-inlinefld">
                  <span className="pf-run pf-short pf-val">{section ? section.lengthM : ""}</span>
                  <span className="pf-unit">m</span>
                </span>
                <span className="pf-surf">
                  <Tick on={section?.surface === "static"}>Static</Tick>
                  <Tick on={section?.surface === "conveyor"}>
                    {index === 0 ? "Conveyor" : "Conveyor Slave"}
                  </Tick>
                </span>
                <span className="pf-note">{ordered ? SECTION_NOTES[index] : "Not ordered"}</span>
              </div>
            );
          })}
          <div className="pf-total">
            <span>Total table length, from the options sold</span>
            <b>{totals.totalM} m</b>
          </div>
        </div>
      </Section>

      <Section title="Options">
        <TickGrid variant="one">
          <Tick on={spec.syncWithCutter !== false}>Synchronisation feature with Pathfinder cutter</Tick>
          <Tick on={rollFeedQty > 0}>
            Single roll feed attachment{" "}
            <span className="pf-desc">— EL-2020 / EL-2420 only, includes side keepers</span>
          </Tick>
        </TickGrid>

        {/* The distances the service crew fits the attachments to on site.
            Printed whenever either half is known: an attachment with no
            distance still has to be built, and a distance recorded against an
            attachment the customer already owns still has to be fitted. */}
        {rollFeedQty > 0 || distances.length > 0 ? (
          <div className="pf-rollfeed">
            <span className="pf-cap">Qty</span>
            <span className="pf-inlinefld">
              <span className="pf-run pf-short">{rollFeedQty || ""}</span>
            </span>
            <span className="pf-cap">Distance from X = 0</span>
            {[0, 1, 2, 3].map((index) => (
              <span key={index} className="pf-inlinefld">
                <span className="pf-desc">#{index + 1}</span>
                <span className="pf-run pf-short">{distances[index] ?? ""}</span>
                <span className="pf-unit">mm</span>
              </span>
            ))}
          </div>
        ) : null}

        <div className="pf-opts pf-one" style={{ marginTop: "1mm" }}>
          <Tick on={hasRole(ctx, "EL_ROLL_HOLDER")}>
            Perforated paper roll holder attachment <span className="pf-desc">— with bar and cones</span>
          </Tick>
          <Tick on={hasRole(ctx, "CRATE")}>Crate required</Tick>
        </div>

        {railM !== null ? (
          <div className="pf-optrow pf-on" style={{ marginTop: "1mm" }}>
            <label className="pf-tick pf-on">
              <span className="pf-bx" />
              <span className="pf-tx">
                FabricPro rails{" "}
                <span className="pf-desc">— travel platform rail and electrical power rail</span>
              </span>
            </label>
            <InlineValue value={railM} unit="metres each" />
          </div>
        ) : null}
      </Section>

      <OfficeUse
        fields={[
          "Machine serial no.",
          "System reg. no.",
          "Person",
          "Distribution date",
          "Expected dispatch date",
          "Client expected install",
          "Actual install date",
        ]}
      />

      <Footnote
        note="Custom widths must be confirmed with production before the order is placed."
        provenance={provenance(ctx, "easyloader")}
      />
    </FormSheet>
  );
}
