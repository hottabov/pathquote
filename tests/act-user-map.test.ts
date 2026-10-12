import { describe, it, expect } from "vitest";
import {
  ACCOUNT_MGR_NOTE,
  entriesToWrite,
  formatReport,
  planUserMap,
  type ActUserRow,
  type PathQuoteUserRow,
  type UserMapPlan,
} from "../src/lib/act/user-map";

/** An Act! user. Active and Standard unless the test says otherwise. */
const actUser = (
  id: string,
  email: string | null,
  overrides: Partial<ActUserRow> = {},
): ActUserRow => ({
  id,
  displayName: `Act ${id}`,
  email,
  status: "Active",
  role: "Standard",
  ...overrides,
});

/** A PathQuote user. Unmapped and active unless the test says otherwise. */
const pqUser = (
  id: string,
  email: string,
  overrides: Partial<PathQuoteUserRow> = {},
): PathQuoteUserRow => ({
  id,
  email,
  name: `PQ ${id}`,
  role: "MANAGER",
  active: true,
  actUserId: null,
  ...overrides,
});

const outcomeOf = (plan: UserMapPlan, email: string) =>
  plan.outcomes.find((line) => line.user.email === email)?.outcome;

describe("planUserMap", () => {
  describe("email is the join key", () => {
    it("matches on an identical email", () => {
      const plan = planUserMap([actUser("a1", "anna@example.com")], [pqUser("u1", "anna@example.com")]);
      expect(plan.matched).toHaveLength(1);
      expect(plan.matched[0].actUser.id).toBe("a1");
      expect(plan.unmatched).toEqual([]);
    });

    it("matches regardless of case on either side", () => {
      const plan = planUserMap(
        [actUser("a1", "Anna@Example.COM")],
        [pqUser("u1", "anna@example.com")],
      );
      expect(plan.matched.map((entry) => entry.actUser.id)).toEqual(["a1"]);
    });

    it("matches across surrounding whitespace", () => {
      const plan = planUserMap(
        [actUser("a1", "  anna@example.com \t")],
        [pqUser("u1", "anna@example.com")],
      );
      expect(plan.matched.map((entry) => entry.actUser.id)).toEqual(["a1"]);
    });

    it("does not match on a different email at the same company", () => {
      const plan = planUserMap([actUser("a1", "anna@example.com")], [pqUser("u1", "anne@example.com")]);
      expect(plan.matched).toEqual([]);
      expect(plan.unmatched.map((user) => user.id)).toEqual(["u1"]);
    });
  });

  describe("an Act! user with no email", () => {
    it("matches nobody, and is not matched on its display name", () => {
      // The name is deliberately the only thing the two have in common. A
      // display-name fallback would be wrong even when it looks right: the Act!
      // user is "Kevin du Plessis" where Account Mgr says "Kevin Du Plessis".
      const act = actUser("a1", null, { displayName: "Anna Example" });
      const plan = planUserMap([act], [pqUser("u1", "anna@example.com", { name: "Anna Example" })]);
      expect(plan.matched).toEqual([]);
      expect(plan.ambiguous).toEqual([]);
      expect(plan.unmatched.map((user) => user.id)).toEqual(["u1"]);
      expect(plan.unusedActUsers).toEqual([{ actUser: act, reason: "no-email" }]);
    });

    it("treats an email of whitespace, or of empty string, as no email at all", () => {
      const plan = planUserMap(
        [actUser("a1", "   "), actUser("a2", "")],
        [pqUser("u1", "anna@example.com")],
      );
      expect(plan.matched).toEqual([]);
      expect(plan.unusedActUsers.map((entry) => entry.reason)).toEqual(["no-email", "no-email"]);
    });
  });

  describe("two Act! users sharing one email", () => {
    it("is ambiguous, and nothing is written", () => {
      const plan = planUserMap(
        [actUser("a1", "anna@example.com"), actUser("a2", "ANNA@example.com")],
        [pqUser("u1", "anna@example.com")],
      );
      expect(plan.matched).toEqual([]);
      expect(plan.ambiguous).toHaveLength(1);
      const entry = plan.ambiguous[0];
      expect(entry.reason).toBe("two-act-users");
      if (entry.reason !== "two-act-users") throw new Error("wrong reason");
      expect(entry.candidates.map((candidate) => candidate.id)).toEqual(["a1", "a2"]);
      expect(entriesToWrite(plan, { includeInactive: true })).toEqual([]);
    });

    it("names both candidates in the report rather than picking one", () => {
      const plan = planUserMap(
        [actUser("a1", "anna@example.com"), actUser("a2", "anna@example.com")],
        [pqUser("u1", "anna@example.com")],
      );
      const report = formatReport(plan, { includeInactive: false }).join("\n");
      expect(report).toContain("two or more Act! users carry this email");
      expect(report).toContain("a1");
      expect(report).toContain("a2");
    });
  });

  describe("two PathQuote users on one email", () => {
    // User.email is @unique in prisma/schema.prisma, so the exact duplicate
    // cannot exist and is not coded for. What the index does not prevent is two
    // rows differing only in case -- Postgres compares it byte for byte -- and
    // those fold to one key here. User.actUserId is unique too, so only one of
    // them could hold the id.
    it("is ambiguous on both rows when they differ only in case", () => {
      const plan = planUserMap(
        [actUser("a1", "anna@example.com")],
        [pqUser("u1", "anna@example.com"), pqUser("u2", "Anna@Example.com")],
      );
      expect(plan.matched).toEqual([]);
      expect(plan.ambiguous).toHaveLength(2);
      for (const entry of plan.ambiguous) {
        expect(entry.reason).toBe("two-pathquote-users");
        if (entry.reason !== "two-pathquote-users") throw new Error("wrong reason");
        expect(entry.rivals).toHaveLength(1);
        expect(entry.rivals[0].id).not.toBe(entry.user.id);
      }
    });

    it("says in the report that actUserId is unique, which is why neither is written", () => {
      const plan = planUserMap(
        [actUser("a1", "anna@example.com")],
        [pqUser("u1", "anna@example.com"), pqUser("u2", "ANNA@example.com")],
      );
      expect(formatReport(plan, { includeInactive: false }).join("\n")).toContain(
        "fold to the same email, and actUserId is unique",
      );
    });
  });

  describe("an Act! user that is not Active", () => {
    it("is matched but held back, because a record owned by a disabled user is a support call", () => {
      const plan = planUserMap(
        [actUser("a1", "anna@example.com", { status: "Inactive" })],
        [pqUser("u1", "anna@example.com")],
      );
      expect(plan.matched).toEqual([]);
      expect(plan.inactiveMatched.map((entry) => entry.actUser.id)).toEqual(["a1"]);
      expect(entriesToWrite(plan, { includeInactive: false })).toEqual([]);
      expect(entriesToWrite(plan, { includeInactive: true }).map((entry) => entry.actUser.id)).toEqual([
        "a1",
      ]);
    });

    it("compares the status without regard to case or padding", () => {
      const plan = planUserMap(
        [actUser("a1", "anna@example.com", { status: " active " })],
        [pqUser("u1", "anna@example.com")],
      );
      expect(plan.matched.map((entry) => entry.actUser.id)).toEqual(["a1"]);
    });

    it("treats a missing status as active, and leaves the words on the line", () => {
      // Deliberately lenient: were the field renamed by an Act! upgrade, the
      // strict reading would hold back all twenty users and the mapping would
      // stop working, where this one maps them and says what it did not see.
      for (const status of [null, "", "   "]) {
        const plan = planUserMap(
          [actUser("a1", "anna@example.com", { status })],
          [pqUser("u1", "anna@example.com")],
        );
        expect(plan.matched.map((entry) => entry.actUser.id)).toEqual(["a1"]);
        expect(formatReport(plan, { includeInactive: false }).join("\n")).toContain(
          "status not reported",
        );
      }
    });

    it("reports a Browse licence on the line without treating it as a reason not to map", () => {
      const plan = planUserMap(
        [actUser("a1", "anna@example.com", { role: "Browse" })],
        [pqUser("u1", "anna@example.com")],
      );
      expect(plan.matched.map((entry) => entry.actUser.id)).toEqual(["a1"]);
      expect(formatReport(plan, { includeInactive: false }).join("\n")).toContain("Browse");
    });
  });

  describe("a PathQuote user whose email matches nobody", () => {
    it("is reported and never written", () => {
      const plan = planUserMap(
        [actUser("a1", "someone-else@example.com")],
        [pqUser("u1", "anna@example.com")],
      );
      expect(plan.unmatched.map((user) => user.id)).toEqual(["u1"]);
      expect(entriesToWrite(plan, { includeInactive: true })).toEqual([]);
      expect(formatReport(plan, { includeInactive: false }).join("\n")).toContain(
        "no Act! user has this email",
      );
    });
  });

  describe("idempotence", () => {
    it("re-mapping an already-mapped user writes nothing", () => {
      const act = actUser("a1", "anna@example.com");
      const plan = planUserMap([act], [pqUser("u1", "anna@example.com", { actUserId: "a1" })]);
      expect(plan.alreadyMapped.map((entry) => entry.user.id)).toEqual(["u1"]);
      expect(plan.matched).toEqual([]);
      expect(entriesToWrite(plan, { includeInactive: true })).toEqual([]);
    });

    it("leaves an already-mapped user alone even when the Act! user went inactive", () => {
      // The mapping is already in the database; reporting it as a new inactive
      // match would invite a write that has already happened.
      const plan = planUserMap(
        [actUser("a1", "anna@example.com", { status: "Inactive" })],
        [pqUser("u1", "anna@example.com", { actUserId: "a1" })],
      );
      expect(plan.alreadyMapped).toHaveLength(1);
      expect(plan.inactiveMatched).toEqual([]);
    });

    it("counts an already-mapped Act! user as claimed, not as spare", () => {
      const plan = planUserMap(
        [actUser("a1", "anna@example.com")],
        [pqUser("u1", "anna@example.com", { actUserId: "a1" })],
      );
      expect(plan.unusedActUsers).toEqual([]);
    });

    it("the second run of a successful first run has nothing left to do", () => {
      const act = [actUser("a1", "anna@example.com"), actUser("a2", "bob@example.com")];
      const before = [pqUser("u1", "anna@example.com"), pqUser("u2", "bob@example.com")];
      const first = planUserMap(act, before);
      expect(first.matched).toHaveLength(2);

      // Apply the first plan the way the script does, then plan again.
      const after = before.map((user) => {
        const entry = first.matched.find((candidate) => candidate.user.id === user.id);
        return entry ? { ...user, actUserId: entry.actUser.id } : user;
      });
      const second = planUserMap(act, after);
      expect(second.matched).toEqual([]);
      expect(second.alreadyMapped).toHaveLength(2);
      expect(second.drift).toEqual([]);
      expect(entriesToWrite(second, { includeInactive: true })).toEqual([]);
    });
  });

  describe("drift", () => {
    it("notices a stored actUserId that is no longer an Act! user", () => {
      const plan = planUserMap(
        [actUser("a1", "anna@example.com")],
        [pqUser("u1", "anna@example.com", { actUserId: "gone" })],
      );
      expect(plan.drift).toHaveLength(1);
      expect(plan.drift[0].reason).toBe("stored-id-missing");
      expect(plan.matched).toEqual([]);
      expect(formatReport(plan, { includeInactive: false }).join("\n")).toContain(
        "stored actUserId gone is not in the Act! user list",
      );
    });

    it("notices a stored actUserId whose email now belongs to someone else", () => {
      const plan = planUserMap(
        [actUser("a1", "someone-else@example.com"), actUser("a2", "anna@example.com")],
        [pqUser("u1", "anna@example.com", { actUserId: "a1" })],
      );
      expect(plan.drift).toHaveLength(1);
      const entry = plan.drift[0];
      expect(entry.reason).toBe("stored-id-other-email");
      if (entry.reason !== "stored-id-other-email") throw new Error("wrong reason");
      expect(entry.storedActUser.id).toBe("a1");
      expect(entry.matchedByEmail.map((candidate) => candidate.id)).toEqual(["a2"]);
      // Named, not repaired: re-pointing it silently would move records.
      expect(entriesToWrite(plan, { includeInactive: true })).toEqual([]);
    });

    it("notices a stored actUserId that now has no email at all", () => {
      const plan = planUserMap(
        [actUser("a1", null)],
        [pqUser("u1", "anna@example.com", { actUserId: "a1" })],
      );
      expect(plan.drift).toHaveLength(1);
      const entry = plan.drift[0];
      if (entry.reason !== "stored-id-other-email") throw new Error("wrong reason");
      expect(entry.matchedByEmail).toEqual([]);
      expect(formatReport(plan, { includeInactive: false }).join("\n")).toContain(
        "No Act! user carries this person's email",
      );
    });

    it("holds back a match whose Act! id is already stored on another PathQuote row", () => {
      // u1 holds a1 but a1's email is bob's now; u2 IS bob. Writing a1 onto u2
      // would hit the unique index on actUserId, so it is reported instead.
      const plan = planUserMap(
        [actUser("a1", "bob@example.com")],
        [
          pqUser("u1", "anna@example.com", { actUserId: "a1" }),
          pqUser("u2", "bob@example.com"),
        ],
      );
      expect(plan.matched).toEqual([]);
      expect(plan.drift).toHaveLength(2);
      const reasons = plan.drift.map((entry) => entry.reason).sort();
      expect(reasons).toEqual(["stored-id-other-email", "target-held-by-another-user"]);
      expect(formatReport(plan, { includeInactive: false }).join("\n")).toContain(
        "User.actUserId is unique, so the write would fail",
      );
    });
  });

  describe("Act! users nobody claims", () => {
    it("lists them, with why, and never writes for them", () => {
      const plan = planUserMap(
        [
          actUser("a1", "anna@example.com"),
          actUser("a2", "spare@example.com"),
          actUser("a3", null),
        ],
        [pqUser("u1", "anna@example.com")],
      );
      expect(plan.unusedActUsers).toEqual([
        { actUser: actUser("a2", "spare@example.com"), reason: "no-pathquote-user" },
        { actUser: actUser("a3", null), reason: "no-email" },
      ]);
    });
  });

  describe("every user is accounted for exactly once", () => {
    const act = [
      actUser("a1", "anna@example.com"),
      actUser("a2", "bob@example.com", { status: "Inactive" }),
      actUser("a3", "carol@example.com"),
      actUser("a4", "carol@example.com"),
      actUser("a5", null),
      actUser("a6", "spare@example.com"),
    ];
    const pq = [
      pqUser("u1", "anna@example.com"),
      pqUser("u2", "bob@example.com"),
      pqUser("u3", "carol@example.com"),
      pqUser("u4", "dave@example.com"),
      pqUser("u5", "erin@example.com", { actUserId: "gone" }),
      pqUser("u6", "frank@example.com", { actUserId: "a1" }),
      pqUser("u7", "gail@example.com", { active: false }),
    ];

    it("puts each PathQuote user in one group, and the groups sum to the total", () => {
      const plan = planUserMap(act, pq);
      const groups =
        plan.matched.length +
        plan.alreadyMapped.length +
        plan.inactiveMatched.length +
        plan.ambiguous.length +
        plan.unmatched.length +
        plan.drift.length;
      expect(plan.pathQuoteUsers).toBe(pq.length);
      expect(groups).toBe(pq.length);
      expect(plan.outcomes).toHaveLength(pq.length);
      expect(new Set(plan.outcomes.map((line) => line.user.id)).size).toBe(pq.length);
    });

    it("gives each user the outcome its row calls for", () => {
      const plan = planUserMap(act, pq);
      // u1's email matches a1, but u6 already stores a1, so u1 cannot have it.
      expect(outcomeOf(plan, "anna@example.com")).toBe("drift");
      expect(outcomeOf(plan, "bob@example.com")).toBe("inactive-match");
      expect(outcomeOf(plan, "carol@example.com")).toBe("ambiguous");
      expect(outcomeOf(plan, "dave@example.com")).toBe("unmatched");
      expect(outcomeOf(plan, "erin@example.com")).toBe("drift");
      expect(outcomeOf(plan, "frank@example.com")).toBe("drift");
      expect(outcomeOf(plan, "gail@example.com")).toBe("unmatched");
    });

    it("lists the outcomes in email order", () => {
      const plan = planUserMap(act, pq);
      const emails = plan.outcomes.map((line) => line.user.email);
      expect(emails).toEqual([...emails].sort());
    });

    it("never writes a mapping that is not in matched or inactiveMatched", () => {
      const plan = planUserMap(act, pq);
      const writable = new Set([...plan.matched, ...plan.inactiveMatched].map((e) => e.user.id));
      for (const entry of entriesToWrite(plan, { includeInactive: true })) {
        expect(writable.has(entry.user.id)).toBe(true);
      }
      for (const entry of entriesToWrite(plan, { includeInactive: false })) {
        expect(plan.matched).toContain(entry);
      }
    });

    it("never offers to write the same Act! id to two PathQuote users", () => {
      const plan = planUserMap(act, pq);
      const ids = entriesToWrite(plan, { includeInactive: true }).map((entry) => entry.actUser.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe("no input at all", () => {
    it("plans nothing and says so rather than throwing", () => {
      const plan = planUserMap([], []);
      expect(plan).toMatchObject({ pathQuoteUsers: 0, actUsers: 0 });
      expect(entriesToWrite(plan, { includeInactive: true })).toEqual([]);
      expect(formatReport(plan, { includeInactive: false }).join("\n")).toContain(
        "EVERY PATHQUOTE USER: 0",
      );
    });
  });
});

describe("formatReport", () => {
  const plan = planUserMap(
    [
      actUser("a1", "anna@example.com", { displayName: "Anna Example" }),
      actUser("a2", "bob@example.com", { status: "Inactive", displayName: "Bob Example" }),
    ],
    [
      pqUser("u1", "anna@example.com", { name: "Anna Example" }),
      pqUser("u2", "bob@example.com", { name: "Bob Example" }),
      pqUser("u3", "carol@example.com", { name: "Carol Example" }),
    ],
  );

  it("lists every PathQuote user, matched or not", () => {
    const report = formatReport(plan, { includeInactive: false }).join("\n");
    for (const email of ["anna@example.com", "bob@example.com", "carol@example.com"]) {
      expect(report).toContain(email);
    }
  });

  it("calls out the three problem categories separately", () => {
    const report = formatReport(plan, { includeInactive: false }).join("\n");
    expect(report).toContain("AMBIGUOUS:");
    expect(report).toContain("UNMATCHED:");
    expect(report).toContain("DRIFT:");
  });

  it("says whether the inactive matches would be written, and the flag that changes it", () => {
    expect(formatReport(plan, { includeInactive: false }).join("\n")).toContain(
      "held back; add --include-inactive to write them",
    );
    expect(formatReport(plan, { includeInactive: true }).join("\n")).toContain(
      "included by --include-inactive, would be written",
    );
  });

  it("explains that actAccountMgr is left alone, and what resolving it needs", () => {
    const report = formatReport(plan, { includeInactive: false }).join("\n");
    expect(report).toContain("nothing is written to User.actAccountMgr");
    expect(report).toContain("isLimitToList: true");
    expect(report).toContain("/api/metadata/drop-down/lists/{list}/items");
  });

  it("never claims to write actAccountMgr", () => {
    const report = formatReport(plan, { includeInactive: true }).join("\n");
    // The note is the only place the column is named, and it says it is not
    // written. Guard against a later edit adding a line that says otherwise.
    for (const line of report.split("\n")) {
      if (!line.includes("actAccountMgr")) continue;
      expect(line).toContain("nothing is written to User.actAccountMgr");
    }
  });

  it("the Account Mgr note stands on its own, without the rest of the report", () => {
    expect(ACCOUNT_MGR_NOTE.join("\n")).toContain("Account Mgr is customFields/rep");
  });

  it("counts the same things in the summary as in the sections", () => {
    const report = formatReport(plan, { includeInactive: false });
    const summary = report.slice(report.indexOf("SUMMARY"));
    const value = (label: string) => {
      const line = summary.find((candidate) => candidate.includes(label));
      return line ? Number(line.trim().split(/\s+/).pop()?.replace(/\D/g, "")) : NaN;
    };
    expect(value("PathQuote users")).toBe(3);
    expect(value("Act! users")).toBe(2);
    expect(value("would be mapped")).toBe(plan.matched.length);
    expect(value("unmatched")).toBe(plan.unmatched.length);
  });
});
