// --- option/product compatibility ------------------------------------------

/**
 * The `OptionCompatibility` OR-filter for "is this option compatible with
 * this item": an `Option` counts as compatible when it has a compat row at
 * *either* the series level (`seriesId` matches the item's product's series)
 * *or* the product level (`productId` matches the item's product itself) —
 * see the `OptionCompatibility` model, which allows both kinds of row
 * side-by-side (e.g. EasyLoader accessories are product-level, compatible
 * only with EL-2020, while most options are series-level).
 *
 * Pure and DB-agnostic so it's unit-testable without a database: shared by
 * `listCompatibleOptions` (queries/documents.ts, building the options list
 * shown in the builder) and `setItemOptions` (actions/documents.ts,
 * re-validating a submitted selection server-side).
 *
 * Returns `null` when neither id is available — a caller should treat that
 * as "no compatible options" (an empty `OR: []` would need per-ORM handling
 * to mean "match nothing," so callers short-circuit on `null` instead of
 * relying on that).
 */
export function compatibilityOrFilter(
  productId: string | null | undefined,
  seriesId: string | null | undefined
): Array<{ seriesId: string } | { productId: string }> | null {
  const or: Array<{ seriesId: string } | { productId: string }> = [];
  if (seriesId) or.push({ seriesId });
  if (productId) or.push({ productId });
  return or.length > 0 ? or : null;
}

/**
 * Why an option in the item options editor is disabled, or `null` when it's
 * selectable. Two independent reasons, checked in this order:
 *
 * 1. `unpriced` — no usable price for the document's region (no `Price` row
 *    at all, or one flagged `needsReview`). The quote literally cannot be
 *    priced without one.
 * 2. `conflict` — a specific *other* option, already selected on this item,
 *    that shares an `OptionConflictGroup` with this one (e.g. a knife too
 *    long for the machine's cut height — see that model's comment in
 *    schema.prisma). Carries that option's code/name plus the shared
 *    group's name so the UI can name both ("Conflicts with DRG-1 — knife
 *    tools, fit one only"), not just say "disabled". The code here is
 *    display only -- the caller finds the partner by id.
 *
 * `unpriced` wins when both apply — an option with no price is disabled for
 * its own reason regardless of what else is selected.
 *
 * Originally took only `price` (a deliberate narrowing — an earlier change
 * wrongly let *compatibility* disable an option here, which this signature
 * was written to make impossible: `listCompatibleOptions` is the only thing
 * allowed to keep an incompatible option out of the list entirely). A
 * conflict is a different, legitimate kind of "can't have both", so it's
 * added as an explicit second parameter rather than smuggled in — the
 * caller decides what counts as "already selected" (see
 * `ItemOptionsEditor`, which deliberately never treats the option currently
 * being toggled as its own conflict source, so deselecting the option that
 * caused a conflict re-enables the others on the very next render, no
 * server round trip).
 */
export type OptionDisabledReason =
  | { type: "unpriced" }
  | {
      type: "conflict";
      conflictingOptionCode: string;
      conflictingOptionName: string;
      /** The shared `OptionConflictGroup.name` responsible for the block —
       * see `conflictPartnersByGroup` below for how a caller resolves
       * *which* group when a pair happens to share more than one. */
      conflictingGroupName: string;
    };

export function isOptionDisabled(
  price: { needsReview: boolean } | null,
  conflictingWith?: { code: string; name: string; groupName: string } | null
): OptionDisabledReason | null {
  if (price === null || price.needsReview) return { type: "unpriced" };
  if (conflictingWith) {
    return {
      type: "conflict",
      conflictingOptionCode: conflictingWith.code,
      conflictingOptionName: conflictingWith.name,
      conflictingGroupName: conflictingWith.groupName,
    };
  }
  return null;
}

/**
 * Finds the first pair of currently-selected option ids that conflict,
 * given each selected option's own set of ids it conflicts with. Pure and
 * DB-agnostic like `compatibilityOrFilter` above — shared by `setItemOptions`
 * (server-side rejection of a submitted selection) and unit-tested directly
 * so the pairwise-scan logic doesn't have to be exercised through a mocked
 * database. The builder UI doesn't use this: it only ever needs "does *this*
 * option conflict with something selected", a single lookup, not a full scan
 * — see `isOptionDisabled` above. Unchanged by the move from `OptionConflict`
 * to `OptionConflictGroup` — it only ever looks at the precomputed
 * `conflictsById` map, never at how that map was built (see
 * `conflictPartnersByGroup` below, which is what changed). The keys are
 * opaque strings to this function: it returns whichever pair it was given,
 * and the caller turns them into codes for the message it shows.
 */
export function findConflictingSelection(
  selectedIds: string[],
  conflictsById: Map<string, Set<string>>
): [string, string] | null {
  for (let i = 0; i < selectedIds.length; i++) {
    const a = selectedIds[i];
    const aConflicts = conflictsById.get(a);
    if (!aConflicts || aConflicts.size === 0) continue;
    for (let j = i + 1; j < selectedIds.length; j++) {
      const b = selectedIds[j];
      if (aConflicts.has(b)) return [a, b];
    }
  }
  return null;
}

/**
 * Given every (memberKey, groupId) `OptionConflictGroupMember` row relevant
 * to a set of options, returns each option's set of "conflict partner" keys
 * -- every other option that shares at least one group with it (see the
 * `OptionConflictGroup` model comment in schema.prisma: two options
 * conflict when they share a group, so a plain pairwise conflict is just
 * the two-member case). Pure and DB-agnostic like `compatibilityOrFilter`/
 * `findConflictingSelection` above. `memberKey` is the option's *id*
 * everywhere -- the catalogue/builder reads (`listCompatibleOptions`) and
 * `setItemOptions`, whose result feeds `findConflictingSelection` directly.
 * The function itself treats it as an opaque string.
 *
 * Only the *given* rows matter: if `memberships` covers a subset of a
 * group's real membership (e.g. `setItemOptions` only fetches the
 * *submitted* options' own group rows, never the rest of that group's
 * members), the result reflects conflicts among just that subset, not the
 * group's full membership -- correct for `setItemOptions`, which only cares
 * whether two *submitted* options share a group, not who else is in it.
 *
 * An option with no membership row at all, or whose every group has no
 * other member among the given rows, has no entry (or an empty set) in the
 * result -- both mean "conflicts with nothing", the same contract
 * `findConflictingSelection` already expects from a missing map entry.
 */
export function conflictPartnersByGroup(
  memberships: { memberKey: string; groupId: string }[]
): Map<string, Set<string>> {
  const membersByGroup = new Map<string, string[]>();
  for (const { memberKey, groupId } of memberships) {
    const list = membersByGroup.get(groupId);
    if (list) list.push(memberKey);
    else membersByGroup.set(groupId, [memberKey]);
  }

  const result = new Map<string, Set<string>>();
  for (const members of membersByGroup.values()) {
    for (const key of members) {
      let set = result.get(key);
      for (const other of members) {
        if (other === key) continue;
        if (!set) {
          set = new Set<string>();
          result.set(key, set);
        }
        set.add(other);
      }
    }
  }
  return result;
}
