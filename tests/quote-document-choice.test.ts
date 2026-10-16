import { describe, it, expect } from "vitest";
import {
  isQuoteDocumentIncluded,
  toQuoteDocumentChoices,
  withQuoteDocumentChoice,
} from "../src/lib/quote-document-choice";

const terms = { key: "terms", includedByDefault: true };
const rspPlus = { key: "rsp-plus", includedByDefault: false };

describe("isQuoteDocumentIncluded", () => {
  it("follows the document's default when the quote made no choice", () => {
    expect(isQuoteDocumentIncluded(terms, {})).toBe(true);
    expect(isQuoteDocumentIncluded(rspPlus, {})).toBe(false);
  });

  it("follows the quote's choice over the default, either way", () => {
    expect(isQuoteDocumentIncluded(terms, { terms: false })).toBe(false);
    expect(isQuoteDocumentIncluded(rspPlus, { "rsp-plus": true })).toBe(true);
  });

  it("reads only the quote's own keys, never an inherited property", () => {
    expect(isQuoteDocumentIncluded({ key: "constructor", includedByDefault: false }, {})).toBe(false);
  });
});

describe("withQuoteDocumentChoice", () => {
  it("stores a tick that departs from the default", () => {
    expect(withQuoteDocumentChoice({}, rspPlus, true)).toEqual({ "rsp-plus": true });
    expect(withQuoteDocumentChoice({}, terms, false)).toEqual({ terms: false });
  });

  it("drops the choice when the tick lands back on the default", () => {
    expect(withQuoteDocumentChoice({ "rsp-plus": true, terms: false }, rspPlus, false)).toEqual({ terms: false });
  });
});

describe("toQuoteDocumentChoices", () => {
  it("keys the stored rows by document", () => {
    expect(
      toQuoteDocumentChoices([
        { quoteDocumentKey: "rsp", included: false },
        { quoteDocumentKey: "rsp-plus", included: true },
      ])
    ).toEqual({ rsp: false, "rsp-plus": true });
  });
});
