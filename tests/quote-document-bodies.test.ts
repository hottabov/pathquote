// The assembly half of Task 10's one-shot migration: 21 ContentBlock
// fragments become the two documents a customer signs. That migration has
// been applied and its script is gone with the model it read, but these
// functions are still what produced both the rows in the live database and
// the bodies in prisma/seed-data/quote-documents.json — so what they do is
// still the definition of how that legal text is shaped, and still worth
// pinning.
//
// Pure: no DB, no next/*, same discipline as rich-text.test.ts.
import { describe, it, expect } from "vitest";
import {
  assembleConditionsBody,
  assembleTermsBody,
  buildConditionsBody,
  buildSingleBlockBody,
  buildTermsBody,
  countStructure,
  orderBlocks,
  type LegalBlock,
} from "../scripts/lib/quote-document-bodies";
import { sanitizeRichText } from "../src/lib/rich-text";

function block(overrides: Partial<LegalBlock> & Pick<LegalBlock, "key">): LegalBlock {
  return { title: null, body: "", sortOrder: 0, ...overrides };
}

describe("orderBlocks", () => {
  it("orders by sortOrder, not by the order the rows arrived in", () => {
    const ordered = orderBlocks([
      block({ key: "terms.warranty", sortOrder: 34 }),
      block({ key: "terms.delivery", sortOrder: 30 }),
      block({ key: "terms.schedule", sortOrder: 32 }),
    ]);
    expect(ordered.map((b) => b.key)).toEqual(["terms.delivery", "terms.schedule", "terms.warranty"]);
  });

  it("breaks a sortOrder tie by key, so a re-run assembles the same document", () => {
    const ordered = orderBlocks([
      block({ key: "conditions.b", sortOrder: 40 }),
      block({ key: "conditions.a", sortOrder: 40 }),
    ]);
    expect(ordered.map((b) => b.key)).toEqual(["conditions.a", "conditions.b"]);
  });

  it("does not mutate its input", () => {
    const input = [block({ key: "b", sortOrder: 2 }), block({ key: "a", sortOrder: 1 })];
    orderBlocks(input);
    expect(input.map((b) => b.key)).toEqual(["b", "a"]);
  });
});

