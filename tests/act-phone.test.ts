import { describe, it, expect } from "vitest";
import { actPhoneToE164 } from "../src/lib/act/phone";

describe("actPhoneToE164", () => {
  it("parses a national number against the contact's own country", () => {
    expect(actPhoneToE164("03 94679176", "Australia")).toBe("+61394679176");
    expect(actPhoneToE164("770 928 3915", "United States")).toBe("+17709283915");
    expect(actPhoneToE164("(317) 271-1207", "United States")).toBe("+13172711207");
    expect(actPhoneToE164("0 1621 840 077", "United Kingdom")).toBe("+441621840077");
  });

  it("accepts an already-international number with no country at all", () => {
    expect(actPhoneToE164("+61 (3) 9338 3471", null)).toBe("+61393383471");
  });

  it("refuses a national number when the country is unknown", () => {
    // The same string is a different subscriber in a different country, and a
    // plausible wrong number on a signed quote is worse than a blank field.
    expect(actPhoneToE164("03 94679176", null)).toBeNull();
    expect(actPhoneToE164("770 928 3915", "Atlantis")).toBeNull();
  });

  it("does not guess when the number does not fit its stated country", () => {
    // 061 0759 9550 on a US contact is an Australian number with a stray zero.
    // Treating it as international would make it +60..., which is Malaysia.
    expect(actPhoneToE164("060 5286 3604", "United States")).toBeNull();
  });

  it("returns null for junk", () => {
    expect(actPhoneToE164("", "Australia")).toBeNull();
    expect(actPhoneToE164("   ", "Australia")).toBeNull();
    expect(actPhoneToE164("\r", "Australia")).toBeNull();
    expect(actPhoneToE164("1234", "Australia")).toBeNull();
    expect(actPhoneToE164(null, "Australia")).toBeNull();
  });
});
