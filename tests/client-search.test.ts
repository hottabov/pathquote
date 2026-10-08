import { describe, it, expect } from "vitest";
import {
  CLIENT_SEARCH_MAX_LENGTH,
  CLIENT_SEARCH_MAX_WORDS,
  CLIENT_SEARCH_MIN_LENGTH,
  clientResultLabel,
  clientSearchTerm,
  clientSearchWhere,
  clientSearchWords,
} from "../src/lib/client-search";
import { companyWhereForUser } from "../src/lib/scope";

describe("clientSearchTerm", () => {
  it("returns a term at the minimum length as is", () => {
    expect("abc".length).toBe(CLIENT_SEARCH_MIN_LENGTH);
    expect(clientSearchTerm("abc")).toBe("abc");
  });

  it("returns the empty term, meaning no search, below the minimum", () => {
    expect(clientSearchTerm("")).toBe("");
    expect(clientSearchTerm("a")).toBe("");
    expect(clientSearchTerm("ab")).toBe("");
  });

  it("measures length after trimming: padding is not a search", () => {
    expect(clientSearchTerm("   ab   ")).toBe("");
    expect(clientSearchTerm("      ")).toBe("");
    expect(clientSearchTerm("  abc  ")).toBe("abc");
  });

  it("collapses runs of whitespace, so equivalent queries are one search", () => {
    expect(clientSearchTerm("  pt   noitex ")).toBe("pt noitex");
    expect(clientSearchTerm("pt\t\nnoitex")).toBe("pt noitex");
  });

  it("keeps case: the database compares case-insensitively, the term is not folded", () => {
    expect(clientSearchTerm("PT Noitex")).toBe("PT Noitex");
  });

  it("cuts an over-long query at the maximum", () => {
    const term = clientSearchTerm("x".repeat(CLIENT_SEARCH_MAX_LENGTH + 50));
    expect(term).toHaveLength(CLIENT_SEARCH_MAX_LENGTH);
  });

  it("does not leave a trailing space where the cut falls on one", () => {
    const raw = `${"x".repeat(CLIENT_SEARCH_MAX_LENGTH - 1)} yyy`;
    expect(clientSearchTerm(raw)).toBe("x".repeat(CLIENT_SEARCH_MAX_LENGTH - 1));
  });
});

describe("clientSearchWords", () => {
  it("is empty for the empty term", () => {
    expect(clientSearchWords("")).toEqual([]);
  });

  it("splits on the single spaces clientSearchTerm leaves", () => {
    expect(clientSearchWords("john smith")).toEqual(["john", "smith"]);
  });

  it("ignores words past the maximum", () => {
    const words = clientSearchWords("a b c d e f g");
    expect(words).toHaveLength(CLIENT_SEARCH_MAX_WORDS);
    expect(words).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("clientSearchWhere", () => {
  const manager = { id: "u1", role: "MANAGER" };
  const granted = { id: "u1", role: "MANAGER", visibleCountries: ["AU", "NZ"] };

  it("is the scope alone, untouched, for the empty term", () => {
    const scope = companyWhereForUser(manager);
    expect(clientSearchWhere(scope, "")).toBe(scope);
  });

  it("is the empty filter for an admin with no search: every company", () => {
    expect(clientSearchWhere(companyWhereForUser({ id: "a", role: "ADMIN" }), "")).toEqual({});
  });

  it("keeps the scope intact as the first AND clause", () => {
    const scope = companyWhereForUser(manager);
    const where = clientSearchWhere(scope, "noitex");
    expect(where).toHaveProperty("AND");
    expect((where as { AND: unknown[] }).AND[0]).toBe(scope);
  });

  it("does not let the search replace a country grant's OR (and the reverse)", () => {
    // The trap this pins: companyWhereForUser returns { OR: [owned, country in] }
    // for a manager with a grant, and the search needs an OR of its own. A
    // spread of both would keep only one of them.
    const scope = companyWhereForUser(granted);
    expect(scope).toHaveProperty("OR");

    const where = clientSearchWhere(scope, "noitex") as { AND: Record<string, unknown>[] };
    expect(where).not.toHaveProperty("OR");
    expect(where.AND).toHaveLength(2);
    expect(where.AND[0]).toEqual({
      OR: [{ ownerId: "u1" }, { country: { in: ["AU", "NZ"] } }],
    });
    expect(where.AND[1]).toHaveProperty("OR");
  });

  it("matches a word on the company name or on a contact's first or last name, case-insensitively", () => {
    const where = clientSearchWhere({}, "noitex") as { AND: unknown[] };
    const contains = { contains: "noitex", mode: "insensitive" };
    expect(where.AND[1]).toEqual({
      OR: [
        { name: contains },
        { contacts: { some: { OR: [{ firstName: contains }, { lastName: contains }] } } },
      ],
    });
  });

  it("requires every word, each matching somewhere", () => {
    const where = clientSearchWhere({}, "john smith") as { AND: unknown[] };
    expect(where.AND).toHaveLength(3);
  });

  it("does not search past the maximum number of words", () => {
    const where = clientSearchWhere({}, "a b c d e f g h") as { AND: unknown[] };
    expect(where.AND).toHaveLength(1 + CLIENT_SEARCH_MAX_WORDS);
  });
});

describe("clientResultLabel", () => {
  const acme = {
    name: "Acme Pty Ltd",
    contacts: [
      { firstName: "John", lastName: "Smith" },
      { firstName: "Anna", lastName: "Jones" },
      { firstName: "Joan", lastName: null },
    ],
  };

  it("is the bare name when there is no search", () => {
    expect(clientResultLabel(acme, "")).toBe("Acme Pty Ltd");
  });

  it("is the bare name when the company name holds every word", () => {
    expect(clientResultLabel(acme, "acme")).toBe("Acme Pty Ltd");
    expect(clientResultLabel(acme, "pty acme")).toBe("Acme Pty Ltd");
  });

  it("names the contacts that matched when the name does not explain the result", () => {
    expect(clientResultLabel(acme, "smith")).toBe("Acme Pty Ltd — John Smith");
  });

  it("matches on a last name or a first name, ignoring case", () => {
    expect(clientResultLabel(acme, "JONES")).toBe("Acme Pty Ltd — Anna Jones");
    expect(clientResultLabel(acme, "anna")).toBe("Acme Pty Ltd — Anna Jones");
  });

  it("names a contact with no last name by its first name alone", () => {
    expect(clientResultLabel(acme, "joan")).toBe("Acme Pty Ltd — Joan");
  });

  it("shows two contacts and counts the rest", () => {
    expect(clientResultLabel(acme, "jo")).toBe("Acme Pty Ltd — John Smith, Anna Jones +1");
  });

  it("names a contact for a word the company name does not hold, even when another word it does", () => {
    expect(clientResultLabel(acme, "pty smith")).toBe("Acme Pty Ltd — John Smith");
  });

  it("falls back to the bare name when no contact explains the words", () => {
    expect(clientResultLabel(acme, "zzz")).toBe("Acme Pty Ltd");
  });
});
