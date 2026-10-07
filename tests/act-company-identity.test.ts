import { describe, it, expect } from "vitest";
import {
  chooseCompany,
  type CompanyDecision,
  type CompanyIdentity,
  type IncomingIdentity,
} from "../src/lib/act/company-identity";

const row = (
  id: string,
  actCompanyId: string | null,
  actCompanyKey: string | null,
): CompanyIdentity => ({ id, actCompanyId, actCompanyKey });

const incoming = (
  actCompanyId: string | null,
  actCompanyKey: string | null,
): IncomingIdentity => ({ actCompanyId, actCompanyKey });

describe("chooseCompany", () => {
  describe("an ACT! company id match", () => {
    it("uses the row the id matches", () => {
      expect(chooseCompany(incoming("A1", "acme|AU"), row("c1", "A1", "acme|AU"), null)).toEqual({
        kind: "use",
        id: "c1",
      });
    });

    it("uses it even when the incoming contact carries no key", () => {
      expect(chooseCompany(incoming("A1", null), row("c1", "A1", null), null)).toEqual({
        kind: "use",
        id: "c1",
      });
    });

    it("byId wins when byKey matches a different row", () => {
      // The id is the strongest identity there is. A different row happening
      // to hold the same derived key must not pull the contact away from it.
      expect(
        chooseCompany(incoming("A1", "acme|AU"), row("by-id", "A1", null), row("by-key", null, "acme|AU")),
      ).toEqual({ kind: "use", id: "by-id" });
    });
  });

  describe("nothing identifies the company", () => {
    it('skips a name that normalises to nothing (the "." name)', () => {
      expect(chooseCompany(incoming(null, null), null, null)).toEqual({ kind: "skip" });
    });

    it("treats empty strings as unset, not as identifiers", () => {
      expect(chooseCompany(incoming("", ""), null, null)).toEqual({ kind: "skip" });
    });
  });

  describe("a derived-key match", () => {
    it("adopts a free-text row when a real ACT! company turns up for it", () => {
      // The P2002 regression. An unlinked contact earlier created a company
      // holding "acme|AU". A contact linked to A1 with the same key arrives:
      // id misses, key hits. Creating here is what hit the unique index on
      // actCompanyKey and ended the run on every retry.
      expect(chooseCompany(incoming("A1", "acme|AU"), null, row("c1", null, "acme|AU"))).toEqual({
        kind: "adopt",
        id: "c1",
        actCompanyId: "A1",
      });
    });

    it("uses the row when neither side has an ACT! company id", () => {
      expect(chooseCompany(incoming(null, "acme|AU"), null, row("c1", null, "acme|AU"))).toEqual({
        kind: "use",
        id: "c1",
      });
    });

    it("lets an unlinked contact meet a linked row", () => {
      // The case the first draft of the table got wrong. The row is already
      // linked to A1; an unlinked contact's free text groups onto it, which
      // is the whole purpose of the derived key.
      expect(chooseCompany(incoming(null, "acme|AU"), null, row("c1", "A1", "acme|AU"))).toEqual({
        kind: "use",
        id: "c1",
      });
    });

    it("creates with a null key when two ACT! companies normalise to one key", () => {
      // The only genuine collision. The row holds the key and A1; a contact
      // linked to A2 arrives. The key cannot be shared, and A2 is identity
      // enough on its own.
      expect(
        chooseCompany(incoming("A2", "acme|AU"), null, row("c1", "A1", "acme|AU")),
      ).toEqual({ kind: "create", actCompanyId: "A2", actCompanyKey: null });
    });
  });

  describe("no match at all", () => {
    it("creates a derived company holding the key", () => {
      expect(chooseCompany(incoming(null, "acme|AU"), null, null)).toEqual({
        kind: "create",
        actCompanyId: null,
        actCompanyKey: "acme|AU",
      });
    });

    it("creates a linked company holding both identifiers", () => {
      expect(chooseCompany(incoming("A1", "acme|AU"), null, null)).toEqual({
        kind: "create",
        actCompanyId: "A1",
        actCompanyKey: "acme|AU",
      });
    });

    it("creates a linked company that has no usable name", () => {
      // A real ACT! company id is identity on its own, even with no key.
      expect(chooseCompany(incoming("A1", null), null, null)).toEqual({
        kind: "create",
        actCompanyId: "A1",
        actCompanyKey: null,
      });
    });
  });

  describe("invariant: a create is always reachable by a later lookup", () => {
    // If a create came back with both identifiers null, no future lookup could
    // find the row and every later contact with the same name would create
    // another one: one client silently fragmented across hundreds of rows.
    const ids = [null, "", "A1", "A2"];
    const keys = [null, "", "acme|AU"];
    const rows = (id: string): (CompanyIdentity | null)[] => [
      null,
      row(id, null, null),
      row(id, null, "acme|AU"),
      row(id, "A1", null),
      row(id, "A1", "acme|AU"),
      row(id, "A2", "acme|AU"),
    ];

    it("holds across every combination of incoming identity and lookup results", () => {
      const decisions: CompanyDecision[] = [];
      for (const actCompanyId of ids) {
        for (const actCompanyKey of keys) {
          for (const byId of rows("by-id")) {
            for (const byKey of rows("by-key")) {
              decisions.push(chooseCompany({ actCompanyId, actCompanyKey }, byId, byKey));
            }
          }
        }
      }

      const creates = decisions.filter((d) => d.kind === "create");
      // Guard against the loop quietly exercising nothing.
      expect(creates.length).toBeGreaterThan(0);
      for (const decision of creates) {
        if (decision.kind !== "create") continue;
        expect(decision.actCompanyId !== null || decision.actCompanyKey !== null).toBe(true);
      }
    });

    it("never hands a create an empty string as an identifier", () => {
      const decision = chooseCompany(incoming("", "acme|AU"), null, null);
      expect(decision).toEqual({ kind: "create", actCompanyId: null, actCompanyKey: "acme|AU" });
    });
  });
});
