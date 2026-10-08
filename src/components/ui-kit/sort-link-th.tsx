import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A `<th>` whose whole box is a sort *link*: the server-side sibling of
 * `SortableTh` (./list-table.tsx).
 *
 * `SortableTh` is a button that re-orders rows the browser already holds, and
 * it belongs to a `"use client"` module, so a Server Component cannot hand it
 * a URL. This one is for a list that is sorted by the server (/clients): the
 * header is an ordinary `<Link>` to the same page with a different `sort`
 * and `dir`, so a sort has a URL, survives the back button and can be shared.
 * Nothing here knows what the columns are or how the URL is built -- the
 * caller passes `href`.
 *
 * It is a separate file rather than a mode of `SortableTh` so that component
 * keeps exactly the behaviour its client-side callers (/quotes) rely on, and
 * so this one stays a Server Component. The look is the same on purpose; if
 * one changes, change the other.
 *
 * What a screen reader gets:
 *  - `aria-sort` on the `<th>`, which is how "this column is sorted, this way"
 *    is announced as the header is read. `"none"` on the others, as
 *    `SortableTh` does.
 *  - A link name that says what the click does -- "Sort by Name, descending"
 *    -- rather than only the label, which would sound the same whether or not
 *    pressing it would change anything. It still contains the visible label,
 *    so a voice-control user saying the word they can see reaches it.
 *  - The arrow is `aria-hidden`: the sighted equivalent of `aria-sort`, not a
 *    second announcement of it.
 */
export function SortLinkTh({
  label,
  href,
  direction,
  nextDirection,
  align,
  className,
}: {
  /** The visible column name. */
  label: string;
  /** Where a click goes: the same list, ordered by this column. */
  href: string;
  /** How the list is ordered by this column now, or `null` when it is
   * ordered by some other column. */
  direction: "asc" | "desc" | null;
  /** The direction the click asks for. Not derived from `direction` because
   * the first click on a column need not be ascending (Contacts opens
   * descending). */
  nextDirection: "asc" | "desc";
  align?: "right";
  className?: string;
}) {
  const active = direction !== null;
  const Icon = !active ? ChevronsUpDown : direction === "asc" ? ArrowUp : ArrowDown;

  return (
    <th
      scope="col"
      aria-sort={!active ? "none" : direction === "asc" ? "ascending" : "descending"}
      className={cn("p-0", className)}
    >
      <Link
        href={href}
        aria-label={`Sort by ${label}, ${nextDirection === "asc" ? "ascending" : "descending"}`}
        className={cn(
          "focus-ring group flex min-h-11 w-full items-center gap-1.5 px-4 py-3 text-xs font-medium tracking-wide uppercase transition-colors hover:bg-slate-50 hover:text-brand-dark",
          active ? "text-brand-dark" : "text-slate-500",
          align === "right" && "justify-end"
        )}
      >
        <span>{label}</span>
        <Icon
          className={cn(
            "size-3.5 shrink-0 transition-opacity",
            active ? "text-brand opacity-100" : "opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60"
          )}
          aria-hidden="true"
        />
      </Link>
    </th>
  );
}
