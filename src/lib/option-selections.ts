/**
 * How an item's saved OPTION lines become the selection an options panel
 * shows, and what happens to the lines that panel does not own.
 *
 * Pure, and deliberately outside the component: the rule it carries -- a
 * derived line is read from the server, never from the panel's own state --
 * is the one a quote's price depends on, so it is unit-tested rather than
 * only exercised by eye.
 */

import type { OptionRole } from "@prisma/client";

/** One option as the panel holds it while open. */
export type SelectionState = { qty: number; attributes: Record<string, string> };

/** An OPTION line of the item, as `ItemOptionsEditor` receives it. */
export type SelectionLine = {
  /** The option's id (`DocumentLine.refId`) -- what the selection is keyed
   * by and what goes back to `setItemOptions`. */
  refId: string | null;
  qty: number;
  attributes: Record<string, string | number> | null;
  /** `Option.role`, resolved live (see `BuilderLine.role`). */
  role: OptionRole | null;
};

/** Attribute values are typed into text inputs, so they are held as strings
 * whatever the catalogue schema calls them. */
export function selectionFromLine(line: SelectionLine): SelectionState {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(line.attributes ?? {})) {
    attributes[key] = String(value);
  }
  return { qty: line.qty, attributes };
}

/** Selection keyed by option id. A line with no `refId` has no catalogue
 * row to resubmit, so it is left out -- `save` could not send it anyway. */
export function selectionsFromLines(lines: SelectionLine[]): Map<string, SelectionState> {
  const map = new Map<string, SelectionState>();
  for (const line of lines) {
    if (!line.refId) continue;
    map.set(line.refId, selectionFromLine(line));
  }
  return map;
}

/**
 * The selection an options panel actually shows and saves: the manager's own
 * picks from its state, plus every derived row read fresh from the item's
 * current lines.
 *
 * A derived row belongs to a builder somewhere else on the card -- the
 * EasyLoader's table modules to the layout above it, the per-metre MTS rail
 * to the length typed against the MTS -- and those can change while the panel
 * sits open. Switching a section to static takes a drive module off the item
 * and puts a static length on it, and the panel's own state, which is only
 * re-read from the server when the panel opens, went on showing the table as
 * it was at that moment: the new static row unticked and pickable, the old
 * drive quantity still on screen. Worse than the wrong display, a "Save
 * options" from that state wrote the stale set back over the lines the layout
 * had just derived, so the quote charged for one table while the builder drew
 * another.
 *
 * So the derived rows are not held in state at all. They are recomputed from
 * props on every render, which is what keeps the two halves of the card
 * describing one machine. (`setItemOptions` now re-derives them server-side
 * too -- see `withDerivedEasyLoaderModules` -- so a stale caller cannot write
 * them back either.)
 */
export function withDerivedSelections(
  selected: Map<string, SelectionState>,
  lines: SelectionLine[],
  isLocked: (id: string) => boolean
): Map<string, SelectionState> {
  const merged = new Map<string, SelectionState>();
  for (const [id, state] of selected) if (!isLocked(id)) merged.set(id, state);
  for (const line of lines) {
    if (!line.refId || !isLocked(line.refId)) continue;
    merged.set(line.refId, selectionFromLine(line));
  }
  return merged;
}
