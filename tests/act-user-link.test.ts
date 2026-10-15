import { describe, it, expect } from "vitest";
import { ActApiError, ActNoAnswerError, ActNotSentError } from "../src/lib/act/client";
import {
  ACT_USER_LINK_DEADLINE_MS,
  ActUserLinkDeadlineError,
  actUnreachableMessage,
  actUnreachableReason,
  actUserHeldError,
  actUserLabel,
  buildAccountMgrOptions,
  buildActUserOptions,
  describeCurrentLink,
  fallbackOwnerName,
  isInactiveStatus,
  parseActLinkForm,
  suggestAccountMgr,
  suggestActUser,
  validateActLink,
  type ActUserRow,
  type LinkedPathQuoteUser,
  type RepPicklistItem,
} from "../src/lib/act/user-link";

const actUser = (id: string, displayName: string | null, overrides: Partial<ActUserRow> = {}): ActUserRow => ({
  id,
  displayName,
  email: null,
  status: "Active",
  role: "Standard",
  ...overrides,
});

const rep = (value: string | null, id = `rep-${value}`): RepPicklistItem => ({ id, value, description: null });

const pq = (id: string, overrides: Partial<LinkedPathQuoteUser> = {}): LinkedPathQuoteUser => ({
  id,
  name: `PQ ${id}`,
  email: `${id}@example.com`,
  actUserId: null,
  ...overrides,
});

describe("isInactiveStatus", () => {
  it("is false for Active in any case and for a missing status", () => {
    expect(isInactiveStatus("Active")).toBe(false);
    expect(isInactiveStatus(" active ")).toBe(false);
    expect(isInactiveStatus(null)).toBe(false);
    expect(isInactiveStatus("  ")).toBe(false);
  });

  it("is true for any explicit status other than Active", () => {
    expect(isInactiveStatus("Inactive")).toBe(true);
    expect(isInactiveStatus("Disabled")).toBe(true);
  });
});

describe("actUserLabel", () => {
  it("is the bare name for an Active user with no email", () => {
    expect(actUserLabel(actUser("a", "Jane Doe"))).toBe("Jane Doe");
  });

  it("adds the email when there is one", () => {
    expect(actUserLabel(actUser("a", "Jane Doe", { email: " jane@x.com " }))).toBe("Jane Doe — jane@x.com");
  });

  it("tags a non-Active user with ACT!'s own status word", () => {
    expect(actUserLabel(actUser("a", "Mr Sistemas", { status: "Inactive" }))).toBe("Mr Sistemas (Inactive)");
    expect(actUserLabel(actUser("a", "Jo", { status: "Inactive", email: "jo@x.com" }))).toBe(
      "Jo (Inactive) — jo@x.com",
    );
  });

  it("does not tag a user whose status is missing", () => {
    expect(actUserLabel(actUser("a", "Jo", { status: null }))).toBe("Jo");
  });

  it("names a user with no display name rather than printing nothing", () => {
    expect(actUserLabel(actUser("a", null))).toBe("(no display name)");
    expect(actUserLabel(actUser("a", "   "))).toBe("(no display name)");
  });
});

describe("buildActUserOptions", () => {
  it("lists every ACT! user sorted by display name, case-insensitively, Inactive ones included", () => {
    const options = buildActUserOptions(
      [
        actUser("3", "zed"),
        actUser("1", "Bob", { status: "Inactive" }),
        actUser("2", "alice", { email: "a@x.com" }),
      ],
      [],
      null,
    );
    expect(options.map((option) => option.label)).toEqual(["alice — a@x.com", "Bob (Inactive)", "zed"]);
    expect(options.map((option) => option.value)).toEqual(["2", "1", "3"]);
    expect(options.every((option) => !option.missing)).toBe(true);
  });

  it("breaks a tie in display name by id, so the order is stable", () => {
    const options = buildActUserOptions([actUser("b", "Same"), actUser("a", "Same")], [], null);
    expect(options.map((option) => option.value)).toEqual(["a", "b"]);
  });

  it("carries each user's suggested Rep item", () => {
    const options = buildActUserOptions(
      [actUser("1", "Kevin du Plessis"), actUser("2", "Nobody")],
      [rep("Kevin Du Plessis")],
      null,
    );
    expect(options.find((option) => option.value === "1")?.suggestedAccountMgr).toBe("Kevin Du Plessis");
    expect(options.find((option) => option.value === "2")?.suggestedAccountMgr).toBeNull();
  });

  it("puts a stored id ACT! no longer lists first, marked missing", () => {
    const options = buildActUserOptions([actUser("1", "Jane")], [], "gone");
    expect(options[0]).toEqual({
      value: "gone",
      label: "gone (not an ACT! user any more)",
      suggestedAccountMgr: null,
      missing: true,
    });
    expect(options).toHaveLength(2);
  });

  it("adds nothing for a stored id ACT! still lists", () => {
    expect(buildActUserOptions([actUser("1", "Jane")], [], "1")).toHaveLength(1);
  });
});

