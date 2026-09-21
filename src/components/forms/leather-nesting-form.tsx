import type { FormContext } from "@/lib/production-forms/types";
import { EndUserSection, FormSheet, provenance } from "./form-sheet";
import { Footnote, OfficeUse, Section } from "./primitives";

/**
 * Leather Nesting System order form.
 *
 * The sheet asks nothing: an LNS is one fixed system, so the form states what
 * it consists of and the only thing that varies is the static table's width,
 * which the product code already says (`LNS-2420` -> 2420). Text as the owner
 * supplied it (Vadym, 2026-09-18).
 */

/** The table width from the product code -- `LNS-2420` -> "2420". */
export function lnsModel(code: string): string | null {
  const match = /(\d{3,4})\s*$/.exec(code.trim());
  return match ? match[1] : null;
}

const SOFTWARE = [
  "PathWorks™ (standalone) CAD software",
  "ANT-V6 — Automatic Nesting licence, optioned within PathWorks™",
  "WHD — Leather Hide Wizard",
];

export function LeatherNestingForm({ ctx }: { ctx: FormContext }) {
  const model = lnsModel(ctx.item.code);

  const hardware = [
    // No width in the code (a renamed product) prints the label without one
    // rather than an invented number: the workshop asks rather than guesses.
    model ? `Static table ${model}` : "Static table",
    "Operator console with utility drawer, including mounting bracket for the Pathfinder EasyLoader side frame",
    "Windows computer, keyboard, mouse and Microsoft Surface Dial",
    "Digital SLR camera and adjustable camera stand",
  ];

  return (
    <FormSheet ctx={ctx} title="Leather Nesting System Order Form">
      <EndUserSection ctx={ctx} />

      <Section title="Camera Nesting System comprises">
        <div className="pf-notes pf-comprises">
          <div>
            <span className="pf-cap">System</span>
            <ul>
              {hardware.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div>
            <span className="pf-cap">Software</span>
            <ul>
              {SOFTWARE.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <OfficeUse
        fields={[
          "System serial no.",
          "System reg. no.",
          "Distribution date",
          "Person",
          "Client expected install",
          "Actual install date",
        ]}
      />

      <Footnote
        note="WHD — Leather Hide Wizard is only sold as part of a Leather Nesting System."
        provenance={provenance(ctx, "leather-nesting")}
      />
    </FormSheet>
  );
}
