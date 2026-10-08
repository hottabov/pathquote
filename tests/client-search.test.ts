import { describe, it, expect } from "vitest";
import {
  CLIENT_SEARCH_MAX_LENGTH,
  CLIENT_SEARCH_MAX_WORDS,
  CLIENT_SEARCH_MIN_LENGTH,
  CLIENT_SEARCH_PAGE_SIZE,
  clientContactMatchText,
  clientLocation,
  clientSearchOrderBy,
  clientSearchStatus,
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

describe("CLIENT_SEARCH_PAGE_SIZE", () => {
  it("offers at least a hundred rows", () => {
    expect(CLIENT_SEARCH_PAGE_SIZE).toBeGreaterThanOrEqual(100);
  });
});

describe("clientSearchOrderBy", () => {
  it("puts the newest companies first when there is no term", () => {
    expect(clientSearchOrderBy("")).toEqual([{ createdAt: "desc" }, { id: "asc" }]);
  });

  it("orders by name when there is a term", () => {
    expect(clientSearchOrderBy("boats")).toEqual([{ name: "asc" }, { id: "asc" }]);
  });

  it("breaks ties by id either way, so a page does not reshuffle", () => {
    expect(clientSearchOrderBy("").at(-1)).toEqual({ id: "asc" });
    expect(clientSearchOrderBy("boats").at(-1)).toEqual({ id: "asc" });
  });

  it("treats a too-short query as no term, because clientSearchTerm does", () => {
    expect(clientSearchOrderBy(clientSearchTerm("bo"))).toEqual(clientSearchOrderBy(""));
  });
});

describe("clientLocation", () => {
  it("joins the city and the country's English name", () => {
    expect(clientLocation({ city: "Sydney", country: "AU" })).toBe("Sydney, Australia");
  });

  it("shows a country alone, or a city alone", () => {
    expect(clientLocation({ city: null, country: "NZ" })).toBe("New Zealand");
    expect(clientLocation({ city: "Perth", country: null })).toBe("Perth");
  });

  it("is null when neither is on file, including when they are blank", () => {
    expect(clientLocation({ city: null, country: null })).toBeNull();
    expect(clientLocation({ city: "  ", country: "" })).toBeNull();
  });

  it("keeps an older free-text country as it was stored", () => {
    expect(clientLocation({ city: "Lyon", country: "Narnia" })).toBe("Lyon, Narnia");
  });

  it("resolves an older free-text country that names a real one", () => {
    expect(clientLocation({ city: null, country: "Australia" })).toBe("Australia");
  });
});

describe("clientContactMatchText", () => {
  const acme = {
    name: "Acme Pty Ltd",
    contacts: [
      { firstName: "John", lastName: "Smith" },
      { firstName: "Anna", lastName: "Jones" },
      { firstName: "Joan", lastName: null },
    ],
  };

  it("is null when there is no search", () => {
    expect(clientContactMatchText(acme, "")).toBeNull();
  });

  it("is null when the company name holds every word", () => {
    expect(clientContactMatchText(acme, "acme")).toBeNull();
    expect(clientContactMatchText(acme, "pty acme")).toBeNull();
  });

  it("names the contact that matched when the name does not explain the result", () => {
    expect(clientContactMatchText(acme, "smith")).toBe("Matches contact John Smith");
  });

  it("matches on a last name or a first name, ignoring case", () => {
    expect(clientContactMatchText(acme, "JONES")).toBe("Matches contact Anna Jones");
    expect(clientContactMatchText(acme, "anna")).toBe("Matches contact Anna Jones");
  });

  it("names a contact with no last name by its first name alone", () => {
    expect(clientContactMatchText(acme, "joan")).toBe("Matches contact Joan");
  });

  it("shows two contacts, pluralises, and counts the rest", () => {
    expect(clientContactMatchText(acme, "jo")).toBe(
      "Matches contacts John Smith, Anna Jones +1 more"
    );
  });

  it("names a contact for a word the company name does not hold, even when another word it does", () => {
    expect(clientContactMatchText(acme, "pty smith")).toBe("Matches contact John Smith");
  });

  it("is null when no contact explains the words", () => {
    expect(clientContactMatchText(acme, "zzz")).toBeNull();
  });
});

describe("clientSearchStatus", () => {
  const answered = (term: string, count: number, failed = false) => ({ term, count, failed });
  const idle = { tooShort: false, searching: false };

  it("says the companies are loading before the first answer", () => {
    expect(clientSearchStatus({ ...idle, searching: true, outcome: null })).toEqual({
      kind: "loading",
      text: "Loading companies…",
    });
  });

  it("describes the newest-companies list on focus, with the way to search", () => {
    const status = clientSearchStatus({ ...idle, outcome: answered("", 100) });
    expect(status.kind).toBe("full");
    expect(status.text).toBe(
      `Showing the ${CLIENT_SEARCH_PAGE_SIZE} newest companies. Type ${CLIENT_SEARCH_MIN_LENGTH} or more letters to search.`
    );
  });

  it("describes a default list that is shorter than a page", () => {
    const status = clientSearchStatus({ ...idle, outcome: answered("", 12) });
    expect(status.kind).toBe("results");
    expect(status.text).toBe(
      `Newest companies first. Type ${CLIENT_SEARCH_MIN_LENGTH} or more letters to search.`
    );
  });

  it("shows the minimum-length hint for one or two typed letters, over the list", () => {
    const status = clientSearchStatus({ tooShort: true, searching: false, outcome: answered("", 100) });
    expect(status).toEqual({
      kind: "tooShort",
      text: `Type ${CLIENT_SEARCH_MIN_LENGTH} or more letters to search.`,
    });
  });

  it("keeps the hint while the default list is being fetched back after deleting letters", () => {
    const status = clientSearchStatus({ tooShort: true, searching: true, outcome: answered("boat", 3) });
    expect(status.kind).toBe("tooShort");
  });

  it("says it is searching while a newer term is in flight", () => {
    expect(clientSearchStatus({ tooShort: false, searching: true, outcome: answered("boa", 3) })).toEqual({
      kind: "searching",
      text: "Searching…",
    });
  });

  it("counts matches, singular and plural", () => {
    expect(clientSearchStatus({ ...idle, outcome: answered("boats", 1) }).text).toBe("1 match");
    expect(clientSearchStatus({ ...idle, outcome: answered("boats", 12) }).text).toBe("12 matches");
  });

  it("says a full page of matches may be cut short", () => {
    const status = clientSearchStatus({ ...idle, outcome: answered("boats", CLIENT_SEARCH_PAGE_SIZE) });
    expect(status.kind).toBe("full");
    expect(status.text).toBe(`Showing the first ${CLIENT_SEARCH_PAGE_SIZE} matches. Type more to narrow them down.`);
  });

  it("names the term and what to do when nothing matches", () => {
    const status = clientSearchStatus({ ...idle, outcome: answered("boatz", 0) });
    expect(status.kind).toBe("empty");
    expect(status.text).toBe(
      "No company or contact matches “boatz”. Check the spelling, try fewer letters, or use + New company."
    );
  });

  it("says there are no clients at all when even the default list is empty", () => {
    const status = clientSearchStatus({ ...idle, outcome: answered("", 0) });
    expect(status.kind).toBe("empty");
    expect(status.text).toContain("No clients are available to you yet");
  });

  it("reports a failure over everything but a search already retrying it", () => {
    expect(clientSearchStatus({ ...idle, outcome: answered("boats", 0, true) })).toEqual({
      kind: "failed",
      text: "Search failed.",
    });
    expect(
      clientSearchStatus({ tooShort: false, searching: true, outcome: answered("boats", 0, true) }).kind
    ).toBe("searching");
  });
});