describe("buildAccountMgrOptions", () => {
  it("keeps ACT!'s order and its exact spelling, whitespace and case included", () => {
    const options = buildAccountMgrOptions([rep("zed"), rep(" Anna "), rep("john hollo")], null);
    expect(options.map((option) => option.value)).toEqual(["zed", " Anna ", "john hollo"]);
    expect(options.map((option) => option.label)).toEqual(["zed", " Anna ", "john hollo"]);
  });

  it("leaves out null and empty values, which cannot be told from none, and lists a duplicate once", () => {
    const options = buildAccountMgrOptions([rep(null, "n"), rep(""), rep("A", "1"), rep("A", "2")], null);
    expect(options.map((option) => option.value)).toEqual(["A"]);
  });

  it("puts a stored value that is not an item first, marked missing", () => {
    const options = buildAccountMgrOptions([rep("A")], "Old Name");
    expect(options[0]).toEqual({ value: "Old Name", label: "Old Name (not in the Rep list)", missing: true });
    expect(options).toHaveLength(2);
  });

  it("treats a stored value differing only in case as not an item", () => {
    const options = buildAccountMgrOptions([rep("Kevin du Plessis")], "Kevin Du Plessis");
    expect(options[0].missing).toBe(true);
  });

  it("adds nothing for a stored value that is an item", () => {
    expect(buildAccountMgrOptions([rep("A")], "A")).toHaveLength(1);
  });
});

describe("suggestActUser", () => {
  const users = [actUser("1", "Jane Doe"), actUser("2", "Achim Degel", { status: "Inactive" })];

  it("suggests the one ACT! user named like the PathQuote user, trimmed and ignoring case", () => {
    expect(suggestActUser("  achim DEGEL ", users)?.id).toBe("2");
    expect(suggestActUser("Jane Doe", users)?.id).toBe("1");
  });

  it("suggests nobody when no name matches", () => {
    expect(suggestActUser("Someone Else", users)).toBeNull();
  });

  it("suggests nobody when the name matches two ACT! users", () => {
    expect(suggestActUser("jane doe", [...users, actUser("3", "JANE DOE")])).toBeNull();
  });

  it("suggests nobody for a PathQuote user with no name", () => {
    expect(suggestActUser(null, users)).toBeNull();
    expect(suggestActUser("   ", users)).toBeNull();
  });

  it("never matches an ACT! user with no display name", () => {
    expect(suggestActUser("", [actUser("1", null)])).toBeNull();
  });
});

describe("suggestAccountMgr", () => {
  it("prefers the item spelled identically", () => {
    expect(suggestAccountMgr("John Hollo", [rep("john hollo"), rep("John Hollo")])).toBe("John Hollo");
  });

  it("falls back to the one item equal ignoring case and surrounding space, in the item's spelling", () => {
    expect(suggestAccountMgr("Kevin du Plessis", [rep("Kevin Du Plessis ")])).toBe("Kevin Du Plessis ");
  });

  it("suggests nothing when two items differ only in case", () => {
    expect(suggestAccountMgr("Jo", [rep("JO"), rep("jo")])).toBeNull();
  });

  it("suggests nothing with no display name or no matching item", () => {
    expect(suggestAccountMgr(null, [rep("A")])).toBeNull();
    expect(suggestAccountMgr("B", [rep("A")])).toBeNull();
    expect(suggestAccountMgr("B", [])).toBeNull();
  });
});

