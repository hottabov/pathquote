import { describe, it, expect } from "vitest";
import {
  LIST_PAGE_STEP,
  defaultActiveOption,
  isListNavKey,
  moveActiveOption,
  revealScrollTop,
} from "../src/lib/combobox-nav";

describe("isListNavKey", () => {
  it("accepts the keys that move the active option", () => {
    for (const key of ["ArrowDown", "ArrowUp", "PageDown", "PageUp"]) {
      expect(isListNavKey(key)).toBe(true);
    }
  });

  it("leaves Home and End to the text box, where they move the caret", () => {
    expect(isListNavKey("Home")).toBe(false);
    expect(isListNavKey("End")).toBe(false);
  });

  it("ignores everything else, including Enter and Escape, which the component handles itself", () => {
    for (const key of ["Enter", "Escape", "Tab", "a", " ", "ArrowLeft", "ArrowRight"]) {
      expect(isListNavKey(key)).toBe(false);
    }
  });
});

describe("moveActiveOption", () => {
  it("has no active option in an empty list, whatever is pressed", () => {
    expect(moveActiveOption(-1, 0, "ArrowDown")).toBe(-1);
    expect(moveActiveOption(3, 0, "ArrowUp")).toBe(-1);
    expect(moveActiveOption(0, -2, "PageDown")).toBe(-1);
  });

  it("goes to the first option on ArrowDown from the text box", () => {
    expect(moveActiveOption(-1, 5, "ArrowDown")).toBe(0);
  });

  it("goes to the last option on ArrowUp from the text box", () => {
    expect(moveActiveOption(-1, 5, "ArrowUp")).toBe(4);
  });

  it("steps one at a time", () => {
    expect(moveActiveOption(1, 5, "ArrowDown")).toBe(2);
    expect(moveActiveOption(3, 5, "ArrowUp")).toBe(2);
  });

  it("stops at the ends instead of wrapping", () => {
    expect(moveActiveOption(4, 5, "ArrowDown")).toBe(4);
    expect(moveActiveOption(0, 5, "ArrowUp")).toBe(0);
  });

  it("pages by LIST_PAGE_STEP and stops at the ends", () => {
    expect(moveActiveOption(0, 100, "PageDown")).toBe(LIST_PAGE_STEP);
    expect(moveActiveOption(50, 100, "PageUp")).toBe(50 - LIST_PAGE_STEP);
    expect(moveActiveOption(98, 100, "PageDown")).toBe(99);
    expect(moveActiveOption(2, 100, "PageUp")).toBe(0);
  });

  it("counts a page from the text box, and PageUp from it lands on the first option", () => {
    expect(moveActiveOption(-1, 100, "PageDown")).toBe(LIST_PAGE_STEP - 1);
    expect(moveActiveOption(-1, 100, "PageUp")).toBe(0);
    expect(moveActiveOption(-1, 3, "PageDown")).toBe(2);
  });

  it("treats an index left over from a longer list as none", () => {
    expect(moveActiveOption(40, 5, "ArrowDown")).toBe(0);
    expect(moveActiveOption(40, 5, "ArrowUp")).toBe(4);
  });

  it("walks the whole list and back with the arrow keys", () => {
    let active = -1;
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      active = moveActiveOption(active, 3, "ArrowDown");
      seen.push(active);
    }
    expect(seen).toEqual([0, 1, 2, 2]);
    for (let i = 0; i < 4; i++) {
      active = moveActiveOption(active, 3, "ArrowUp");
      seen.push(active);
    }
    expect(seen.slice(4)).toEqual([1, 0, 0, 0]);
  });
});

describe("defaultActiveOption", () => {
  it("highlights the first match once something has been searched for", () => {
    expect(defaultActiveOption("boats", 12)).toBe(0);
  });

  it("highlights nothing on the unsearched list, so Enter cannot pick by accident", () => {
    expect(defaultActiveOption("", 100)).toBe(-1);
  });

  it("highlights nothing when there is nothing to highlight", () => {
    expect(defaultActiveOption("boats", 0)).toBe(-1);
    expect(defaultActiveOption("", 0)).toBe(-1);
  });
});

describe("revealScrollTop", () => {
  // A 200px-tall view over rows 50px tall: rows at 0, 50, 100, ...
  const view = 200;
  const row = 50;

  it("leaves the scroll alone when the option is already fully in view", () => {
    expect(revealScrollTop(100, row, 0, view)).toBe(0);
    expect(revealScrollTop(150, row, 0, view)).toBe(0);
    expect(revealScrollTop(300, row, 250, view)).toBe(250);
  });

  it("scrolls up just far enough to put an option above the view at the top", () => {
    expect(revealScrollTop(100, row, 175, view)).toBe(100);
  });

  it("scrolls down just far enough to put an option below the view at the bottom", () => {
    expect(revealScrollTop(200, row, 0, view)).toBe(50);
    expect(revealScrollTop(1000, row, 0, view)).toBe(850);
  });

  it("brings a partly hidden option fully into view", () => {
    // The row at 175 is cut off at the bottom of a view scrolled to 0.
    expect(revealScrollTop(175, row, 0, view)).toBe(25);
    // The row at 25 is cut off at the top of a view scrolled to 40.
    expect(revealScrollTop(25, row, 40, view)).toBe(25);
  });

  it("aligns an option taller than the view by its top, so its start shows", () => {
    expect(revealScrollTop(300, 400, 0, view)).toBe(300);
  });
});