describe("buildTermsBody", () => {
  it("gives each block an h2 of its title followed by its body, in sortOrder", () => {
    const html = buildTermsBody([
      block({ key: "terms.warranty", title: "Warranty", body: "{{warrantyMonths}}-month parts warranty.", sortOrder: 34 }),
      block({ key: "terms.delivery", title: "Delivery", body: "Included in sale price.", sortOrder: 30 }),
    ]);
    expect(html).toBe(
      "<h2>Delivery</h2>\n<p>Included in sale price.</p>\n<h2>Warranty</h2>\n<p>{{warrantyMonths}}-month parts warranty.</p>"
    );
  });

  it("renders a block with no title as its body alone, not as an empty heading", () => {
    // The rule TermsSection had: "a block whose content block carries no title
    // renders its body alone rather than an empty heading".
    const html = buildTermsBody([block({ key: "terms.preamble", title: null, body: "No heading here." })]);
    expect(html).toBe("<p>No heading here.</p>");
    expect(html).not.toContain("<h2>");
  });

  it("keeps a markdown list a list", () => {
    const html = buildTermsBody([
      block({
        key: "terms.schedule",
        title: "Schedule",
        body: "- Installation approx. {{installationDays}} days.\n- Operator training approx. {{trainingDays}} days.",
      }),
    ]);
    expect(html).toBe(
      "<h2>Schedule</h2>\n<ul><li>Installation approx. {{installationDays}} days.</li><li>Operator training approx. {{trainingDays}} days.</li></ul>"
    );
  });

  it("leaves a body that is already HTML as HTML rather than re-escaping it", () => {
    // A block an admin re-saved through the Tiptap editor is stored as HTML,
    // not markdown. renderStoredRichText sanitizes that branch instead of
    // running renderMarkdown over it, which would have escaped every tag into
    // visible &lt;p&gt; on the printed quote.
    const html = buildTermsBody([
      block({ key: "terms.payment", title: "Price and Payment Terms", body: "<p>Deposit <strong>30%</strong> on order.</p>" }),
    ]);
    expect(html).toBe("<h2>Price and Payment Terms</h2>\n<p>Deposit <strong>30%</strong> on order.</p>");
  });

  it("escapes a title's & and < rather than emitting them raw", () => {
    const html = buildTermsBody([
      block({ key: "terms.x", title: "Delivery & <Installation>", body: "Body." }),
    ]);
    expect(html).toContain("<h2>Delivery &amp; &lt;Installation&gt;</h2>");
    expect(html).not.toContain("<Installation>");
  });

  it("keeps document tokens intact for the renderer to substitute", () => {
    const html = buildTermsBody([
      block({ key: "terms.delivery", title: "Delivery", body: "Estimated {{deliveryWeeks}} weeks." }),
    ]);
    expect(html).toContain("{{deliveryWeeks}}");
  });

  it("is empty for no blocks at all", () => {
    expect(buildTermsBody([])).toBe("");
  });

  it("survives sanitizeRichText unchanged", () => {
    const html = buildTermsBody([
      block({ key: "terms.delivery", title: "Delivery & Freight", body: "Included in sale price.", sortOrder: 30 }),
      block({ key: "terms.schedule", title: "Schedule", body: "- One.\n- Two.", sortOrder: 32 }),
      block({ key: "terms.plain", title: null, body: 'He said "yes" — it\'s fine.', sortOrder: 33 }),
    ]);
    expect(sanitizeRichText(html)).toBe(html);
  });
});

describe("buildConditionsBody", () => {
  it("makes one ol whose li opens with the clause title in strong", () => {
    const html = buildConditionsBody([
      block({ key: "conditions.1", title: "Sales Price", body: "The present general conditions govern the sale.", sortOrder: 37 }),
    ]);
    expect(html).toBe(
      "<ol>\n<li><p><strong>Sales Price</strong></p><p>The present general conditions govern the sale.</p></li>\n</ol>"
    );
  });

  it("orders the clauses by sortOrder inside one list", () => {
    const html = buildConditionsBody([
      block({ key: "conditions.2", title: "Delivery", body: "Second.", sortOrder: 38 }),
      block({ key: "conditions.1", title: "Sales Price", body: "First.", sortOrder: 37 }),
    ]);
    expect(html.indexOf("Sales Price")).toBeLessThan(html.indexOf("Delivery"));
    expect(countStructure(html).listItems).toBe(2);
  });

  it("numbers nothing itself — fourteen clauses are fourteen li in one ol", () => {
    // ConditionsSection printed "{index + 1}. {title}"; that component is gone
    // and the numbering is the list's own from here on. A literal "1." in the
    // markup would print twice over.
    const html = buildConditionsBody(
      Array.from({ length: 14 }, (_, i) =>
        block({ key: `conditions.${i + 1}`, title: `Clause ${i + 1}`, body: `Body ${i + 1}.`, sortOrder: 37 + i })
      )
    );
    expect(countStructure(html).listItems).toBe(14);
    expect(html.match(/<ol\b/g)).toHaveLength(1);
    expect(html).not.toContain("<strong>1. ");
    expect(html.indexOf("Clause 2")).toBeLessThan(html.indexOf("Clause 10"));
  });

  it("keeps every paragraph of a multi-paragraph clause inside its own li", () => {
    const html = buildConditionsBody([
      block({ key: "conditions.2", title: "Delivery Periods", body: "2.1 First para.\n\n2.2 Second para.", sortOrder: 38 }),
    ]);
    expect(html).toContain("<li><p><strong>Delivery Periods</strong></p><p>2.1 First para.</p>\n<p>2.2 Second para.</p></li>");
    expect(countStructure(html).listItems).toBe(1);
  });

  it("renders a clause with no title as an li of its body alone", () => {
    const html = buildConditionsBody([block({ key: "conditions.9", title: null, body: "Untitled clause." })]);
    expect(html).toBe("<ol>\n<li><p>Untitled clause.</p></li>\n</ol>");
  });

  it("escapes a clause title's & and <", () => {
    const html = buildConditionsBody([
      block({ key: "conditions.8", title: "Software & <Licences>", body: "Body." }),
    ]);
    expect(html).toContain("<strong>Software &amp; &lt;Licences&gt;</strong>");
  });

  it("emits no empty ol for no clauses at all", () => {
    expect(buildConditionsBody([])).toBe("");
  });

  it("survives sanitizeRichText unchanged", () => {
    // If the allowlist strips something this emitted, this emitted the wrong
    // thing: every editor save runs the same sanitizer, so an admin merely
    // opening and saving the document would silently change it.
    const html = buildConditionsBody([
      block({ key: "conditions.1", title: "Sales Price & Terms", body: 'The word "Equipment" shall mean the combination.', sortOrder: 37 }),
      block({ key: "conditions.2", title: "Delivery", body: "2.1 One.\n\n2.2 Two.\n\n- a\n- b", sortOrder: 38 }),
      block({ key: "conditions.3", title: null, body: "Untitled.", sortOrder: 39 }),
    ]);
    expect(sanitizeRichText(html)).toBe(html);
  });
});

