import { describe, it, expect } from "vitest";
import {
  ambiguousCompanyCount,
  formatReport,
  planBackfill,
  type CompanyRow,
} from "../src/lib/act/preflight";
import { companyKey } from "../src/lib/act/company-key";

let seq = 0;
function company(overrides: Partial<CompanyRow> & { name: string }): CompanyRow {
  seq += 1;
  return {
    id: `c${seq}`,
    country: "AU",
    actCompanyId: null,
    actCompanyKey: null,
    contactCount: 0,
    documentCount: 0,
    ...overrides,
  };
}

describe("planBackfill: unambiguous", () => {
  it("keys a lone company with the key the sync would compute", () => {
    const acme = company({ name: "Acme Pty Ltd", country: "AU", documentCount: 3 });
    const plan = planBackfill([acme]);

    expect(plan.unambiguous).toEqual([
      { company: acme, key: "acme|AU", countryResolved: true },
    ]);
    // Not a literal re-derivation: the real function is the one the sync calls.
    expect(plan.unambiguous[0].key).toBe(companyKey("Acme Pty Ltd", "AU"));
    expect(plan.ambiguous).toEqual([]);
    expect(plan.taken).toEqual([]);
    expect(plan.noKey).toEqual([]);
  });

  it("resolves a legacy free-text country the way the sync resolves ACT!'s", () => {
    // map.ts runs ACT!'s country through normalizeCountryInput before the key.
    // Passing "USA" straight through would produce "acme|USA", which no ACT!
    // contact can ever compute.
    const plan = planBackfill([
      company({ name: "Acme Inc", country: "USA" }),
      company({ name: "Borealis", country: "Australia" }),
      company({ name: "Cirrus", country: "us" }),
    ]);
    expect(plan.unambiguous.map((item) => item.key)).toEqual([
      "acme|US",
      "borealis|AU",
      "cirrus|US",
    ]);
    expect(plan.unambiguous.every((item) => item.countryResolved)).toBe(true);
  });

  it("flags a key with no country rather than hiding it", () => {
    const plan = planBackfill([
      company({ name: "No Country Co", country: null }),
      company({ name: "Lost Co", country: "Atlantis" }),
      company({ name: "Blank Co", country: "   " }),
    ]);
    expect(plan.unambiguous.map((item) => [item.key, item.countryResolved])).toEqual([
      ["blank|??", false],
      ["lost|??", false],
      ["no country|??", false],
    ]);
  });

  it("does not treat the same name in two countries as ambiguous", () => {
    // adient really does have offices in several; a quote to one is not a
    // quote to another.
    const plan = planBackfill([
      company({ name: "Adient", country: "MX" }),
      company({ name: "Adient", country: "RO" }),
    ]);
    expect(plan.ambiguous).toEqual([]);
    expect(plan.unambiguous.map((item) => item.key)).toEqual(["adient|MX", "adient|RO"]);
  });
});

describe("planBackfill: ambiguous", () => {
  it("lists every candidate, with counts, and keys none of them", () => {
    const withQuotes = company({
      name: "Acme Pty Ltd",
      country: "AU",
      contactCount: 0,
      documentCount: 4,
    });
    const withContacts = company({
      name: "ACME, Inc.",
      country: "Australia",
      contactCount: 5,
      documentCount: 0,
    });
    const plan = planBackfill([withQuotes, withContacts]);

    expect(plan.unambiguous).toEqual([]);
    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0].key).toBe("acme|AU");
    expect(plan.ambiguous[0].heldBy).toBeNull();
    expect(plan.ambiguous[0].candidates).toEqual(
      expect.arrayContaining([withQuotes, withContacts]),
    );
    expect(plan.ambiguous[0].candidates).toHaveLength(2);
    expect(ambiguousCompanyCount(plan)).toBe(2);
  });

  it("stays ambiguous at three, and counts companies rather than keys", () => {
    const plan = planBackfill([
      company({ name: "Acme" }),
      company({ name: "Acme Ltd" }),
      company({ name: "ACME LIMITED" }),
      company({ name: "Borealis" }),
      company({ name: "Borealis Corp" }),
    ]);
    expect(plan.ambiguous.map((group) => group.candidates.length)).toEqual([3, 2]);
    expect(ambiguousCompanyCount(plan)).toBe(5);
    expect(plan.unambiguous).toEqual([]);
  });

  it("attaches the holder when another row already has the key as well", () => {
    const holder = company({ name: "Acme", actCompanyKey: "acme|AU" });
    const plan = planBackfill([
      holder,
      company({ name: "Acme Pty Ltd" }),
      company({ name: "ACME Inc" }),
    ]);
    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0].heldBy).toEqual(holder);
    expect(plan.taken).toEqual([]);
  });
});

describe("planBackfill: already taken", () => {
  it("leaves a company alone when another row holds its key", () => {
    const holder = company({ name: "Acme", actCompanyKey: "acme|AU", contactCount: 9 });
    const unkeyed = company({ name: "Acme Pty Ltd", documentCount: 2 });
    const plan = planBackfill([holder, unkeyed]);

    expect(plan.taken).toEqual([{ company: unkeyed, key: "acme|AU", heldBy: holder }]);
    expect(plan.unambiguous).toEqual([]);
    expect(plan.alreadyKeyed).toBe(1);
  });

  it("does not let a key held in a different country block a company", () => {
    const plan = planBackfill([
      company({ name: "Acme", country: "AU", actCompanyKey: "acme|AU" }),
      company({ name: "Acme", country: "NZ" }),
    ]);
    expect(plan.taken).toEqual([]);
    expect(plan.unambiguous.map((item) => item.key)).toEqual(["acme|NZ"]);
  });
});

