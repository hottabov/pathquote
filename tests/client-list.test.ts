import { describe, it, expect } from "vitest";
import {
  CLIENT_LIST_ALL,
  CLIENT_LIST_DEFAULT_PAGE_SIZE,
  CLIENT_LIST_MAX_PAGE,
  CLIENT_LIST_PAGE_SIZES,
  clientListHref,
  clientListSlice,
  clientListSummary,
  clientListTerm,
  clientListWhere,
  clientListWindow,
  parseClientListParams,
} from "../src/lib/client-list";
import { CLIENT_SEARCH_MAX_LENGTH, CLIENT_SEARCH_MAX_WORDS } from "../src/lib/client-search";
import { companyWhereForUser } from "../src/lib/scope";

describe("parseClientListParams", () => {
  it("defaults to page 1, 20 a page, no search, for a bare /clients", () => {
    expect(parseClientListParams({})).toEqual({ q: "", page: 1, pageSize: 20 });
    expect(CLIENT_LIST_DEFAULT_PAGE_SIZE).toBe(20);
  });

  it("reads valid values as given", () => {
    expect(parseClientListParams({ q: "acme", page: "3", pageSize: "100" })).toEqual({
      q: "acme",
      page: 3,
      pageSize: 100,
    });
  });

  it("accepts every offered page size, and 'all'", () => {
    for (const size of CLIENT_LIST_PAGE_SIZES) {
      expect(parseClientListParams({ pageSize: String(size) }).pageSize).toBe(size);
    }
    expect(parseClientListParams({ pageSize: "all" }).pageSize).toBe(CLIENT_LIST_ALL);
  });

  it("falls back to the default for a page size that is not offered", () => {
    for (const bad of ["0", "-20", "10", "25", "500", "1000000", "20.5", "20.0", "1e2", "0x32", " 50", "50 ", "50abc", "abc", "", "ALL", "All", "null", "NaN", "Infinity"]) {
      expect(parseClientListParams({ pageSize: bad }).pageSize).toBe(20);
    }
  });

  it("falls back to page 1 for a page that is not a positive whole number", () => {
    for (const bad of ["0", "-1", "-0", "2.5", "1e3", "0x10", " 2", "2 ", "+2", "abc", "", "NaN", "Infinity", "٣"]) {
      expect(parseClientListParams({ page: bad }).page).toBe(1);
    }
  });

  it("caps a page number with too many digits to mean anything, instead of overflowing", () => {
    expect(parseClientListParams({ page: "99999999999999999999999" }).page).toBe(CLIENT_LIST_MAX_PAGE);
    expect(parseClientListParams({ page: String(CLIENT_LIST_MAX_PAGE + 1) }).page).toBe(CLIENT_LIST_MAX_PAGE);
    expect(parseClientListParams({ page: "000007" }).page).toBe(7);
  });

  it("takes the first of a repeated parameter and never throws on an array", () => {
    expect(parseClientListParams({ q: ["acme", "other"], page: ["2", "9"], pageSize: ["50", "all"] })).toEqual({
      q: "acme",
      page: 2,
      pageSize: 50,
    });
    expect(parseClientListParams({ q: [], page: [], pageSize: [] })).toEqual({ q: "", page: 1, pageSize: 20 });
  });

  it("validates each parameter on its own: junk in one does not cost the others", () => {
    expect(parseClientListParams({ q: "acme", page: "junk", pageSize: "50" })).toEqual({
      q: "acme",
      page: 1,
      pageSize: 50,
    });
    expect(parseClientListParams({ q: "acme", page: "4", pageSize: "junk" })).toEqual({
      q: "acme",
      page: 4,
      pageSize: 20,
    });
  });
});

describe("clientListTerm", () => {
  it("trims and collapses whitespace", () => {
    expect(clientListTerm("  acme   pty\tltd ")).toBe("acme pty ltd");
  });

  it("has no minimum length: a list is narrowed by typing, one letter included", () => {
    expect(clientListTerm("a")).toBe("a");
  });

  it("is empty for blank input", () => {
    expect(clientListTerm("")).toBe("");
    expect(clientListTerm("   \n ")).toBe("");
  });

  it("cuts an over-long term at the maximum, without leaving a trailing space", () => {
    expect(clientListTerm("x".repeat(CLIENT_SEARCH_MAX_LENGTH + 50))).toHaveLength(CLIENT_SEARCH_MAX_LENGTH);
    expect(clientListTerm(`${"x".repeat(CLIENT_SEARCH_MAX_LENGTH - 1)} yyy`)).toBe("x".repeat(CLIENT_SEARCH_MAX_LENGTH - 1));
  });
});

