import { describe, it, expect } from "vitest";
import {
  QUOTE_DOCUMENT_KEY_REGEX,
  quoteDocumentSchema,
  newQuoteDocumentSchema,
  reorderQuoteDocumentsSchema,
  isQuoteDocumentKeyPermutation,
  regionCodeSchema,
  quoteTermsSchema,
  documentExclusionsSchema,
} from "../src/lib/validation/quote-documents";
import { accepts, rejects, expectValid } from "./helpers/schema";

describe("QUOTE_DOCUMENT_KEY_REGEX", () => {
  it("accepts the real document keys", () => {
    for (const key of ["terms", "conditions", "rsp", "dpa"]) {
      expect(QUOTE_DOCUMENT_KEY_REGEX.test(key), `expected "${key}" to match`).toBe(true);
    }
  });

  it("rejects keys shorter than 2 characters", () => {
    expect(QUOTE_DOCUMENT_KEY_REGEX.test("a")).toBe(false);
  });

  it("rejects keys longer than 60 characters", () => {
    expect(QUOTE_DOCUMENT_KEY_REGEX.test("a".repeat(61))).toBe(false);
  });

  it("accepts a key at exactly the 60 character bound", () => {
    expect(QUOTE_DOCUMENT_KEY_REGEX.test("a".repeat(60))).toBe(true);
  });

  it("rejects keys with spaces or other punctuation", () => {
    for (const key of ["general conditions", "terms/conditions", "terms_conditions", "rsp!"]) {
      expect(QUOTE_DOCUMENT_KEY_REGEX.test(key), `expected "${key}" to be rejected`).toBe(false);
    }
  });
});

describe("quoteDocumentSchema", () => {
  const base = {
    title: "Terms",
    body: "<p>Delivery in {{deliveryWeeks}} weeks.</p>",
    includedByDefault: "on",
  };

  it("accepts a valid document and coerces the checkbox", () => {
    const data = expectValid(quoteDocumentSchema, base);
    expect(data.title).toBe("Terms");
    expect(data.includedByDefault).toBe(true);
  });

  it("treats an absent/unchecked includedByDefault as false", () => {
    const withoutFlag = { title: base.title, body: base.body };
    const data = expectValid(quoteDocumentSchema, withoutFlag);
    expect(data.includedByDefault).toBe(false);
  });

  rejects(quoteDocumentSchema, [
    ["a missing title", { ...base, title: "" }],
    ["a title over 200 characters", { ...base, title: "A".repeat(201) }],
    ["a title that is only whitespace", { ...base, title: "   " }],
  ]);

  accepts(quoteDocumentSchema, [
    ["a body at exactly the 20000 character bound", { ...base, body: `<p>${"A".repeat(19993)}</p>` }],
  ]);

  rejects(quoteDocumentSchema, [
    ["an empty body", { ...base, body: "" }],
    ["a body over 20000 characters", { ...base, body: "A".repeat(20001) }],
  ]);

  // The lesson from Plan 2: Tiptap's getHTML() never returns "" for an
  // emptied document, so the emptiness check has to catch every shape it
  // actually produces — the same three tested against
  // seriesQuoteDescriptionSchema, but rejected here rather than mapped to
  // null: unlike a category's copy, a legal document must not print blank.
  rejects(quoteDocumentSchema, [
    ["an untouched empty Tiptap document (<p></p>)", { ...base, body: "<p></p>" }],
    ["a paragraph emptied with just a line break (<p><br></p>)", { ...base, body: "<p><br></p>" }],
    ["a paragraph emptied to a non-breaking space (<p>&nbsp;</p>)", { ...base, body: "<p>&nbsp;</p>" }],
    ["several empty paragraphs stacked", { ...base, body: "<p></p><p><br></p>" }],
  ]);

  it("accepts a body that has real text alongside an empty paragraph", () => {
    expectValid(quoteDocumentSchema, { ...base, body: "<p>Real text.</p><p></p>" });
  });
});

describe("newQuoteDocumentSchema", () => {
  const base = {
    key: "dpa",
    title: "Data Processing Agreement",
    body: "<p>Standard clauses.</p>",
    includedByDefault: "on",
    sortOrder: "30",
  };

  it("accepts a valid new document and coerces sortOrder", () => {
    const data = expectValid(newQuoteDocumentSchema, base);
    expect(data.sortOrder).toBe(30);
  });

  rejects(newQuoteDocumentSchema, [["an invalid key", { ...base, key: "bad key!" }]]);

  it("defaults a missing/blank sortOrder to 0", () => {
    for (const sortOrder of [undefined, null, ""]) {
      const data = expectValid(newQuoteDocumentSchema, { ...base, sortOrder });
      expect(data.sortOrder).toBe(0);
    }
  });

  rejects(newQuoteDocumentSchema, [
    ["a negative sortOrder", { ...base, sortOrder: "-1" }],
    ["a non-integer sortOrder", { ...base, sortOrder: "1.5" }],
    ["a blank body, same rule as the plain schema", { ...base, body: "<p></p>" }],
  ]);

  // The key is the document's permanent identity: it is what `/documents/<key>`
  // resolves, what a per-quote `DocumentExclusion` stores instead of an id, and
  // what the ContentBlock migration wrote. Nothing renames one. So the one
  // moment it is typed is the only chance to canonicalize it — Postgres
  // compares "DPA" and "dpa" as different keys, which would give an admin two
  // documents they believe are one, each printing on a different quote.
  it("normalizes a new key to lowercase and trims it", () => {
    const data = expectValid(newQuoteDocumentSchema, { ...base, key: "  DPA  " });
    expect(data.key).toBe("dpa");
  });

  // `/documents/new` is the create page itself. Next.js matches a static
  // segment before the `[key]` one, so a document keyed "new" would be created
  // successfully and then be unreachable forever — its editor URL would keep
  // serving the create form. Refused at the only door it can enter by.
  rejects(newQuoteDocumentSchema, [
    ["the reserved key that the create route already occupies", { ...base, key: "new" }, "reserved"],
    ["that reserved key in another case", { ...base, key: "New" }, "reserved"],
  ]);
});

