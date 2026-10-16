import { describe, expect, it } from "vitest";
import { autosaveKeyFor } from "@/lib/option-selections";
import type { OptionSelectionInput } from "@/lib/validation/documents";

/**
 * PERF-17 (docs/technical-audit/FINDINGS.md): the options panel's autosave
 * used to be keyed on the full payload, which includes the rows the server
 * derives (MTS travel, transformer, EasyLoader modules). Those rows come
 * back changed after every save, so the key changed and an identical second
 * save went out. The key must depend on the manager's own rows only.
 */
describe("autosaveKeyFor", () => {
  const locked = new Set(["mts-travel", "transformer"]);
  const isLocked = (id: string) => locked.has(id);

  const picks: OptionSelectionInput[] = [
    { optionId: "mts", qty: 1, attributes: { metres: 15 } },
    { optionId: "roll-holder", qty: 2 },
  ];

  it("ignores a derived row the server added after the save", () => {
    const before = autosaveKeyFor(picks, isLocked);
    const after = autosaveKeyFor([...picks, { optionId: "mts-travel", qty: 5 }], isLocked);
    expect(after).toBe(before);
  });

  it("ignores a derived row whose quantity the server changed", () => {
    const a = autosaveKeyFor([...picks, { optionId: "mts-travel", qty: 5 }], isLocked);
    const b = autosaveKeyFor([...picks, { optionId: "transformer", qty: 1 }, { optionId: "mts-travel", qty: 9 }], isLocked);
    expect(a).toBe(b);
  });

  it("changes when the manager ticks, unticks or re-quantifies an option", () => {
    const base = autosaveKeyFor(picks, isLocked);
    expect(autosaveKeyFor([...picks, { optionId: "crate", qty: 1 }], isLocked)).not.toBe(base);
    expect(autosaveKeyFor(picks.slice(0, 1), isLocked)).not.toBe(base);
    expect(autosaveKeyFor([picks[0], { optionId: "roll-holder", qty: 3 }], isLocked)).not.toBe(base);
  });

  it("changes when the manager edits an attribute the server derives from", () => {
    // The MTS length is the manager's input; the travel line is its
    // consequence. Changing the length must save, even though only the
    // consequence's row will differ in what comes back.
    const base = autosaveKeyFor(picks, isLocked);
    const longer = autosaveKeyFor([{ optionId: "mts", qty: 1, attributes: { metres: 20 } }, picks[1]], isLocked);
    expect(longer).not.toBe(base);
  });

  it("is a plain serialisation when nothing is locked", () => {
    expect(autosaveKeyFor(picks, () => false)).toBe(JSON.stringify(picks));
  });
});