describe("planBackfill: no key", () => {
  it("lists a name that normalises to nothing and never keys it", () => {
    const junk = company({ name: "..." });
    const blank = company({ name: "   " });
    const plan = planBackfill([junk, blank, company({ name: "Real Co" })]);

    expect(plan.noKey).toEqual(expect.arrayContaining([junk, blank]));
    expect(plan.noKey).toHaveLength(2);
    expect(plan.unambiguous.map((item) => item.key)).toEqual(["real|AU"]);
  });

  it("does not let two nameless companies collapse into one ambiguous group", () => {
    const plan = planBackfill([company({ name: "..." }), company({ name: "!!" })]);
    expect(plan.ambiguous).toEqual([]);
    expect(plan.noKey).toHaveLength(2);
  });
});

describe("planBackfill: rows that already have a key", () => {
  it("counts them and never recomputes or regroups them", () => {
    // The stored key is stale on purpose: this script does not second-guess it.
    const keyed = company({ name: "Acme", country: "AU", actCompanyKey: "something|else" });
    const plan = planBackfill([keyed]);
    expect(plan.alreadyKeyed).toBe(1);
    expect(plan.unambiguous).toEqual([]);
    expect(plan.ambiguous).toEqual([]);
    expect(plan.taken).toEqual([]);
    expect(plan.noKey).toEqual([]);
  });

  it("still counts a key held by a keyed row as occupied", () => {
    const plan = planBackfill([
      company({ name: "Legacy name", actCompanyKey: "acme|AU" }),
      company({ name: "Acme" }),
    ]);
    expect(plan.taken).toHaveLength(1);
  });
});

describe("planBackfill: accounting", () => {
  it("accounts for every company exactly once", () => {
    const rows = [
      company({ name: "Solo" }),
      company({ name: "Twin" }),
      company({ name: "Twin Ltd" }),
      company({ name: "Held", actCompanyKey: "held|AU" }),
      company({ name: "Held Pty Ltd" }),
      company({ name: "..." }),
      company({ name: "Keyed", actCompanyKey: "keyed|AU" }),
    ];
    const plan = planBackfill(rows);
    const accounted =
      plan.alreadyKeyed +
      plan.unambiguous.length +
      ambiguousCompanyCount(plan) +
      plan.taken.length +
      plan.noKey.length;
    expect(plan.total).toBe(rows.length);
    expect(accounted).toBe(rows.length);
  });

  it("handles an empty database", () => {
    expect(planBackfill([])).toEqual({
      total: 0,
      alreadyKeyed: 0,
      unambiguous: [],
      ambiguous: [],
      taken: [],
      noKey: [],
    });
  });

  it("returns the same plan whatever order the rows arrive in", () => {
    const rows = [
      company({ name: "Zeta" }),
      company({ name: "Twin" }),
      company({ name: "Alpha" }),
      company({ name: "Twin Ltd" }),
    ];
    expect(planBackfill([...rows].reverse())).toEqual(planBackfill(rows));
  });

  it("does not modify the rows it is given", () => {
    const rows = [company({ name: "Acme" }), company({ name: "Acme Ltd" })];
    const before = JSON.stringify(rows);
    planBackfill(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe("formatReport", () => {
  it("shows a candidate's counts so a person can decide", () => {
    const text = formatReport(
      planBackfill([
        company({ name: "Acme Pty Ltd", contactCount: 3, documentCount: 7 }),
        company({ name: "ACME", contactCount: 0, documentCount: 0 }),
      ]),
    ).join("\n");
    expect(text).toContain("AMBIGUOUS: 1 key(s), 2 companies");
    expect(text).toContain("contacts 3  documents 7");
    expect(text).toContain("contacts 0  documents 0");
  });

  it("warns that an ambiguous company is not left harmlessly alone", () => {
    const text = formatReport(
      planBackfill([company({ name: "Acme" }), company({ name: "Acme Ltd" })]),
    ).join("\n");
    expect(text).toContain("will create a NEW");
  });

  it("raises no ambiguity warning when there is no ambiguity", () => {
    const text = formatReport(planBackfill([company({ name: "Acme" })])).join("\n");
    expect(text).not.toContain("will create a NEW");
    expect(text).toContain("AMBIGUOUS: 0 key(s), 0 companies");
  });

  it("warns about keys with no country", () => {
    const text = formatReport(
      planBackfill([company({ name: "Acme", country: null })]),
    ).join("\n");
    expect(text).toContain("key ends in |??");
  });

  it("states the counts that add up to the total", () => {
    const text = formatReport(
      planBackfill([
        company({ name: "Solo" }),
        company({ name: "Keyed", actCompanyKey: "keyed|AU" }),
        company({ name: "..." }),
      ]),
    ).join("\n");
    expect(text).toMatch(/companies in the database\s+3/);
    expect(text).toMatch(/already have a key\s+1/);
    expect(text).toMatch(/would be backfilled\s+1/);
    expect(text).toMatch(/no key\s+1/);
  });
});