describe("reorderQuoteDocumentsSchema", () => {
  accepts(reorderQuoteDocumentsSchema, [["a list of distinct keys", ["terms", "conditions", "rsp"]]]);

  rejects(reorderQuoteDocumentsSchema, [
    ["an empty list", []],
    ["a list with a duplicate key", ["terms", "terms"]],
  ]);
});

describe("isQuoteDocumentKeyPermutation", () => {
  it("accepts the same keys in a different order", () => {
    expect(isQuoteDocumentKeyPermutation(["rsp", "terms", "conditions"], ["terms", "conditions", "rsp"])).toBe(true);
  });

  it("rejects a proposed list missing a key", () => {
    expect(isQuoteDocumentKeyPermutation(["terms"], ["terms", "conditions"])).toBe(false);
  });

  it("rejects a proposed list carrying a foreign key", () => {
    expect(isQuoteDocumentKeyPermutation(["terms", "made-up"], ["terms", "conditions"])).toBe(false);
  });

  it("treats two empty lists as a permutation of each other", () => {
    expect(isQuoteDocumentKeyPermutation([], [])).toBe(true);
  });
});

describe("regionCodeSchema (re-exported)", () => {
  accepts(regionCodeSchema, [["a lowercase code, normalized to uppercase", "uk", "UK"]]);
  rejects(regionCodeSchema, [["an empty code", ""]]);
});

describe("quoteTermsSchema", () => {
  const inherited = { deliveryWeeks: "", installationDays: "", trainingDays: "", warrantyMonths: "" };
  const allNull = { deliveryWeeks: null, installationDays: null, trainingDays: null, warrantyMonths: null };

  accepts(quoteTermsSchema, [
    ["four blank fields, every figure inherited", inherited, allNull],
    ["explicit nulls, the same as blank", allNull, allNull],
    [
      "figures typed as the strings a form submits",
      { ...inherited, deliveryWeeks: "10", warrantyMonths: "24" },
      { ...allNull, deliveryWeeks: 10, warrantyMonths: 24 },
    ],
    ["a figure typed with surrounding whitespace", { ...inherited, trainingDays: " 3 " }, { ...allNull, trainingDays: 3 }],
    ["figures already coerced to numbers", { ...inherited, installationDays: 2 }, { ...allNull, installationDays: 2 }],
    ["a figure at the 999 ceiling", { ...inherited, deliveryWeeks: "999" }, { ...allNull, deliveryWeeks: 999 }],
    // An omitted field reads as blank reads as inherited — the same answer
    // `undefined` gets everywhere else in this schema. The panel always
    // submits all four, so this is a floor rather than a supported call.
    ["an omitted field, read as inherited", { deliveryWeeks: "1" }, { ...allNull, deliveryWeeks: 1 }],
  ]);

  // The rule the whole feature turns on: "Installation: 0 days" is a real
  // thing to promise for a self-install, so a typed zero must survive as `0`
  // and not be folded into the blank that means "inherit the region's". A
  // `z.coerce.number` applied before the blank test would make `""` into `0`
  // and lose the distinction in the other direction too.
  it("keeps a typed zero as a real override, distinct from a blank field", () => {
    const parsed = expectValid(quoteTermsSchema, { ...inherited, installationDays: "0" });
    expect(parsed.installationDays).toBe(0);
    expect(parsed.deliveryWeeks).toBeNull();
  });

  it("keeps a numeric zero as a real override too", () => {
    expect(expectValid(quoteTermsSchema, { ...inherited, installationDays: 0 }).installationDays).toBe(0);
  });

  rejects(quoteTermsSchema, [
    ["a negative figure", { ...inherited, deliveryWeeks: "-1" }, "Enter 0 or more"],
    ["a fractional figure", { ...inherited, warrantyMonths: "12.5" }, "Enter a whole number"],
    ["a figure past the ceiling", { ...inherited, deliveryWeeks: "1000" }, "Enter 999 or less"],
    ["text where a figure belongs", { ...inherited, trainingDays: "soon" }, "Enter a whole number"],
  ]);
});

describe("documentExclusionsSchema", () => {
  accepts(documentExclusionsSchema, [
    ["an empty list — the common quote, which excludes nothing", []],
    ["a list of real document keys", ["rsp"]],
    ["several distinct keys", ["rsp", "conditions"]],
  ]);

  rejects(documentExclusionsSchema, [
    ["a duplicated key", ["rsp", "rsp"], "Duplicate document"],
    ["a key that is not a document key at all", ["general conditions"]],
    ["something that is not a list", "rsp"],
  ]);
});
