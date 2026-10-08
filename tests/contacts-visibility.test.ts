import { describe, it, expect } from "vitest";
import { buildContactsVisibility, describeContactsAccess } from "../src/lib/contacts-visibility";

const group = (country: string | null, n: number) => ({ country, _count: { _all: n } });

describe("buildContactsVisibility", () => {
  it("makes a row per country with its company count, biggest first", () => {
    const result = buildContactsVisibility([group("CA", 120), group("US", 4312), group("MX", 3)], []);
    expect(result.countries.map((c) => [c.code, c.companies])).toEqual([
      ["US", 4312],
      ["CA", 120],
      ["MX", 3],
    ]);
    expect(result.countries[0].name).toBe("United States of America");
  });

  it("breaks a tie in count by country name", () => {
    const result = buildContactsVisibility([group("US", 5), group("CA", 5), group("AU", 5)], []);
    expect(result.countries.map((c) => c.code)).toEqual(["AU", "CA", "US"]);
  });

  it("marks exactly the granted countries as selected", () => {
    const result = buildContactsVisibility([group("US", 10), group("CA", 5), group("MX", 1)], ["CA", "US"]);
    expect(Object.fromEntries(result.countries.map((c) => [c.code, c.selected]))).toEqual({
      US: true,
      CA: true,
      MX: false,
    });
    expect(result.allCountries).toBe(false);
  });

  it("keeps a granted country that has no companies, with a count of 0", () => {
    const result = buildContactsVisibility([group("US", 10)], ["NZ", "US"]);
    const nz = result.countries.find((c) => c.code === "NZ");
    expect(nz).toEqual({ code: "NZ", name: "New Zealand", companies: 0, selected: true });
    // ...and sorts below every country that has clients.
    expect(result.countries.map((c) => c.code)).toEqual(["US", "NZ"]);
  });

  it("lists a granted country even when there are no companies at all", () => {
    const result = buildContactsVisibility([], ["DE"]);
    expect(result.countries).toEqual([{ code: "DE", name: "Germany", companies: 0, selected: true }]);
  });

  it("reads a grant of * as every country, not as a row", () => {
    const result = buildContactsVisibility([group("US", 10)], ["*"]);
    expect(result.allCountries).toBe(true);
    expect(result.countries.map((c) => c.code)).toEqual(["US"]);
    expect(result.countries[0].selected).toBe(false);
  });

  it("treats an empty grant as no grant, not as all", () => {
    const result = buildContactsVisibility([group("US", 10)], []);
    expect(result.allCountries).toBe(false);
    expect(result.countries.every((c) => !c.selected)).toBe(true);
  });

  it("counts null, empty and free-text countries as without a country, not as rows", () => {
    const result = buildContactsVisibility(
      [group("US", 10), group(null, 7), group("", 2), group("Atlantis", 4)],
      []
    );
    expect(result.countries.map((c) => c.code)).toEqual(["US"]);
    expect(result.companiesWithoutCountry).toBe(13);
  });

  it("does not count a recognisable spelling toward a code a grant cannot match", () => {
    // `country IN ('US')` is an exact match, so these rows are not revealed by
    // a grant of US and must not be counted as if they were.
    const result = buildContactsVisibility(
      [group("US", 10), group("United States", 3), group("usa", 2), group("us", 1)],
      []
    );
    expect(result.countries).toEqual([
      { code: "US", name: "United States of America", companies: 10, selected: false },
    ]);
    expect(result.companiesWithoutCountry).toBe(6);
  });

  it("adds up groups that land on the same code", () => {
    const result = buildContactsVisibility([group("US", 4), group("US", 6)], []);
    expect(result.countries[0].companies).toBe(10);
  });

  it("ignores a grant entry that is not a country rather than inventing a row", () => {
    const result = buildContactsVisibility([group("US", 1)], ["ZZ", "us"]);
    expect(result.countries.map((c) => c.code)).toEqual(["US"]);
    expect(result.countries[0].selected).toBe(false);
  });

  it("is empty for an empty database and no grant", () => {
    expect(buildContactsVisibility([], [])).toEqual({
      allCountries: false,
      countries: [],
      companiesWithoutCountry: 0,
    });
  });
});

describe("describeContactsAccess", () => {
  const base = { allCountries: false, selectedCountries: 0, selectedCompanies: 0, regional: false };

  it("warns, rather than staying silent, when nothing is ticked", () => {
    const result = describeContactsAccess(base);
    expect(result.tone).toBe("none");
    expect(result.summary).toBe("This manager will see only the clients they own.");
    expect(result.warning).toContain("Nothing is ticked");
    expect(result.warning).toContain("no owner");
  });

  it("states a grant as what the user WILL see, with the count it reveals", () => {
    const result = describeContactsAccess({ ...base, selectedCountries: 2, selectedCompanies: 4432 });
    expect(result.tone).toBe("some");
    expect(result.summary).toBe("This manager will see the 4,432 clients in 2 countries, plus any they own.");
    expect(result.warning).toBeNull();
  });

  it("uses the singular for one country and one client", () => {
    const result = describeContactsAccess({ ...base, selectedCountries: 1, selectedCompanies: 1 });
    expect(result.summary).toBe("This manager will see the 1 client in 1 country, plus any they own.");
  });

  it("says so when the ticked countries have no clients yet", () => {
    const result = describeContactsAccess({ ...base, selectedCountries: 1 });
    expect(result.summary).toBe(
      "This manager will see clients in 1 country (none have any yet), plus any they own."
    );
  });

  it("says every client for all countries, whatever else is ticked", () => {
    const result = describeContactsAccess({ ...base, allCountries: true, selectedCountries: 3 });
    expect(result.tone).toBe("all");
    expect(result.summary).toBe("This manager will see every client in the system, in every country.");
    expect(result.warning).toBeNull();
  });

  it("describes a regional manager's own arm as their region's clients", () => {
    const some = describeContactsAccess({ ...base, regional: true, selectedCountries: 2, selectedCompanies: 10 });
    expect(some.summary).toBe(
      "This regional manager will see the 10 clients in 2 countries, plus the clients owned by their region."
    );
    const none = describeContactsAccess({ ...base, regional: true });
    expect(none.summary).toBe("This regional manager will see only the clients owned by their region.");
  });

  it("never describes a selection as hiding anything", () => {
    for (const input of [base, { ...base, selectedCountries: 2, selectedCompanies: 5 }]) {
      const { summary, warning } = describeContactsAccess(input);
      expect(`${summary} ${warning ?? ""}`).not.toMatch(/\bhid(e|es|den)\b/i);
    }
  });
});
