import type { FormContext } from "@/lib/production-forms/types";
import { EndUserSection, FormSheet, provenance } from "./form-sheet";
import { ScreenSideBlock } from "./m-series-form";
import { Footnote, OfficeUse, Section, SectionRow, Tick, TickGrid } from "./primitives";

/**
 * The EasyFeeder order form: the header every machine form carries, the
 * model, the control box side, and the office block. See `easyFeederSpec` for
 * why nothing else is asked -- no voltage, no freight.
 *
 * The model is the table width the feeder is built for, the same four as
 * the EasyLoader. It comes from the product (`specs.tableWidthMm`), with the
 * code as a fallback for a row that predates that spec.
 */

const MODELS = [2020, 2420, 3220, 4030] as const;

function widthOf(ctx: FormContext): number | null {
  const fromSpecs = ctx.item.specs.tableWidthMm;
  if (typeof fromSpecs === "number") return fromSpecs;
  const match = /^EF-(\d{4})/.exec(ctx.item.code);
  return match ? Number(match[1]) : null;
}

export function EasyFeederForm({ ctx }: { ctx: FormContext }) {
  const width = widthOf(ctx);
  const spec = ctx.item.spec as { ui?: string };
  const side = spec.ui ?? "-Y";

  return (
    <FormSheet ctx={ctx} title="EasyFeeder Order Form">
      <EndUserSection ctx={ctx} />

      <SectionRow>
        <Section title="Model">
          <TickGrid variant="four">
            {MODELS.map((model) => (
              <Tick key={model} lead on={width === model}>
                EF-<span className="pf-num">{model}</span>
              </Tick>
            ))}
          </TickGrid>
        </Section>
        <Section title="Control box side">
          {/* The same block every other machine form prints -- the section
              band already names it, so no second label. */}
          <ScreenSideBlock ctx={ctx} side={side} label={null} />
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

      <Footnote provenance={provenance(ctx, "easyfeeder")} />
    </FormSheet>
  );
}
