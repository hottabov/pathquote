import {
  SOFTWARE_BOXES,
  softwareQty,
  unlistedSoftware,
  type SoftwareFormContext,
} from "@/lib/production-forms/software";
import { EndUserBand, SheetShell } from "./form-sheet";
import { Footnote, OfficeUse, Section, Tick, TickGrid, WriteIn } from "./primitives";

/**
 * The Software Order Form.
 *
 * One sheet per quote rather than one per item: software has no machine to
 * hang off, and a quote selling three programs is one order, not three
 * sheets. Every program the catalogue sells has a box; the ones on this
 * quote are ticked, with the figure in the box when more than one licence
 * was sold.
 *
 * Martin's sheet, not Jeff's -- nothing here is built, so there is no model,
 * no interface side and no crate. Software sold as an option ON a machine
 * (PTW-I, the PathWorks modules) prints in that machine's PathWorks row
 * instead; the footnote says so, because the same code can arrive either
 * way and the two sheets must not look like two orders for one licence.
 */
export function SoftwareForm({ ctx }: { ctx: SoftwareFormContext }) {
  const unlisted = unlistedSoftware(ctx.items);

  return (
    <SheetShell
      header={{
        title: "Software Order Form",
        kicker: "Software order",
        distributorName: ctx.distributorName,
        authorName: ctx.authorName,
        documentNumber: ctx.documentNumber,
        logo: ctx.logo,
      }}
    >
      <EndUserBand company={ctx.company} contact={ctx.contact} />

      <Section title="Software ordered" hint="box shows the quantity when more than one licence">
        <TickGrid>
          {SOFTWARE_BOXES.map((box) => (
            <Tick key={box.code} qty={softwareQty(ctx.items, box.code)} code={box.code} desc={box.name} />
          ))}
        </TickGrid>
        {box(unlisted)}
      </Section>

      <Section title="Installation notes">
        <WriteIn label="Computer, operating system and who to contact for the install" />
      </Section>

      <OfficeUse
        fields={[
          "Licence / registration no.",
          "Issued date",
          "Person",
          "Sent to",
          "Client expected install",
          "Actual install date",
        ]}
        signature="Salesman confirmation — signed"
        hint="completed by hand in the office"
      />

      <Footnote
        note="Software supplied with a machine is ordered on that machine's own form, under PathWorks."
        provenance={`SOFTWARE · ${ctx.documentNumber} · ${stamp(ctx.generatedAt)}`}
      />
    </SheetShell>
  );
}

/** dd.mm.yyyy, the same stamp every other sheet's provenance carries. */
function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/**
 * Software on the quote with no box of its own -- a catalogue row added
 * since the printed list was written. Named rather than dropped: the machine
 * forms send an option they cannot express to the Additional items sheet for
 * the same reason.
 */
function box(unlisted: ReturnType<typeof unlistedSoftware>) {
  if (unlisted.length === 0) return null;
  return (
    <div className="pf-subrow">
      <span className="pf-lb">Also ordered</span>
      <TickGrid variant="row">
        {unlisted.map((item) => (
          <Tick key={item.code} qty={item.qty} code={item.code} desc={item.name} />
        ))}
      </TickGrid>
    </div>
  );
}
