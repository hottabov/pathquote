import { describe, it, expect } from "vitest";
import {
  CLIENT_LIST_ALL,
  CLIENT_LIST_DEFAULT_PAGE_SIZE,
  CLIENT_LIST_MAX_PAGE,
  CLIENT_LIST_PAGE_SIZES,
  CLIENT_LIST_SORT_KEYS,
  clientListDefaultDir,
  clientListHref,
  clientListOrderBy,
  clientListSortOptions,
  clientListSlice,
  clientListSummary,
  clientListTerm,
  clientListWhere,
  clientListWindow,
  nextClientListSort,
  parseClientListParams,
} from "../src/lib/client-list";
import { CLIENT_SEARCH_MAX_LENGTH, CLIENT_SEARCH_MAX_WORDS } from "../src/lib/client-search";
import { companyWhereForUser } from "../src/lib/scope";

describe("parseClientListParams", () => {
  it("defaults to page 1, 20 a page, no search, for a bare /clients", () => {
    expect(parseClientListParams({})).toEqual({ q: "", page: 1, pageSize: 20, sort: "name", dir: "asc" });
    expect(CLIENT_LIST_DEFAULT_PAGE_SIZE).toBe(20);
  });

  it("reads valid values as given", () => {
    expect(parseClientListParams({ q: "acme", page: "3", pageSize: "100" })).toEqual({
      q: "acme",
      page: 3,
      pageSize: 100,
      sort: "name",
      dir: "asc",
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
    expect(
      parseClientListParams({
        q: ["acme", "other"],
        page: ["2", "9"],
        pageSize: ["50", "all"],
        sort: ["owner", "name"],
        dir: ["desc", "asc"],
      })
    ).toEqual({ q: "acme", page: 2, pageSize: 50, sort: "owner", dir: "desc" });
    expect(parseClientListParams({ q: [], page: [], pageSize: [], sort: [], dir: [] })).toEqual({
      q: "",
      page: 1,
      pageSize: 20,
      sort: "name",
      dir: "asc",
    });
  });

  it("validates each parameter on its own: junk in one does not cost the others", () => {
    expect(parseClientListParams({ q: "acme", page: "junk", pageSize: "50" })).toEqual({
      q: "acme",
      page: 1,
      pageSize: 50,
      sort: "name",
      dir: "asc",
    });
    expect(parseClientListParams({ q: "acme", page: "4", pageSize: "junk" })).toEqual({
      q: "acme",
      page: 4,
      pageSize: 20,
      sort: "name",
      dir: "asc",
    });
    expect(parseClientListParams({ q: "acme", page: "4", sort: "junk", dir: "desc" })).toEqual({
      q: "acme",
      page: 4,
      pageSize: 20,
      sort: "name",
      dir: "desc",
    });
    expect(parseClientListParams({ q: "acme", sort: "owner", dir: "junk" })).toMatchObject({
      q: "acme",
      sort: "owner",
      dir: "asc",
    });
  });
});

describe("parseClientListParams: sort and dir", () => {
  it("accepts each of the four columns", () => {
    for (const sort of ["name", "location", "contacts", "owner"]) {
      expect(parseClientListParams({ sort }).sort).toBe(sort);
    }
    expect([...CLIENT_LIST_SORT_KEYS]).toEqual(["name", "location", "contacts", "owner"]);
  });

  it("falls back to name for anything that is not a column", () => {
    for (const bad of ["", "Name", "NAME", " name", "name ", "id", "city", "country", "website", "createdAt", "constructor", "__proto__", "toString", "owner.name", "name,desc", "null", "undefined", "0", "[object Object]", "name\u0000"]) {
      expect(parseClientListParams({ sort: bad }).sort).toBe("name");
    }
    expect(parseClientListParams({ sort: undefined }).sort).toBe("name");
  });

  it("accepts asc and desc for every column", () => {
    for (const sort of CLIENT_LIST_SORT_KEYS) {
      expect(parseClientListParams({ sort, dir: "asc" }).dir).toBe("asc");
      expect(parseClientListParams({ sort, dir: "desc" }).dir).toBe("desc");
    }
  });

  it("falls back to the column's own default direction for anything else", () => {
    for (const bad of ["", "ASC", "DESC", "Asc", " asc", "desc ", "ascending", "descending", "up", "down", "1", "-1", "true", "null", "constructor"]) {
      expect(parseClientListParams({ sort: "name", dir: bad }).dir).toBe("asc");
      expect(parseClientListParams({ sort: "location", dir: bad }).dir).toBe("asc");
      expect(parseClientListParams({ sort: "owner", dir: bad }).dir).toBe("asc");
      expect(parseClientListParams({ sort: "contacts", dir: bad }).dir).toBe("desc");
    }
  });

  it("opens contacts descending, because the question put to that column is 'who has the most'", () => {
    expect(clientListDefaultDir("contacts")).toBe("desc");
    expect(parseClientListParams({ sort: "contacts" }).dir).toBe("desc");
    expect(parseClientListParams({ sort: "contacts", dir: "asc" }).dir).toBe("asc");
    for (const sort of ["name", "location", "owner"] as const) {
      expect(clientListDefaultDir(sort)).toBe("asc");
    }
  });

  it("reads dir against the sort that survived, so junk sort means plain name order", () => {
    expect(parseClientListParams({ sort: "junk", dir: "junk" })).toMatchObject({ sort: "name", dir: "asc" });
    expect(parseClientListParams({ dir: "desc" })).toMatchObject({ sort: "name", dir: "desc" });
  });

  it("treats owner as unrecognised for a viewer who is not shown the Owner column", () => {
    expect(parseClientListParams({ sort: "owner", dir: "desc" }, { ownerSortable: false })).toMatchObject({
      sort: "name",
      dir: "desc",
    });
    expect(parseClientListParams({ sort: "owner" }, { ownerSortable: false }).sort).toBe("name");
    // The other columns, and the default, are unaffected.
    expect(parseClientListParams({ sort: "contacts" }, { ownerSortable: false }).sort).toBe("contacts");
    expect(parseClientListParams({ sort: "owner" }, { ownerSortable: true }).sort).toBe("owner");
    expect(parseClientListParams({ sort: "owner" }).sort).toBe("owner");
  });
});

describe("nextClientListSort", () => {
  it("flips the direction of the column that is already sorted", () => {
    expect(nextClientListSort({ sort: "name", dir: "asc" }, "name")).toEqual({ sort: "name", dir: "desc" });
    expect(nextClientListSort({ sort: "name", dir: "desc" }, "name")).toEqual({ sort: "name", dir: "asc" });
    expect(nextClientListSort({ sort: "contacts", dir: "desc" }, "contacts")).toEqual({ sort: "contacts", dir: "asc" });
  });

  it("starts any other column in its own default direction, whatever the current direction", () => {
    expect(nextClientListSort({ sort: "name", dir: "desc" }, "location")).toEqual({ sort: "location", dir: "asc" });
    expect(nextClientListSort({ sort: "name", dir: "asc" }, "contacts")).toEqual({ sort: "contacts", dir: "desc" });
    expect(nextClientListSort({ sort: "contacts", dir: "asc" }, "owner")).toEqual({ sort: "owner", dir: "asc" });
    expect(nextClientListSort({ sort: "contacts", dir: "asc" }, "name")).toEqual({ sort: "name", dir: "asc" });
  });
});

describe("clientListSortOptions", () => {
  it("offers both directions of every column, each column's default first", () => {
    const options = clientListSortOptions(true);
    expect(options.map((o) => o.value)).toEqual([
      "name:asc",
      "name:desc",
      "location:asc",
      "location:desc",
      "contacts:desc",
      "contacts:asc",
      "owner:asc",
      "owner:desc",
    ]);
  });

  it("leaves owner out for a viewer who is not shown that column", () => {
    expect(clientListSortOptions(false).some((o) => o.sort === "owner")).toBe(false);
    expect(clientListSortOptions(false)).toHaveLength(6);
  });

  it("has distinct labels, and every option is a request the parser would accept as it is", () => {
    const options = clientListSortOptions(true);
    expect(new Set(options.map((o) => o.label)).size).toBe(options.length);
    for (const { sort, dir } of options) {
      expect(parseClientListParams({ sort, dir })).toMatchObject({ sort, dir });
    }
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
    const request = { q: "john smith", page: 4, pageSize: 200 as const, sort: "name" as const, dir: "asc" as const };
    const url = new URL(clientListHref(request), "http://x");
    expect(parseClientListParams(Object.fromEntries(url.searchParams))).toEqual(request);
  });

  it("leaves the default sort out: a plain name order is a plain /clients", () => {
    expect(clientListHref({ sort: "name" })).toBe("/clients");
    expect(clientListHref({ sort: "name", dir: "asc" })).toBe("/clients");
    expect(clientListHref({ sort: "location", dir: "asc" })).toBe("/clients?sort=location");
    expect(clientListHref({ sort: "owner", dir: "asc" })).toBe("/clients?sort=owner");
  });

  it("leaves out dir when it is the sorted column's own default, so contacts is ?sort=contacts", () => {
    expect(clientListHref({ sort: "contacts", dir: "desc" })).toBe("/clients?sort=contacts");
    expect(clientListHref({ sort: "contacts", dir: "asc" })).toBe("/clients?sort=contacts&dir=asc");
    expect(clientListHref({ sort: "location", dir: "desc" })).toBe("/clients?sort=location&dir=desc");
    expect(clientListHref({ sort: "name", dir: "desc" })).toBe("/clients?dir=desc");
  });

  it("carries the search and the page size next to the sort, in a fixed order, page last", () => {
    expect(clientListHref({ q: "acme", pageSize: 50, sort: "contacts", dir: "asc", page: 3 })).toBe(
      "/clients?q=acme&pageSize=50&sort=contacts&dir=asc&page=3"
    );
  });

  it("a header link keeps q and pageSize and drops page, so a new sort starts at page 1", () => {
    // What the header builds: the current q and pageSize, the sort a click
    // gives, and no page -- even though the viewer is on page 7.
    const current = { q: "acme", pageSize: 50 as const, sort: "name" as const, dir: "asc" as const, page: 7 };
    const next = nextClientListSort(current, "contacts");
    const href = clientListHref({ q: current.q, pageSize: current.pageSize, ...next });
    expect(href).toBe("/clients?q=acme&pageSize=50&sort=contacts");
    expect(href).not.toContain("page=");
    // And a page link keeps the sort, or page 2 would be a different list.
    expect(clientListHref({ ...current, ...next, page: 2 })).toBe("/clients?q=acme&pageSize=50&sort=contacts&page=2");
  });

  it("round-trips every column in every direction", () => {
    for (const sort of CLIENT_LIST_SORT_KEYS) {
      for (const dir of ["asc", "desc"] as const) {
        const request = { q: "x", page: 2, pageSize: 100 as const, sort, dir };
        const url = new URL(clientListHref(request), "http://x");
        expect(parseClientListParams(Object.fromEntries(url.searchParams))).toEqual(request);
      }
    }
  });
});

describe("clientListOrderBy", () => {
  const nullsLast = (sort: "asc" | "desc") => ({ sort, nulls: "last" });

  it("orders by name, then id", () => {
    expect(clientListOrderBy("name", "asc")).toEqual([{ name: "asc" }, { id: "asc" }]);
    expect(clientListOrderBy("name", "desc")).toEqual([{ name: "desc" }, { id: "asc" }]);
  });

  it("orders by country, then city, nulls last in both directions, then name, then id", () => {
    for (const dir of ["asc", "desc"] as const) {
      expect(clientListOrderBy("location", dir)).toEqual([
        { country: nullsLast(dir) },
        { city: nullsLast(dir) },
        { name: "asc" },
        { id: "asc" },
      ]);
    }
  });

  it("orders by the count of the contacts relation, then name, then id", () => {
    expect(clientListOrderBy("contacts", "desc")).toEqual([
      { contacts: { _count: "desc" } },
      { name: "asc" },
      { id: "asc" },
    ]);
    expect(clientListOrderBy("contacts", "asc")).toEqual([
      { contacts: { _count: "asc" } },
      { name: "asc" },
      { id: "asc" },
    ]);
  });

  it("orders by the owner's name with nulls last, keeps each owner together, then name, then id", () => {
    for (const dir of ["asc", "desc"] as const) {
      expect(clientListOrderBy("owner", dir)).toEqual([
        { owner: { name: nullsLast(dir) } },
        { ownerId: { sort: "asc", nulls: "last" } },
        { name: "asc" },
        { id: "asc" },
      ]);
    }
  });

  it("ends every ordering in id, ascending, so paging cannot repeat or skip a company", () => {
    for (const sort of CLIENT_LIST_SORT_KEYS) {
      for (const dir of ["asc", "desc"] as const) {
        const order = clientListOrderBy(sort, dir);
        expect(order[order.length - 1]).toEqual({ id: "asc" });
        // One key per entry: Prisma rejects an orderBy object with two.
        for (const entry of order) expect(Object.keys(entry)).toHaveLength(1);
      }
    }
  });

  it("puts a null-bearing column's nulls last in every direction, never Postgres's default", () => {
    for (const sort of ["location", "owner"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        const text = JSON.stringify(clientListOrderBy(sort, dir));
        expect(text).toContain('"nulls":"last"');
        expect(text).not.toContain('"nulls":"first"');
      }
    }
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

describe("searching by country name", () => {
  it("finds companies by the country's name, not only its stored code", () => {
    // Company.country holds an ISO code, so without resolving the name a
    // manager typing "Australia" matched nothing -- on a list whose visibility
    // is itself granted by country, which makes it the obvious thing to type.
    const where = clientListWhere({}, "Australia") as { AND: { OR?: unknown[] }[] };
    const word = where.AND.find((clause) => "OR" in clause);
    expect(word).toBeDefined();
    expect(word?.OR ?? []).toContainEqual({ country: { equals: "AU" } });
  });

  it("resolves the colloquial spellings the ACT! import added", () => {
    for (const [typed, code] of [["Turkey", "TR"], ["China", "CN"], ["UK", "GB"], ["USA", "US"]]) {
      const where = clientListWhere({}, typed) as { AND: { OR?: unknown[] }[] };
      const word = where.AND.find((clause) => "OR" in clause);
      expect(word?.OR ?? []).toContainEqual({ country: { equals: code } });
    }
  });

  it("adds no country clause for a word that is not a country", () => {
    const where = clientListWhere({}, "marine") as { AND: { OR?: unknown[] }[] };
    const word = where.AND.find((clause) => "OR" in clause);
    const clauses = (word?.OR ?? []) as Record<string, unknown>[];
    expect(clauses.some((c) => "country" in c && "equals" in (c.country as object))).toBe(false);
  });
});
