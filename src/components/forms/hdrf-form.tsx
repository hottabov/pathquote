import type { FormContext } from "@/lib/production-forms/types";
import { EndUserSection, FormSheet, provenance } from "./form-sheet";
import { Footnote, OfficeUse, Section, SectionRow, Tick, TickGrid } from "./primitives";
import { hasRole } from "./m-series-form";

/**
 * The Heavy Duty Roll Feeder order form -- the shortest sheet Pathfinder
 * prints: which model, and whether it ships in a crate.
 *
 * The model is the product (`specs.widthCode`, with the code as a fallback
 * for a row that predates the backfill). The crate box ticks from the
 * option line: each model has its own crate (`Crate-HDRF-180/220/320`), and
 * all three carry `role: CRATE`, so one check covers them.
 *
 * No screen and no control box, so no interface-side block
 * (`formHasScreenSide`). No dispatch date: logistics' business, as on every
 * other machine form.
 */

const MODELS = [180, 220, 320] as const;

function widthOf(ctx: FormContext): number | null {
  const fromSpecs = ctx.item.specs.widthCode;
  if (typeof fromSpecs === "number") return fromSpecs;
  const match = /^HDRF-(\d{3})/.exec(ctx.item.code);
  return match ? Number(match[1]) : null;
}

export function HdrfForm({ ctx }: { ctx: FormContext }) {
  const width = widthOf(ctx);
  const crate = ctx.item.options.find((option) => option.role === "CRATE");

  return (
    <FormSheet ctx={ctx} title="Heavy Duty Roll Feeder Order Form">
      <EndUserSection ctx={ctx} />

      <SectionRow>
        <Section title="Model">
          <TickGrid variant="row">
            {MODELS.map((model) => (
              <Tick key={model} lead on={width === model}>
                HDRF-<span className="pf-num">{model}</span>
              </Tick>
            ))}
          </TickGrid>
        </Section>

        <Section title="Packing">
          <TickGrid variant="one">
            <Tick on={hasRole(ctx, "CRATE")} code={crate?.code ?? (width ? `Crate-HDRF-${width}` : "Crate")} desc="Wooden crate" />
          </TickGrid>
        </Section>
      </SectionRow>

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

      <Footnote provenance={provenance(ctx, "hdrf")} />
    </FormSheet>
  );
}