describe("parseActLinkForm", () => {
  it("reads both fields, the empty string as clear", () => {
    expect(parseActLinkForm({ actUserId: "", accountMgr: "" })).toEqual({
      ok: true,
      value: { actUserId: null, accountMgr: null },
    });
  });

  it("trims the id but keeps the Acc Mgr value byte for byte", () => {
    expect(parseActLinkForm({ actUserId: " u1 ", accountMgr: " Anna " })).toEqual({
      ok: true,
      value: { actUserId: "u1", accountMgr: " Anna " },
    });
  });

  it("refuses a form that did not send a field, rather than reading it as clear", () => {
    expect(parseActLinkForm({ actUserId: null, accountMgr: "" }).ok).toBe(false);
    expect(parseActLinkForm({ actUserId: "u1", accountMgr: null }).ok).toBe(false);
    expect(parseActLinkForm({ actUserId: undefined, accountMgr: undefined }).ok).toBe(false);
  });
});

describe("validateActLink", () => {
  const actUsers = [actUser("a1", "Jane"), actUser("a2", "Mr Sistemas", { status: "Inactive" })];
  const repItems = [rep("Jane"), rep("Mr Sistemas")];
  const base = { userId: "u1", actUsers, repItems, otherUsers: [] as LinkedPathQuoteUser[] };

  it("accepts an ACT! user and a Rep item", () => {
    const verdict = validateActLink({ ...base, submission: { actUserId: "a1", accountMgr: "Jane" } });
    expect(verdict).toEqual({ ok: true, value: { actUserId: "a1", accountMgr: "Jane" } });
  });

  it("accepts an Inactive ACT! user -- that is what a distributor is", () => {
    const verdict = validateActLink({ ...base, submission: { actUserId: "a2", accountMgr: "Mr Sistemas" } });
    expect(verdict.ok).toBe(true);
  });

  it("accepts clearing both, and either one alone", () => {
    expect(validateActLink({ ...base, submission: { actUserId: null, accountMgr: null } }).ok).toBe(true);
    expect(validateActLink({ ...base, submission: { actUserId: "a1", accountMgr: null } }).ok).toBe(true);
    expect(validateActLink({ ...base, submission: { actUserId: null, accountMgr: "Jane" } }).ok).toBe(true);
  });

  it("refuses an id that is not one of ACT!'s users", () => {
    const verdict = validateActLink({ ...base, submission: { actUserId: "nope", accountMgr: null } });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toMatch(/not in ACT!'s user list/);
  });

  it("refuses an Acc Mgr value that is not exactly a Rep item, even one differing only in case or space", () => {
    for (const value of ["jane", "Jane ", "Somebody"]) {
      const verdict = validateActLink({ ...base, submission: { actUserId: null, accountMgr: value } });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.error).toContain(`“${value}”`);
    }
  });

  it("refuses an ACT! user already stored on another PathQuote user, naming them", () => {
    const verdict = validateActLink({
      ...base,
      submission: { actUserId: "a1", accountMgr: null },
      otherUsers: [pq("u2", { name: "Chris Gilmartin", email: "chris@x.com", actUserId: "a1" })],
    });
    expect(verdict).toEqual({ ok: false, error: actUserHeldError({ name: "Chris Gilmartin", email: "chris@x.com" }) });
    if (!verdict.ok) expect(verdict.error).toContain("Chris Gilmartin (chris@x.com)");
  });

  it("does not count the user's own stored link as a conflict", () => {
    const verdict = validateActLink({
      ...base,
      submission: { actUserId: "a1", accountMgr: null },
      otherUsers: [pq("u1", { actUserId: "a1" })],
    });
    expect(verdict.ok).toBe(true);
  });

  it("ignores other users holding a different ACT! user, or none", () => {
    const verdict = validateActLink({
      ...base,
      submission: { actUserId: "a1", accountMgr: null },
      otherUsers: [pq("u2", { actUserId: "a2" }), pq("u3")],
    });
    expect(verdict.ok).toBe(true);
  });

  it("checks the ACT! user before the Acc Mgr value", () => {
    const verdict = validateActLink({ ...base, submission: { actUserId: "nope", accountMgr: "nope" } });
    if (!verdict.ok) expect(verdict.error).toMatch(/user list/);
  });
});

