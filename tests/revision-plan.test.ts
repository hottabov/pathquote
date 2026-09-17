/**
 * Why this exists: the revision counter must move on exactly one event — a
 * finalize that changed the quote's content — and never on an unfinalize/
 * finalize round-trip that changed nothing (spec §5). `planRevision` is that
 * rule; these tests pin the three cases (first-ever, no-op, real change) and
 * the -R<n> labelling that a client sees on their PDF.
 */
import { describe, it, expect } from "vitest";
import { planRevision, revisionLabel } from "@/lib/documents/revision-plan";

describe("revisionLabel", () => {
  it("uses the bare quote number for revision 0", () => {
    expect(revisionLabel("Q-AU-2026-001", 0)).toBe("Q-AU-2026-001");
  });

  it("suffixes -R<n> for later revisions", () => {
    expect(revisionLabel("Q-AU-2026-001", 1)).toBe("Q-AU-2026-001-R1");
    expect(revisionLabel("Q-AU-2026-001", 3)).toBe("Q-AU-2026-001-R3");
  });

  it("returns null when the quote has no number yet", () => {
    expect(revisionLabel(null, 0)).toBeNull();
  });
});

describe("planRevision", () => {
  it("creates revision 0 on the first finalize (no prior revision)", () => {
    expect(planRevision({ lastRevision: null, lastSnapshotHash: null, newSnapshotHash: "abc" })).toEqual({
      create: true,
      revision: 0,
    });
  });

  it("creates the next revision when the content changed", () => {
    expect(planRevision({ lastRevision: 0, lastSnapshotHash: "old", newSnapshotHash: "new" })).toEqual({
      create: true,
      revision: 1,
    });
    expect(planRevision({ lastRevision: 2, lastSnapshotHash: "old", newSnapshotHash: "new" })).toEqual({
      create: true,
      revision: 3,
    });
  });

  it("creates nothing and keeps the number when the hash is unchanged (no-op re-finalize)", () => {
    expect(planRevision({ lastRevision: 1, lastSnapshotHash: "same", newSnapshotHash: "same" })).toEqual({
      create: false,
      revision: 1,
    });
  });

  it("treats a present last revision with a null hash as a first finalize (defensive)", () => {
    // A revision row that predates snapshot hashing shouldn't wedge finalize;
    // fall back to creating rather than silently comparing against null.
    expect(planRevision({ lastRevision: 0, lastSnapshotHash: null, newSnapshotHash: "x" })).toEqual({
      create: true,
      revision: 0,
    });
  });
});
