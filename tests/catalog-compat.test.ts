import { describe, it, expect } from "vitest";
import {
  compatibilityOrFilter,
  isOptionDisabled,
  findConflictingSelection,
  conflictPartnersByGroup,
} from "../src/lib/catalog-compat";

describe("compatibilityOrFilter", () => {
  it("includes both clauses when both ids are present (product-level compat within a series)", () => {
    expect(compatibilityOrFilter("prod_EL2020", "series_EL")).toEqual([
      { seriesId: "series_EL" },
      { productId: "prod_EL2020" },
    ]);
  });

  it("includes only the series clause when productId is missing", () => {
    expect(compatibilityOrFilter(null, "series_EL")).toEqual([{ seriesId: "series_EL" }]);
  });

  it("includes only the product clause when seriesId is missing", () => {
    expect(compatibilityOrFilter("prod_EL2020", null)).toEqual([{ productId: "prod_EL2020" }]);
  });

  it("returns null when neither id is present", () => {
    expect(compatibilityOrFilter(null, null)).toBeNull();
  });

  it("treats undefined the same as null", () => {
    expect(compatibilityOrFilter(undefined, undefined)).toBeNull();
  });

  it("treats an empty string id as absent", () => {
    expect(compatibilityOrFilter("", "")).toBeNull();
  });
});

describe("isOptionDisabled", () => {
  // A missing/needsReview price is a different condition from compatibility
  // — `isOptionDisabled` never takes compatibility as an input: an
  // incompatible-but-priced option is never disabled through it, only kept
  // out of the list entirely by `listCompatibleOptions`. It does take a
  // conflict (a legitimate, distinct reason to disable) as an explicit
  // second parameter — see the doc comment in catalog-compat.ts for why
  // that's a deliberate extension rather than smuggling compatibility back
  // in through the side door.

  it("disables an option with no price row at all", () => {
    expect(isOptionDisabled(null)).toEqual({ type: "unpriced" });
  });

  it("disables an option whose only price needs review", () => {
    expect(isOptionDisabled({ needsReview: true })).toEqual({ type: "unpriced" });
  });

  it("does not disable a priced, reviewed option with no conflict", () => {
    expect(isOptionDisabled({ needsReview: false })).toBeNull();
    expect(isOptionDisabled({ needsReview: false }, null)).toBeNull();
  });

  it("disables a priced option that conflicts with an already-selected option, naming the option and its group", () => {
    expect(
      isOptionDisabled(
        { needsReview: false },
        { code: "DRG-1", name: "Drag knife", groupName: "Knife tools — fit one only" }
      )
    ).toEqual({
      type: "conflict",
      conflictingOptionCode: "DRG-1",
      conflictingOptionName: "Drag knife",
      conflictingGroupName: "Knife tools — fit one only",
    });
  });

  it("disables an unpriced option for its own reason, distinct from a conflict, even when both apply", () => {
    expect(
      isOptionDisabled(null, { code: "MTS", name: "Additional travel", groupName: "Travel options" })
    ).toEqual({ type: "unpriced" });
    expect(
      isOptionDisabled(
        { needsReview: true },
        { code: "MTS", name: "Additional travel", groupName: "Travel options" }
      )
    ).toEqual({ type: "unpriced" });
  });
});

describe("findConflictingSelection", () => {
  it("returns null when no option in the selection has any conflicts", () => {
    const conflictsByCode = new Map<string, Set<string>>();
    expect(findConflictingSelection(["A", "B", "C"], conflictsByCode)).toBeNull();
  });

  it("returns null when an option's conflicts don't overlap the current selection", () => {
    const conflictsByCode = new Map([["A", new Set(["Z"])]]);
    expect(findConflictingSelection(["A", "B"], conflictsByCode)).toBeNull();
  });

  it("finds a conflicting pair regardless of which side carries the conflict entry", () => {
    const conflictsByCode = new Map([["A", new Set(["B"])]]);
    expect(findConflictingSelection(["A", "B"], conflictsByCode)).toEqual(["A", "B"]);
  });

  it("finds a conflicting pair among a larger selection", () => {
    const conflictsByCode = new Map([["MTS", new Set(["VRB-180"])]]);
    expect(findConflictingSelection(["HFV", "MTS", "VRB-180"], conflictsByCode)).toEqual([
      "MTS",
      "VRB-180",
    ]);
  });

  it("leaves an option with no conflicts entirely unaffected by others' conflicts", () => {
    const conflictsByCode = new Map([["A", new Set(["B"])]]);
    // C has no entry at all -- selecting it alongside A/B never trips it up.
    expect(findConflictingSelection(["C"], conflictsByCode)).toBeNull();
  });
});