describe("actUserHeldError", () => {
  it("names a user by name and email, or by email when there is no name", () => {
    expect(actUserHeldError({ name: "Jo", email: "jo@x.com" })).toContain("linked to Jo (jo@x.com).");
    expect(actUserHeldError({ name: null, email: "jo@x.com" })).toContain("linked to jo@x.com.");
    expect(actUserHeldError({ name: "  ", email: "jo@x.com" })).toContain("linked to jo@x.com.");
  });
});

describe("describeCurrentLink", () => {
  const actUsers = [
    actUser("a1", "Jane", { email: "jane@x.com" }),
    actUser("a2", "Mr Sistemas", { status: "Inactive" }),
  ];

  it("says who owns the records of an unlinked user: the ACT_USER login", () => {
    const view = describeCurrentLink({ storedActUserId: null, storedAccountMgr: null, actUsers, loginName: "John Hollo" });
    expect(view).toEqual({
      actUser: "Not linked — records for this user's quotes are owned by John Hollo.",
      linked: false,
      accountMgr: "none",
    });
  });

  it("names the ACT! user, status and email when linked", () => {
    const view = describeCurrentLink({ storedActUserId: "a1", storedAccountMgr: "Jane", actUsers, loginName: "x" });
    expect(view).toEqual({ actUser: "Jane · Active · jane@x.com", linked: true, accountMgr: "Jane" });
  });

  it("says no email for a distributor", () => {
    const view = describeCurrentLink({ storedActUserId: "a2", storedAccountMgr: null, actUsers, loginName: "x" });
    expect(view.actUser).toBe("Mr Sistemas · Inactive · no email");
  });

  it("shows the stored id when ACT! could not be read", () => {
    const view = describeCurrentLink({ storedActUserId: "a1", storedAccountMgr: "Jane", actUsers: null, loginName: "x" });
    expect(view.actUser).toBe("ACT! user a1 (details unavailable)");
    expect(view.accountMgr).toBe("Jane");
  });

  it("says when ACT! no longer lists the stored id", () => {
    const view = describeCurrentLink({ storedActUserId: "gone", storedAccountMgr: null, actUsers, loginName: "x" });
    expect(view.actUser).toMatch(/^ACT! user gone, which ACT! no longer lists/);
  });

  it("explains a missing ACT_USER rather than printing nothing", () => {
    expect(fallbackOwnerName(null)).toMatch(/ACT_USER/);
    expect(fallbackOwnerName("  ")).toMatch(/ACT_USER/);
    expect(fallbackOwnerName(" John Hollo ")).toBe("John Hollo");
  });
});

describe("actUnreachableReason", () => {
  it("names the deadline", () => {
    expect(actUnreachableReason(new ActUserLinkDeadlineError(ACT_USER_LINK_DEADLINE_MS))).toBe(
      "no answer within 10 seconds",
    );
  });

  it("names missing environment variables", () => {
    expect(actUnreachableReason(new Error("missing environment: ACT_BASE, ACT_PASS"))).toBe(
      "ACT! is not configured on this server (ACT_BASE, ACT_PASS not set)",
    );
  });

  it("gives ACT!'s status, and says when it was the login that was refused", () => {
    expect(actUnreachableReason(new ActApiError("x", "GET", 503, "", "failed"))).toBe("ACT! answered HTTP 503");
    expect(actUnreachableReason(new ActApiError("x", "GET", 401, "", "refused", { authorizing: true }))).toBe(
      "ACT! refused the login (HTTP 401)",
    );
  });

  it("calls a request that was not sent or got no answer 'no answer'", () => {
    expect(actUnreachableReason(new ActNotSentError("GET /api/users", "timeout"))).toBe("no answer from ACT!");
    expect(actUnreachableReason(new ActNoAnswerError("GET /api/users", 1, "timeout"))).toBe("no answer from ACT!");
  });

  it("quotes anything else, cut short", () => {
    expect(actUnreachableReason(new Error("boom"))).toBe("boom");
    expect(actUnreachableReason("plain")).toBe("plain");
    const long = actUnreachableReason(new Error("x".repeat(500)));
    expect(long.length).toBe(160);
    expect(long.endsWith("…")).toBe(true);
  });

  it("goes into the section's sentence", () => {
    expect(actUnreachableMessage("no answer from ACT!")).toBe(
      "ACT! could not be reached: no answer from ACT!; the link cannot be changed right now.",
    );
  });
});
