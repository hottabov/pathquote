import { describe, it, expect } from "vitest";
import {
  accountMgrWrites,
  entriesToWrite,
  formatAccountMgrSection,
  formatReport,
  matchAccountMgr,
  planUserMap,
  type ActUserRow,
  type PathQuoteUserRow,
  type RepPicklistItem,
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
  actAccountMgr: null,
  ...overrides,
});

/** A `Rep` picklist item. `value` is what the limit-to-list field accepts. */
const repItem = (value: string | null, description: string | null = null): RepPicklistItem => ({
  id: `item-${value ?? "null"}`,
  value,
  description,
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

    it("says a link to an Act! user with no email was made by hand, and writes nothing for it", () => {
      // A distributor linked in Settings -> Users -> <user> -> ACT!: Inactive,
      // no email, and an exact Rep item that must not be filled in from here.
      const plan = planUserMap(
        [actUser("a1", null, { status: "Inactive", displayName: "Mr Sistemas" })],
        [pqUser("u1", "dist@example.com", { actUserId: "a1" })],
        [{ id: "r1", value: "Mr Sistemas", description: null }],
      );
      const report = formatReport(plan, { includeInactive: true }).join("\n");
      expect(report).toContain("this link was made by hand");
      expect(entriesToWrite(plan, { includeInactive: true })).toEqual([]);
      expect(accountMgrWrites(plan, { includeInactive: true })).toEqual([]);
      // Claimed by the stored link, so not relisted as a spare Act! user.
      expect(plan.unusedActUsers).toEqual([]);
    });

    it("does not call a stored link to another person's email a hand link", () => {
      const plan = planUserMap(
        [actUser("a1", "someone-else@example.com")],
        [pqUser("u1", "anna@example.com", { actUserId: "a1" })],
      );
      expect(formatReport(plan, { includeInactive: false }).join("\n")).not.toContain("made by hand");
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

  it("carries the Account Mgr section, which says what the rule for it is", () => {
    const report = formatReport(plan, { includeInactive: false }).join("\n");
    expect(report).toContain("ACCOUNT MGR -- User.actAccountMgr, set only on an exact picklist match");
    expect(report).toContain("isLimitToList: true");
  });

  it("says how many picklist items it had, so an empty picklist is not a silent one", () => {
    // This plan was built with no picklist at all, so the only honest report is
    // that nothing could be resolved -- not that the users have no item.
    const report = formatReport(plan, { includeInactive: false }).join("\n");
    expect(report).toContain("0 item(s) were read from the API for this run");
    expect(report).toContain("WOULD SET: 0");
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

describe("matchAccountMgr", () => {
  const items = [repItem("Alan Seymour"), repItem("Kevin du Plessis"), repItem("Mr Sistemas")];

  it("matches a display name that equals an item byte for byte", () => {
    const match = matchAccountMgr("Alan Seymour", items);
    expect(match).toEqual({ kind: "exact", value: "Alan Seymour", item: items[0] });
  });

  it("takes the value from the picklist item, not from the display name", () => {
    // They are equal in this branch, so the assertion is about provenance: the
    // picklist is the authority on what a limit-to-list field accepts, and this
    // stays correct if the rule ever loosens.
    const match = matchAccountMgr("Alan Seymour", items);
    if (match.kind !== "exact") throw new Error("expected an exact match");
    expect(match.value).toBe(match.item.value);
  });

  it("does NOT match on case alone, and reports the near-match instead", () => {
    // The live shape of this: the Act! user is `Kevin du Plessis` and the
    // Account Mgr value somebody typed onto 77 contacts is `Kevin Du Plessis`.
    // A field with isLimitToList accepts one of those spellings and not the
    // other, so normalising would answer "write it" for a string the picklist
    // may not contain.
    const match = matchAccountMgr("Kevin Du Plessis", items);
    expect(match.kind).toBe("near");
    if (match.kind !== "near") throw new Error("expected a near match");
    expect(match.items.map((item) => item.value)).toEqual(["Kevin du Plessis"]);
  });

  it("does NOT match across surrounding whitespace either", () => {
    const match = matchAccountMgr(" Alan Seymour ", items);
    expect(match.kind).toBe("near");
  });

  it("prefers an exact match over a near one when both exist", () => {
    const both = [repItem("alan seymour"), repItem("Alan Seymour")];
    const match = matchAccountMgr("Alan Seymour", both);
    expect(match).toMatchObject({ kind: "exact", value: "Alan Seymour" });
  });

  it("reports every near item when more than one folds to the same name", () => {
    const match = matchAccountMgr("MR SISTEMAS", [repItem("Mr Sistemas"), repItem("mr sistemas")]);
    if (match.kind !== "near") throw new Error("expected a near match");
    expect(match.items).toHaveLength(2);
  });

  it("is `none` when no item resembles the name", () => {
    expect(matchAccountMgr("Eadaoin Wright", items)).toEqual({ kind: "none" });
  });

  it("is `none` for an empty picklist, which is what an unread picklist looks like", () => {
    expect(matchAccountMgr("Alan Seymour", [])).toEqual({ kind: "none" });
  });

  it("is `none` for a display name that is null, empty or whitespace", () => {
    for (const name of [null, "", "   "]) {
      expect(matchAccountMgr(name, items)).toEqual({ kind: "none" });
    }
  });

  it("ignores an item whose value is null rather than matching a null name to it", () => {
    expect(matchAccountMgr(null, [repItem(null)])).toEqual({ kind: "none" });
    expect(matchAccountMgr("Alan Seymour", [repItem(null)])).toEqual({ kind: "none" });
  });
});

describe("accountMgrWrites", () => {
  const items = [repItem("Act a1"), repItem("Act a2"), repItem("Act a3")];

  it("writes the exact item for a user this run maps", () => {
    const plan = planUserMap(
      [actUser("a1", "anna@example.com")],
      [pqUser("u1", "anna@example.com")],
      items,
    );
    expect(accountMgrWrites(plan, { includeInactive: false })).toEqual([
      { user: plan.matched[0].user, actUser: plan.matched[0].actUser, value: "Act a1" },
    ]);
  });

  it("writes it for a row an earlier run already mapped but left without a value", () => {
    // The whole reason alreadyMapped is in the write set: no run before this
    // change could set the second column, so every row mapped so far needs it.
    const plan = planUserMap(
      [actUser("a1", "anna@example.com")],
      [pqUser("u1", "anna@example.com", { actUserId: "a1" })],
      items,
    );
    expect(plan.alreadyMapped).toHaveLength(1);
    expect(plan.matched).toEqual([]);
    expect(accountMgrWrites(plan, { includeInactive: false }).map((write) => write.value)).toEqual([
      "Act a1",
    ]);
  });

  it("never overwrites a value somebody already typed", () => {
    const plan = planUserMap(
      [actUser("a1", "anna@example.com")],
      [pqUser("u1", "anna@example.com", { actAccountMgr: "Act a1" })],
      items,
    );
    expect(accountMgrWrites(plan, { includeInactive: false })).toEqual([]);
    expect(plan.accountMgrConflicts).toEqual([]);
  });

  it("reports -- and does not repair -- a stored value that is not the item", () => {
    const plan = planUserMap(
      [actUser("a1", "anna@example.com")],
      [pqUser("u1", "anna@example.com", { actAccountMgr: "Somebody Else" })],
      items,
    );
    expect(accountMgrWrites(plan, { includeInactive: false })).toEqual([]);
    expect(plan.accountMgrConflicts).toMatchObject([{ stored: "Somebody Else", value: "Act a1" }]);
  });

  it("writes nothing for a near-match, however the run was flagged", () => {
    const plan = planUserMap(
      [actUser("a1", "anna@example.com", { displayName: "Kevin Du Plessis" })],
      [pqUser("u1", "anna@example.com")],
      [repItem("Kevin du Plessis")],
    );
    expect(plan.matched).toHaveLength(1);
    expect(accountMgrWrites(plan, { includeInactive: false })).toEqual([]);
    expect(accountMgrWrites(plan, { includeInactive: true })).toEqual([]);
    expect(plan.accountMgrGaps).toMatchObject([{ match: { kind: "near" } }]);
  });

  it("follows --include-inactive, so the two columns never disagree about a row", () => {
    const plan = planUserMap(
      [actUser("a1", "anna@example.com", { status: "Inactive" })],
      [pqUser("u1", "anna@example.com")],
      items,
    );
    expect(plan.inactiveMatched).toHaveLength(1);
    expect(accountMgrWrites(plan, { includeInactive: false })).toEqual([]);
    expect(accountMgrWrites(plan, { includeInactive: true }).map((write) => write.value)).toEqual([
      "Act a1",
    ]);
  });

  it("writes nothing for an ambiguous or unmatched row even when an item exists", () => {
    const plan = planUserMap(
      [actUser("a1", "anna@example.com"), actUser("a2", "anna@example.com")],
      [pqUser("u1", "anna@example.com"), pqUser("u2", "dave@example.com")],
      items,
    );
    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.unmatched).toHaveLength(1);
    expect(accountMgrWrites(plan, { includeInactive: true })).toEqual([]);
    // And nothing is reported as a gap either: the Act! user behind an
    // ambiguous row is in doubt, so a gap against it would send an
    // administrator to edit the wrong picklist item.
    expect(plan.accountMgrGaps).toEqual([]);
  });

  it("writes nothing when the picklist was never read", () => {
    const plan = planUserMap(
      [actUser("a1", "anna@example.com")],
      [pqUser("u1", "anna@example.com")],
    );
    expect(plan.repPicklistItems).toBe(0);
    expect(accountMgrWrites(plan, { includeInactive: true })).toEqual([]);
  });

  it("is idempotent: the rows it would write are exactly the ones still null", () => {
    const plan = planUserMap(
      [actUser("a1", "anna@example.com")],
      [pqUser("u1", "anna@example.com", { actUserId: "a1", actAccountMgr: "Act a1" })],
      items,
    );
    expect(accountMgrWrites(plan, { includeInactive: true })).toEqual([]);
    expect(entriesToWrite(plan, { includeInactive: true })).toEqual([]);
  });
});

describe("formatAccountMgrSection", () => {
  it("lists what it would set, with the value quoted", () => {
    const plan = planUserMap(
      [actUser("a1", "anna@example.com", { displayName: "Anna Example" })],
      [pqUser("u1", "anna@example.com")],
      [repItem("Anna Example")],
    );
    const section = formatAccountMgrSection(plan, { includeInactive: false }).join("\n");
    expect(section).toContain("WOULD SET: 1");
    expect(section).toContain('"Anna Example"');
  });

  it("puts the two spellings of a near-match side by side, quoted", () => {
    // Quoted on purpose: the difference is a capital letter, and a reader
    // cannot be asked to spot that in unquoted text.
    const plan = planUserMap(
      [actUser("a1", "kevin@example.com", { displayName: "Kevin Du Plessis" })],
      [pqUser("u1", "kevin@example.com")],
      [repItem("Kevin du Plessis")],
    );
    const section = formatAccountMgrSection(plan, { includeInactive: false }).join("\n");
    expect(section).toContain("NEAR MATCH, NOT WRITTEN: 1");
    expect(section).toContain('Act! display name  "Kevin Du Plessis"');
    expect(section).toContain('picklist item      "Kevin du Plessis"');
    expect(section).toContain("will not pick one for you");
  });

  it("names the users an administrator has to add an item for", () => {
    const plan = planUserMap(
      [actUser("a1", "anna@example.com", { displayName: "Anna Example" })],
      [pqUser("u1", "anna@example.com")],
      [repItem("Someone Else")],
    );
    const section = formatAccountMgrSection(plan, { includeInactive: false }).join("\n");
    expect(section).toContain("NO PICKLIST ITEM: 1");
    expect(section).toContain('"Anna Example"');
    expect(section).toContain("Define Fields");
  });

  it("lists the picklist items that belong to no Act! user, with any description", () => {
    const plan = planUserMap(
      [actUser("a1", "anna@example.com", { displayName: "Anna Example" })],
      [pqUser("u1", "anna@example.com")],
      [repItem("Anna Example"), repItem("Mr Sistemas", "distributor")],
    );
    const section = formatAccountMgrSection(plan, { includeInactive: false }).join("\n");
    expect(section).toContain("PICKLIST ITEMS THAT ARE NO ACT! USER: 1 of 2");
    expect(section).toContain('"Mr Sistemas"  -- distributor');
  });

  it("says how many exact items are held back by an inactive Act! user", () => {
    // Otherwise the omission is silent: an inactive match with a good item is
    // in neither the write list nor the gap list, and a reader who knows that
    // person has an item is left wondering where it went.
    const plan = planUserMap(
      [actUser("a1", "anna@example.com", { displayName: "Anna Example", status: "Inactive" })],
      [pqUser("u1", "anna@example.com")],
      [repItem("Anna Example")],
    );
    const held = formatAccountMgrSection(plan, { includeInactive: false }).join("\n");
    expect(held).toContain("WOULD SET: 0");
    expect(held).toContain("1 not listed: an exact item exists but the Act! user is not Active");

    const included = formatAccountMgrSection(plan, { includeInactive: true }).join("\n");
    expect(included).toContain("WOULD SET: 1");
    expect(included).not.toContain("not listed");
  });

  it("says `none` in every empty subsection rather than leaving a blank", () => {
    const plan = planUserMap([], [], []);
    const section = formatAccountMgrSection(plan, { includeInactive: false });
    expect(section.filter((line) => line.trim() === "none")).toHaveLength(5);
  });

  it("never says the column is left unwritten, because it no longer is", () => {
    // The claim this section used to make. Eleven defects of the
    // comment-asserts-what-the-code-does-not-do class were caught on this
    // branch; this one is now caught by a test.
    const plan = planUserMap(
      [actUser("a1", "anna@example.com", { displayName: "Anna Example" })],
      [pqUser("u1", "anna@example.com")],
      [repItem("Anna Example")],
    );
    const report = formatReport(plan, { includeInactive: true }).join("\n");
    expect(report).not.toContain("nothing is written to User.actAccountMgr");
    expect(report).not.toContain("by design");
    expect(accountMgrWrites(plan, { includeInactive: true })).toHaveLength(1);
  });
});

/**
 * The Act! users and the `Rep` picklist as they really are, so the rules above
 * are checked against the data they were written for rather than only against
 * invented rows.
 *
 * Users: RAW/ACT/meta/users.json, read 2026-10-02 (note: that file carries a
 * UTF-8 BOM). Picklist: the 11 items read off the production box 2026-10-12.
 * Act! ids are abbreviated except where a test is about a specific user.
 */
describe("the real Act! users against the real Rep picklist", () => {
  const REP_PICKLIST = [
    "Achim Degel",
    "Alan Seymour",
    "Brandon Clark",
    "Chris Gilmartin",
    "David Cook",
    "John Hollo",
    "John Kyprianou",
    "Monte Kimball",
    "Mr Sistemas",
    "Roy Shurling",
    "Wayne Walker",
  ].map((value) => repItem(value));

  const real = (displayName: string, email: string | null, status: string): ActUserRow => ({
    id: `act-${displayName.toLowerCase().replace(/\W+/g, "-")}`,
    displayName,
    email,
    status,
    role: "Standard",
  });

  const ACT_USERS: ActUserRow[] = [
    real("Alan Seymour", "AlanS@pathfindercut.com", "Active"),
    real("Brandon Clark", "brandon.clark@pathfindercut.com", "Active"),
    real("Chris Gilmartin", "chris@pathfindercut.com", "Active"),
    real("Dan Castaneda", "dan.castaneda@pathfindercut.com", "Inactive"),
    real("Dan Hall", "dan.hall@pathfindercut.com", "Inactive"),
    real("David Cook", "davidc@pathfinderaus.com", "Inactive"),
    { ...real("Eadaoin Wright", "marketing@pathfindercut.com", "Inactive"), id: "92fed6e6-6468-4251-89d8-4937b0c70182" },
    real("Joe Bockrath", "joe.bockrath@pathfindercut.com", "Inactive"),
    real("John Hollo", "john@pathfindercut.com", "Active"),
    real("John Kyprianou", "johnk@pathfindercut.com", "Active"),
    real("Kevin du Plessis", "kduplessis@iplastics.com.au", "Inactive"),
    { ...real("Marketing", null, "Active"), id: "d90f208e-e1fd-4835-8811-541b0c4b81b9", role: "Browse" },
    real("Martin Thornton", "martin.thornton@pathfindercut.com", "Inactive"),
    real("Mike Collins", "mikecollins@pathfindercut.com", "Inactive"),
    real("Monte Kimball", "monte@pathfindercut.com", "Active"),
    real("Rick Weaver", null, "Inactive"),
    real("Ross Kaigg", null, "Inactive"),
    real("Roy Shurling", "roys@pathfindercut.com", "Active"),
    real("Wayne Walker", "wayne@pathfindercut.com", "Active"),
    real("Xavier Martel", "xavierm@pathfinderaus.com", "Inactive"),
  ];

  /** One PathQuote user per Act! user, on the same email, so every Act! user
   *  that can be reached is reached and the picklist rule is what decides. */
  const pqForEveryActUserWithEmail = ACT_USERS.filter((user) => user.email !== null).map(
    (user, index) => pqUser(`u${index}`, user.email!.toLowerCase()),
  );

  it("marketing@pathfindercut.com is Eadaoin Wright, an inactive person -- NOT the Marketing service account", () => {
    // The live foot-gun for an email-based join. The `Marketing` service
    // account is what every Act! record PathQuote creates is owned by today,
    // and it has no email at all; the address that looks like its own belongs
    // to a different, disabled person. So a PathQuote user carrying
    // marketing@pathfindercut.com maps to Eadaoin Wright -- held back for being
    // inactive -- and never to the integration account.
    const plan = planUserMap(
      ACT_USERS,
      [pqUser("u1", "marketing@pathfindercut.com")],
      REP_PICKLIST,
    );

    expect(plan.matched).toEqual([]);
    expect(plan.inactiveMatched).toHaveLength(1);
    expect(plan.inactiveMatched[0].actUser.displayName).toBe("Eadaoin Wright");
    expect(plan.inactiveMatched[0].actUser.id).toBe("92fed6e6-6468-4251-89d8-4937b0c70182");
    expect(outcomeOf(plan, "marketing@pathfindercut.com")).toBe("inactive-match");

    // The service account is reached by nothing, for the right reason.
    const marketing = plan.unusedActUsers.find(
      (entry) => entry.actUser.id === "d90f208e-e1fd-4835-8811-541b0c4b81b9",
    );
    expect(marketing).toMatchObject({ reason: "no-email" });

    // And even forcing the inactive write in does not give that person an
    // Account Mgr value: `Eadaoin Wright` is not in the picklist.
    expect(entriesToWrite(plan, { includeInactive: true })).toHaveLength(1);
    expect(accountMgrWrites(plan, { includeInactive: true })).toEqual([]);
  });

  it("resolves an Account Mgr value for the eight active real users and no one else", () => {
    const plan = planUserMap(ACT_USERS, pqForEveryActUserWithEmail, REP_PICKLIST);
    const written = accountMgrWrites(plan, { includeInactive: false }).map((write) => write.value);
    expect(written.sort()).toEqual([
      "Alan Seymour",
      "Brandon Clark",
      "Chris Gilmartin",
      "John Hollo",
      "John Kyprianou",
      "Monte Kimball",
      "Roy Shurling",
      "Wayne Walker",
    ]);
  });

  it("adds David Cook only when --include-inactive is given, because his user is Inactive", () => {
    const plan = planUserMap(ACT_USERS, pqForEveryActUserWithEmail, REP_PICKLIST);
    const forced = accountMgrWrites(plan, { includeInactive: true }).map((write) => write.value);
    expect(forced).toContain("David Cook");
    expect(forced).toHaveLength(9);
  });

  it("reports Kevin du Plessis as having no picklist item at all, not as a near-match", () => {
    // Worth pinning because it is easy to misremember. The case clash
    // `Kevin du Plessis` / `Kevin Du Plessis` is between the Act! user and the
    // hand-typed Account Mgr values on 77 contacts -- it is NOT in this
    // picklist, which contains no spelling of his name. So with this picklist
    // the near-match report is empty, and the strict-write rule is justified by
    // what it prevents rather than by anything it catches today.
    const plan = planUserMap(ACT_USERS, pqForEveryActUserWithEmail, REP_PICKLIST);
    expect(plan.accountMgrGaps.filter((gap) => gap.match.kind === "near")).toEqual([]);

    const kevin = plan.accountMgrGaps.find(
      (gap) => gap.actUser.displayName === "Kevin du Plessis",
    );
    expect(kevin?.match.kind).toBe("none");
  });

  it("names Achim Degel and Mr Sistemas as items belonging to no Act! user", () => {
    const plan = planUserMap(ACT_USERS, pqForEveryActUserWithEmail, REP_PICKLIST);
    expect(plan.unusedRepItems.map((item) => item.value)).toEqual(["Achim Degel", "Mr Sistemas"]);
  });

  it("every Act! user reached but absent from the picklist is reported, which is the list to add", () => {
    const plan = planUserMap(ACT_USERS, pqForEveryActUserWithEmail, REP_PICKLIST);
    const toAdd = plan.accountMgrGaps.map((gap) => gap.actUser.displayName).sort();
    // The 9 picklist items that are users account for 9 of the 17 Act! users
    // with an email; the other 8 are reached by a PathQuote row and have no
    // item. `Marketing`, `Rick Weaver` and `Ross Kaigg` have no email, so they
    // are not reached at all and are not on this list.
    expect(toAdd).toEqual([
      "Dan Castaneda",
      "Dan Hall",
      "Eadaoin Wright",
      "Joe Bockrath",
      "Kevin du Plessis",
      "Martin Thornton",
      "Mike Collins",
      "Xavier Martel",
    ]);
  });

  it("the picklist cannot change which Act! user a person maps to", () => {
    // Account Mgr is decided on a second key, after the email join. Removing
    // the picklist entirely must change nothing about actUserId.
    const withList = planUserMap(ACT_USERS, pqForEveryActUserWithEmail, REP_PICKLIST);
    const without = planUserMap(ACT_USERS, pqForEveryActUserWithEmail, []);
    const ids = (plan: UserMapPlan) =>
      entriesToWrite(plan, { includeInactive: true }).map((entry) => entry.actUser.id);
    expect(ids(withList)).toEqual(ids(without));
    expect(without.accountMgrGaps).toHaveLength(withList.accountMgrGaps.length + 9);
  });
});