describe("clientListSlice", () => {
  it("is skip 0, take 20 for page 1 of the default size", () => {
    expect(clientListSlice(1, 20)).toEqual({ skip: 0, take: 20 });
  });

  it("skips whole pages", () => {
    expect(clientListSlice(3, 50)).toEqual({ skip: 100, take: 50 });
    expect(clientListSlice(2, 200)).toEqual({ skip: 200, take: 200 });
  });

  it("has no limit and no offset for 'all', whatever the page", () => {
    expect(clientListSlice(1, CLIENT_LIST_ALL)).toEqual({ skip: 0, take: undefined });
    expect(clientListSlice(9, CLIENT_LIST_ALL)).toEqual({ skip: 0, take: undefined });
  });

  it("never produces a negative skip", () => {
    expect(clientListSlice(0, 20).skip).toBe(0);
    expect(clientListSlice(-5, 20).skip).toBe(0);
  });
});

describe("clientListWindow", () => {
  it("describes the first page of many", () => {
    expect(clientListWindow(1, 20, 1284)).toEqual({ page: 1, pageCount: 65, from: 1, to: 20 });
  });

  it("describes a middle page", () => {
    expect(clientListWindow(2, 20, 1284)).toEqual({ page: 2, pageCount: 65, from: 21, to: 40 });
  });

  it("ends the last page at the total, not at a full page", () => {
    expect(clientListWindow(65, 20, 1284)).toEqual({ page: 65, pageCount: 65, from: 1281, to: 1284 });
  });

  it("does not add a page for an exact multiple", () => {
    expect(clientListWindow(1, 20, 40).pageCount).toBe(2);
    expect(clientListWindow(1, 20, 41).pageCount).toBe(3);
  });

  it("clamps a page past the end to the last page, not to the first", () => {
    expect(clientListWindow(500, 20, 1284)).toEqual({ page: 65, pageCount: 65, from: 1281, to: 1284 });
    expect(clientListWindow(CLIENT_LIST_MAX_PAGE, 50, 120)).toEqual({ page: 3, pageCount: 3, from: 101, to: 120 });
  });

  it("clamps a page below 1 up to 1", () => {
    expect(clientListWindow(0, 20, 100).page).toBe(1);
    expect(clientListWindow(-3, 20, 100).page).toBe(1);
  });

  it("is page 1 of 1, covering nothing, for an empty result", () => {
    expect(clientListWindow(1, 20, 0)).toEqual({ page: 1, pageCount: 1, from: 0, to: 0 });
    expect(clientListWindow(7, 20, 0)).toEqual({ page: 1, pageCount: 1, from: 0, to: 0 });
  });

  it("is one page covering everything for 'all'", () => {
    expect(clientListWindow(4, CLIENT_LIST_ALL, 8809)).toEqual({ page: 1, pageCount: 1, from: 1, to: 8809 });
  });

  it("agrees with clientListSlice: the window's rows are the slice's rows", () => {
    const total = 1284;
    for (const size of CLIENT_LIST_PAGE_SIZES) {
      const last = clientListWindow(CLIENT_LIST_MAX_PAGE, size, total);
      const { skip, take } = clientListSlice(last.page, size);
      expect(skip + 1).toBe(last.from);
      expect(Math.min(skip + take!, total)).toBe(last.to);
    }
  });
});

describe("clientListSummary", () => {
  it("gives the range and the total, with thousands separators", () => {
    const window = clientListWindow(2, 20, 1284);
    expect(clientListSummary(window, 1284, false)).toBe("21–40 of 1,284 companies");
  });

  it("says 'matching' while a search is active", () => {
    const window = clientListWindow(1, 20, 7);
    expect(clientListSummary(window, 7, true)).toBe("1–7 of 7 matching companies");
  });

  it("drops the range for a single row, and uses the singular", () => {
    const window = clientListWindow(1, 20, 1);
    expect(clientListSummary(window, 1, false)).toBe("1 of 1 company");
    expect(clientListSummary(window, 1, true)).toBe("1 of 1 matching company");
  });

  it("names a last page that is a single row by its own number", () => {
    expect(clientListSummary(clientListWindow(65, 20, 1281), 1281, false)).toBe("1,281 of 1,281 companies");
  });

  it("says zero plainly, so a search that found nothing is distinguishable from a broken page", () => {
    const window = clientListWindow(1, 20, 0);
    expect(clientListSummary(window, 0, true)).toBe("0 matching companies");
    expect(clientListSummary(window, 0, false)).toBe("0 companies");
  });

  it("shows the whole range for 'all'", () => {
    expect(clientListSummary(clientListWindow(1, CLIENT_LIST_ALL, 8809), 8809, false)).toBe(
      "1–8,809 of 8,809 companies"
    );
  });
});

