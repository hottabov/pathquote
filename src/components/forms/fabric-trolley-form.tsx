import type { FormContext } from "@/lib/production-forms/types";
import { EndUserSection, FormSheet, provenance } from "./form-sheet";
import { Field, Footnote, OfficeUse, Section } from "./primitives";

/**
 * FabricPro Fabric Trolley order form.
 *
 * The whole sheet is a header and one number, and that number is always 1:
 * one item is one machine, so two trolleys are two item lines and therefore
 * two sheets (Vadym, 2026-09-18 -- "На формі завжди 1 штука"). Nothing here
 * is read off the options, because the catalogue sells none for a trolley.
 *
 * `FP-TROLLEY` lives in the FPT series and prints this form rather than the
 * FabricPro one -- matching is on `Product.form`, not on the series.
 */

/** Every sheet prints one trolley; see the note above. */
const QUANTITY_REQUIRED = 1;

export function FabricTrolleyForm({ ctx }: { ctx: FormContext }) {
  return (
    <FormSheet ctx={ctx} title="FabricPro Trolley Order Form">
      <EndUserSection ctx={ctx} />

      <Section title="Quantity">
        <Field label="Quantity required" value={QUANTITY_REQUIRED} num />
      </Section>

      <OfficeUse
        fields={[
          "Distribution date",
          "Person",
          "Checked by",
          "Date",
          "Client expected install",
          "Actual install date",
        ]}
      />

      <Footnote
        note="One trolley per sheet — a quote for several prints one sheet each."
        provenance={provenance(ctx, "fabric-trolley")}
      />
    </FormSheet>
  );
}