describe("buildSingleBlockBody", () => {
  it("prints the body alone — the document's own title is the section heading", () => {
    const html = buildSingleBlockBody(
      block({ key: "rsp.agreement", title: "Pathfinder Remote Support Program (RSP)", body: "## Pathfinder RSP\n\nRSP was created to provide support." })
    );
    expect(html).toBe("<h2>Pathfinder RSP</h2>\n<p>RSP was created to provide support.</p>");
    // The block's own `title` column is not printed: RspSection never rendered
    // it either, and DocumentsSection prints QuoteDocument.title above this.
    expect(html).not.toContain("Pathfinder Remote Support Program (RSP)");
  });

  it("survives sanitizeRichText unchanged", () => {
    const html = buildSingleBlockBody(
      block({ key: "rsp.agreement", title: null, body: "**Low Cost • Free Support**\n\n- Email: support@example.com" })
    );
    expect(sanitizeRichText(html)).toBe(html);
  });
});

describe("the sanitizer is what the assembly is measured against", () => {
  it("reports an h1 as a difference between assembly and build", () => {
    // renderMarkdown turns "# Heading" into <h1>, which is NOT on
    // ALLOWED_TAGS (the Tiptap editor only ever produces h2/h3), so the
    // sanitizer drops the tag and keeps the words. The migration's dry run
    // prints this as [SANITIZED] rather than letting a body quietly differ
    // from the fragments it was built from.
    const blocks = [block({ key: "terms.x", title: "T", body: "# Shouty heading" })];
    expect(assembleTermsBody(blocks)).toContain("<h1>");
    expect(buildTermsBody(blocks)).not.toContain("<h1>");
    expect(buildTermsBody(blocks)).toContain("Shouty heading");
  });

  it("leaves an ordinary conditions assembly untouched", () => {
    const blocks = [block({ key: "conditions.1", title: "Sales Price", body: "Body." })];
    expect(buildConditionsBody(blocks)).toBe(assembleConditionsBody(blocks));
  });
});

describe("countStructure", () => {
  it("counts li and h2", () => {
    expect(countStructure("<ol>\n<li>a</li>\n<li>b</li>\n</ol>")).toEqual({ listItems: 2, headings: 0 });
    expect(countStructure("<h2>A</h2>\n<p>x</p>\n<h2>B</h2>")).toEqual({ listItems: 0, headings: 2 });
  });
});