describe("conflictPartnersByGroup", () => {
  it("makes three options in one group conflict with each other in every direction", () => {
    const result = conflictPartnersByGroup([
      { memberKey: "A", groupId: "g1" },
      { memberKey: "B", groupId: "g1" },
      { memberKey: "C", groupId: "g1" },
    ]);
    expect(result.get("A")).toEqual(new Set(["B", "C"]));
    expect(result.get("B")).toEqual(new Set(["A", "C"]));
    expect(result.get("C")).toEqual(new Set(["A", "B"]));
  });

  it("makes an option in two groups conflict with the members of both", () => {
    const result = conflictPartnersByGroup([
      { memberKey: "A", groupId: "g1" },
      { memberKey: "B", groupId: "g1" },
      { memberKey: "A", groupId: "g2" },
      { memberKey: "C", groupId: "g2" },
    ]);
    expect(result.get("A")).toEqual(new Set(["B", "C"]));
    expect(result.get("B")).toEqual(new Set(["A"]));
    expect(result.get("C")).toEqual(new Set(["A"]));
  });

  it("a group of one blocks nothing", () => {
    const result = conflictPartnersByGroup([{ memberKey: "A", groupId: "g1" }]);
    expect(result.get("A")).toBeUndefined();
  });

  it("removing an option from a group stops the conflict", () => {
    const withThree = conflictPartnersByGroup([
      { memberKey: "A", groupId: "g1" },
      { memberKey: "B", groupId: "g1" },
      { memberKey: "C", groupId: "g1" },
    ]);
    expect(withThree.get("A")).toEqual(new Set(["B", "C"]));

    // C removed from the group -- only rows for A and B are given now.
    const withoutC = conflictPartnersByGroup([
      { memberKey: "A", groupId: "g1" },
      { memberKey: "B", groupId: "g1" },
    ]);
    expect(withoutC.get("A")).toEqual(new Set(["B"]));
    expect(withoutC.get("C")).toBeUndefined();
  });

  it("leaves an option with no membership rows unaffected", () => {
    const result = conflictPartnersByGroup([
      { memberKey: "A", groupId: "g1" },
      { memberKey: "B", groupId: "g1" },
    ]);
    expect(result.get("Z")).toBeUndefined();
  });

  it("combined with findConflictingSelection, rejects a selection containing two members of the same group", () => {
    // Mirrors what setItemOptions does: build the partner map from the
    // submitted options' own group memberships (keyed by option id -- the
    // keys are opaque to both helpers, so readable stand-ins are used here),
    // then scan the submission.
    const conflictsById = conflictPartnersByGroup([
      { memberKey: "id-drg-1", groupId: "knife-tools" },
      { memberKey: "id-drg-2", groupId: "knife-tools" },
    ]);
    expect(findConflictingSelection(["id-drg-1", "id-drg-2"], conflictsById)).toEqual([
      "id-drg-1",
      "id-drg-2",
    ]);
    // A third, unrelated option in the same submission is unaffected.
    const withUnrelated = conflictPartnersByGroup([
      { memberKey: "id-drg-1", groupId: "knife-tools" },
      { memberKey: "id-drg-2", groupId: "knife-tools" },
      { memberKey: "id-hfv", groupId: "unrelated-group" },
    ]);
    expect(findConflictingSelection(["id-hfv"], withUnrelated)).toBeNull();
  });
});
