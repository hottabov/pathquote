/**
 * The consumable a tool goes on a quote with -- the blade a drag knife
 * takes, the drill a punch takes (see OptionConsumable in schema.prisma).
 *
 * One rule, shared by the options editor and `setItemOptions` so the screen
 * and the server cannot disagree: a tool that lists consumables goes on the
 * quote with exactly one of them. The salesperson picks which; a tool with a
 * single consumable gets it without asking. Anything more is sold as an
 * extra line.
 */

/** A consumable as a tool lists it: the consumable option and how many
 * pieces of it come with one tool. */
export type ConsumableLink = { id: string; code: string; name: string; qty: number };

export type ConsumableChoice =
  | { ok: true; link: ConsumableLink | null }
  | { ok: false; reason: "required" | "unknown" };

/**
 * Which consumable a tool selection resolves to. `chosenId` is what the
 * salesperson picked, if anything.
 *
 * - no consumables listed: nothing, whatever was sent (a stale pick from
 *   before the tool's list was emptied must not block the save);
 * - one listed: that one -- there is nothing to choose;
 * - several: the one picked, and a missing or foreign pick is refused.
 */
export function consumableChoice(links: readonly ConsumableLink[], chosenId: string | undefined): ConsumableChoice {
  if (links.length === 0) return { ok: true, link: null };
  if (chosenId === undefined) {
    return links.length === 1 ? { ok: true, link: links[0] } : { ok: false, reason: "required" };
  }
  const link = links.find((candidate) => candidate.id === chosenId);
  return link ? { ok: true, link } : { ok: false, reason: "unknown" };
}

export function consumableRequiredMessage(toolCode: string): string {
  return `Choose a consumable for ${toolCode}`;
}

/** What a consumable line says under its tool, e.g. "Includes 2 × 30° Carbide Blade 380017". */
export function consumableIncludedLabel(qty: number, name: string): string {
  return `Includes ${qty} × ${name}`;
}
