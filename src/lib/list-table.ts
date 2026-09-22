/**
 * The pure half of the interactive list tables (/quotes, /clients): how a
 * row is matched against a search box and how two rows compare on a sorted
 * column.
 *
 * Kept out of the component (src/components/ui-kit/list-table.tsx) so it is
 * plain data-in/data-out and testable the way the rest of this codebase's
 * logic is — `tests/list-table.test.ts` covers it directly, with no DOM and
 * no React. The component owns only the state and the markup.
 */

export type SortDirection = "asc" | "desc";

export type SortState<K extends string> = { key: K; direction: SortDirection };

/** What one row contributes to one sortable column. Numbers sort
 * numerically (totals, counts, timestamps); strings sort by locale with
 * `numeric` on, so "Q-9" precedes "Q-10" rather than following it. */
export type SortValue = string | number;

/** A row with its search haystack and sort values already derived — see
 * `prepareRows`. */
export type PreparedRow<T, K extends string> = {
  row: T;
  haystack: string;
  values: Record<K, SortValue>;
};

/**
 * Normalizes both sides of a search comparison the same way, so case and
 * stray whitespace never decide a match.
 */
export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Splits what the user typed into the terms a row must contain. ALL terms
 * have to match somewhere in the row, which is what makes "acme draft"
 * narrow to Acme's drafts rather than widening to every row containing
 * either word.
 */
export function searchTerms(query: string): string[] {
  return normalizeSearchText(query).split(" ").filter(Boolean);
}

export function compareSortValues(a: SortValue, b: SortValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "en-AU", { numeric: true, sensitivity: "base" });
}

/**
 * Derives each row's search haystack and sort values once, up front.
 *
 * Worth its own step because the search box re-filters on every keystroke:
 * doing this inside the filter would redo the same string building for
 * every row on every character typed.
 */
export function prepareRows<T, K extends string>(
  rows: readonly T[],
  sortValues: (row: T) => Record<K, SortValue>,
  searchText: (row: T) => string
): PreparedRow<T, K>[] {
  return rows.map((row) => ({
    row,
    haystack: normalizeSearchText(searchText(row)),
    values: sortValues(row),
  }));
}

/**
 * The visible rows: everything matching `query`, ordered by `sort`.
 *
 * The sort is stable — rows that tie on the sorted column keep the order
 * they arrived in (i.e. the server query's own order) rather than shuffling
 * between renders — which `Array.prototype.sort` does not guarantee across
 * engines on its own, hence the explicit index tiebreak.
 */
export function filterAndSortRows<T, K extends string>(
  prepared: readonly PreparedRow<T, K>[],
  query: string,
  sort: SortState<K>
): T[] {
  const terms = searchTerms(query);
  const matched = terms.length
    ? prepared.filter((entry) => terms.every((term) => entry.haystack.includes(term)))
    : prepared;

  return matched
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const result = compareSortValues(a.entry.values[sort.key], b.entry.values[sort.key]);
      if (result !== 0) return sort.direction === "asc" ? result : -result;
      return a.index - b.index;
    })
    .map(({ entry }) => entry.row);
}

/**
 * What clicking a column header does: re-clicking the sorted column flips
 * its direction, clicking a new one adopts that column's own starting
 * direction (ascending unless `defaultDirections` says otherwise — dates
 * and totals want newest/largest first).
 */
export function nextSortState<K extends string>(
  current: SortState<K>,
  key: K,
  defaultDirections?: Partial<Record<K, SortDirection>>
): SortState<K> {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: defaultDirections?.[key] ?? "asc" };
}
