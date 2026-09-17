import { z } from "zod";
import type { FormSpec } from "../types";

/**
 * Leather Nesting Station. Jeff: "I will leave it by default" -- the sheet
 * prints a fixed list of what an LNS consists of (static table, console,
 * computer, camera, standalone PathWorks, ANT T6.0, the Hide Wizard, twelve
 * months of RSP) and asks nothing. There is nothing to tick and nothing to
 * choose, so this spec is a header and no more.
 *
 * Its header is laid out differently from the EasyFeed/HDRF/Punchline family
 * -- `Distributor:` in D7 rather than D10, and the End User labels run down
 * column E, not G -- so it does not use `machineSaleHeader`. The company name
 * goes in G11 because the original arrived with "Relaxvanguard" sitting
 * there; that sample, and the sample industry in I20, are blanked in the
 * committed template.
 *
 * The sheet prints "Industry:" twice, at E19 and again at G20. E19 is the one
 * in line with the rest of the End User labels and is the one filled here.
 * The stray second label is left alone: this template is a reference copy,
 * and tidying the printed form happens when it is redrawn in HTML.
 */
export const leatherNestingSpecSchema = z.object({});

export const leatherNestingSpec: FormSpec = {
  id: "leather-nesting",
  title: "Leather Nesting Station Order Form",
  renderer: "xlsx",
  template: "leather-nesting-station-01.xlsx",
  sheetPath: "xl/worksheets/sheet1.xml",
  form: "LNS",
  specSchema: leatherNestingSpecSchema,
  requires: [],

  values: [
    { cell: "G7", from: (c) => c.distributorName },
    { cell: "O7", from: (c) => c.authorName },
    { cell: "G11", from: (c) => c.company.name },
    // Two address rows, not three: `Contact:` starts at row 14. The tail is
    // joined into the second rather than dropped, the same way the M-Series
    // form handles its two-row address -- a silently missing country is a
    // wrong address.
    { cell: "G12", from: (c) => c.company.addressLines[0] },
    { cell: "G13", from: (c) => c.company.addressLines.slice(1).join(", ") },
    { cell: "G14", from: (c) => c.contact.fullName },
    { cell: "G15", from: (c) => c.contact.position },
    { cell: "G16", from: (c) => c.contact.phone },
    { cell: "G18", from: (c) => c.contact.email },
    { cell: "G19", from: (c) => c.company.industry },
  ],

  replaces: [],

  // The one box on the sheet, beside the "Leather Nesting Station" heading in
  // E24. There is nothing to decide -- an LNS item is an LNS -- but an empty
  // box on a printed form reads as an unanswered question, so it is ticked.
  ticks: [{ cell: "D24", when: () => true }],
};
