// The pure half of a combobox's keyboard handling: which option the arrow keys
// land on, which one is active when a list arrives, and how far to scroll the
// list so the active option is in view. No DOM here, so each rule has a unit
// test; the component that applies them is
// src/components/builder/client-combobox.tsx.
//
// An active option is an index into the rendered options, or -1 for "none":
// focus is in the text box and no row is highlighted. The ARIA pattern keeps
// DOM focus on the input and points `aria-activedescendant` at the active
// option, so "active" is all the state the keyboard needs.

/** The keys that move the active option. Home and End are left out on
 * purpose: in a text box they move the caret, and a person editing a search
 * must keep that. */
export type ListNavKey = "ArrowDown" | "ArrowUp" | "PageDown" | "PageUp";

export function isListNavKey(key: string): key is ListNavKey {
  return key === "ArrowDown" || key === "ArrowUp" || key === "PageDown" || key === "PageUp";
}

/** Options a PageUp/PageDown press moves by. About one screenful of a list
 * capped at a few rows high; a hundred results are otherwise a hundred
 * keypresses. */
export const LIST_PAGE_STEP = 6;

/**
 * The active option after `key`, given the current one and how many options
 * there are.
 *
 * - With nothing active, ArrowDown goes to the first option and ArrowUp to the
 *   last (the ARIA authoring practice). PageDown counts from the box, so it
 *   lands one page down; PageUp goes to the first option.
 * - The ends clamp rather than wrap. In a list of a hundred, ArrowUp on the
 *   first row jumping to the hundredth is a way to pick the wrong company by
 *   accident.
 * - An empty list has no active option.
 */
export function moveActiveOption(active: number, count: number, key: ListNavKey): number {
  if (count <= 0) return -1;
  const last = count - 1;
  // A stale index (the list shrank under it) is treated as "none".
  const from = active >= 0 && active <= last ? active : -1;

  switch (key) {
    case "ArrowDown":
      return from === -1 ? 0 : Math.min(from + 1, last);
    case "ArrowUp":
      return from === -1 ? last : Math.max(from - 1, 0);
    case "PageDown":
      return Math.min(from + LIST_PAGE_STEP, last);
    case "PageUp":
      return from === -1 ? 0 : Math.max(from - LIST_PAGE_STEP, 0);
  }
}

/**
 * The option that is active when a fresh list arrives. When the person has
 * typed a term the first match is highlighted, so "type, Enter" picks the best
 * match; with no term (the newest-companies list on focus) nothing is, so
 * Enter on a list nobody has searched or navigated cannot choose a company by
 * accident.
 */
export function defaultActiveOption(term: string, count: number): number {
  return term !== "" && count > 0 ? 0 : -1;
}

/**
 * The scrollTop that brings an option fully into view with the least movement:
 * unchanged if it already is, otherwise just far enough to put it at the top or
 * the bottom edge. `optionTop` is measured from the top of the scrollable
 * content, like `offsetTop` inside a positioned list.
 *
 * Done on the list itself rather than with `scrollIntoView`, which would also
 * scroll the page under a person who is moving through the list on a phone.
 */
export function revealScrollTop(
  optionTop: number,
  optionHeight: number,
  scrollTop: number,
  viewHeight: number
): number {
  if (optionTop < scrollTop) return optionTop;
  const bottom = optionTop + optionHeight;
  if (bottom > scrollTop + viewHeight) {
    // An option taller than the view is aligned by its top, so its start shows.
    return Math.min(optionTop, bottom - viewHeight);
  }
  return scrollTop;
}