describe("clientListHref", () => {
  it("is bare /clients for the defaults, so a shared link stays short", () => {
    expect(clientListHref({})).toBe("/clients");
    expect(clientListHref({ q: "", page: 1, pageSize: 20 })).toBe("/clients");
  });

  it("carries only what differs from the defaults", () => {
    expect(clientListHref({ q: "acme", pageSize: 50, page: 3 })).toBe("/clients?q=acme&pageSize=50&page=3");
    expect(clientListHref({ pageSize: CLIENT_LIST_ALL })).toBe("/clients?pageSize=all");
    expect(clientListHref({ page: 2 })).toBe("/clients?page=2");
  });

  it("leaves page out unless asked, which is what sends a new search back to page 1", () => {
    expect(clientListHref({ q: "acme", pageSize: 100 })).not.toContain("page=");
  });

  it("encodes the term and normalises it first", () => {
    expect(clientListHref({ q: "  a&b   c=d " })).toBe("/clients?q=a%26b+c%3Dd");
  });

  it("round-trips through parseClientListParams", () => {
    const request = { q: "john smith", page: 4, pageSize: 200 as const };
    const url = new URL(clientListHref(request), "http://x");
    expect(parseClientListParams(Object.fromEntries(url.searchParams))).toEqual(request);
  });
});

describe("clientListWhere", () => {
  const manager = { id: "u1", role: "MANAGER" };
  const granted = { id: "u1", role: "MANAGER", visibleCountries: ["AU", "NZ"] };
  const contains = (value: string) => ({ contains: value, mode: "insensitive" });

  it("is the scope alone, untouched, for no search", () => {
    const scope = companyWhereForUser(manager);
    expect(clientListWhere(scope, "")).toBe(scope);
  });

  it("is the empty filter for an admin with no search: every company", () => {
    expect(clientListWhere(companyWhereForUser({ id: "a", role: "ADMIN" }), "")).toEqual({});
  });

  it("searches name, city, country and website, and a contact's first name, last name and email", () => {
    const where = clientListWhere({}, "acme") as { AND: unknown[] };
    expect(where.AND[1]).toEqual({
      OR: [
        { name: contains("acme") },
        { city: contains("acme") },
        { country: contains("acme") },
        { website: contains("acme") },
        {
          contacts: {
            some: {
              OR: [{ firstName: contains("acme") }, { lastName: contains("acme") }, { email: contains("acme") }],
            },
          },
        },
      ],
    });
  });

  it("keeps the scope intact as the first AND clause", () => {
    const scope = companyWhereForUser(manager);
    const where = clientListWhere(scope, "acme") as { AND: unknown[] };
    expect(where.AND[0]).toBe(scope);
  });

  it("does not let the search replace a country grant's OR, nor the reverse", () => {
    const scope = companyWhereForUser(granted);
    expect(scope).toHaveProperty("OR");
    const where = clientListWhere(scope, "acme") as { AND: Record<string, unknown>[] };
    expect(where).not.toHaveProperty("OR");
    expect(where.AND).toHaveLength(2);
    expect(where.AND[0]).toEqual({ OR: [{ ownerId: "u1" }, { country: { in: ["AU", "NZ"] } }] });
    expect(where.AND[1]).toHaveProperty("OR");
  });

  it("requires every word, each matching somewhere, so 'john smith' can find a contact", () => {
    const where = clientListWhere({}, "john smith") as { AND: unknown[] };
    expect(where.AND).toHaveLength(3);
  });

  it("does not search past the maximum number of words", () => {
    const where = clientListWhere({}, "a b c d e f g h") as { AND: unknown[] };
    expect(where.AND).toHaveLength(1 + CLIENT_SEARCH_MAX_WORDS);
  });
});
