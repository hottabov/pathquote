import Link from "next/link";
import { cn } from "@/lib/utils";

type TableShellProps = {
  /** A `<table>` (thead+tbody), shown md+ inside a bordered, scrollable card. */
  table: React.ReactNode;
  /** A stacked list of cards, shown below md instead of the table. */
  cards: React.ReactNode;
  className?: string;
};

/**
 * The list-page responsive split used across Documents/Clients/Catalog: a
 * real `<table>` on md+ (inside an overflow-x wrapper so wide tables scroll
 * instead of breaking layout) and a stacked-card list on mobile. Callers
 * build both renderings themselves and hand them in as two explicit slots —
 * kept deliberately simple rather than a generic column-driven table
 * component, since each screen's row shape differs enough that a shared
 * abstraction would just get in the way.
 */
export function TableShell({ table, cards, className }: TableShellProps) {
  return (
    <div className={className}>
      <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white md:block">
        {table}
      </div>
      <div className="flex flex-col gap-3 md:hidden">{cards}</div>
    </div>
  );
}

/**
 * The one-tree alternative to `TableShell` for the lists that can have
 * hundreds of rows (/quotes, /clients): the same `<table>` is both the md+
 * table and the mobile card stack, switched by CSS on the table elements
 * themselves rather than by rendering every row twice and hiding one copy.
 *
 * `TableShell` asks for two renderings and that is fine for a settings table
 * of a dozen regions; at 600 quotes it doubled a 4.5 MB page. Here the
 * `<table>`, `<thead>`, `<tbody>`, `<tr>` and `<td>` carry `block`/`flex`/
 * `grid` below md and return to their table display values at md, so the
 * markup exists once and the browser lays it out either way. Each `<td>` in a
 * card is a grid item; the caller places it with `col-start`/`row-start`
 * classes, which table layout ignores at md so they need no `md:` reset.
 *
 * Children: a `<table className={responsiveTableClassName}>` whose `<thead>`,
 * `<tbody>` and rows use the matching constants below.
 */
export function ResponsiveTableShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("md:overflow-x-auto md:rounded-xl md:border md:border-slate-200 md:bg-white", className)}>
      {children}
    </div>
  );
}

/** The `<table>`: a plain block below md, a real table from md with the same
 * minimum width `tableClassName` gives, so wide tables scroll inside the
 * shell instead of breaking the layout. */
export const responsiveTableClassName = "block w-full text-sm md:table md:min-w-[560px]";

/** The `<thead>`: a card has no column headers, so it is hidden below md.
 * Callers that need a mobile sort control put it in a toolbar instead. */
export const responsiveTheadClassName = "hidden md:table-header-group";

/** The `<tbody>`: the card stack's gap lives here below md. */
export const responsiveTbodyClassName = "flex flex-col gap-3 md:table-row-group";

/**
 * A row: below md a bordered card laid out as a three-column grid -- a
 * flexible first column for the text that may truncate, then two `auto`
 * columns for right-aligned values and a trailing icon button, both of which
 * collapse to nothing when every cell in them is empty. From md it is an
 * ordinary table row with `tableRowClassName`'s divider and hover.
 *
 * The border is set per side at md rather than with `border-0` + `border-b`
 * so the two never depend on which of them Tailwind emits last.
 */
export const responsiveRowClassName =
  "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 rounded-xl border border-slate-200 bg-white p-4 md:table-row md:rounded-none md:border-x-0 md:border-t-0 md:border-b md:border-slate-100 md:bg-transparent md:p-0 md:transition-colors md:last:border-b-0 md:hover:bg-slate-50";

/** A cell: a grid item below md (placed by the caller), a padded table cell
 * from md. `min-w-0` lets a `truncate` child actually truncate inside the
 * grid's flexible column. */
export const responsiveCellClassName = "block min-w-0 md:table-cell md:px-4 md:py-3 md:align-middle";

/** Shared `<table>` element classes — 14px body text per the design
 * direction, hairline row dividers, sticky-safe header. Use directly on the
 * `<table>` a caller passes as TableShell's `table` slot. */
export const tableClassName = "w-full min-w-[560px] text-sm";

/** Shared `<thead>` row classes: uppercase muted labels, hairline bottom
 * border separating the header from body rows. */
export const tableHeadRowClassName =
  "border-b border-slate-200 text-left text-xs font-medium tracking-wide text-slate-500 uppercase";

/** Shared `<tbody>` row classes: hairline divider between rows, hover
 * affordance (desktop-only, per the design direction), and a min-height
 * tall enough that row padding alone won't create sub-44px touch targets on
 * a stray touch-enabled desktop. */
export const tableRowClassName =
  "border-b border-slate-100 last:border-b-0 transition-colors md:hover:bg-slate-50";

/**
 * One cell of a clickable table row. Each `<td>` gets its own full-cell
 * `<Link>` (padding moved off the `<td>` and onto the `<a>`, so the link's
 * box exactly fills the cell) rather than a single `absolute inset-0` link
 * positioned against the `<tr>` — `position: relative` on a `<tr>` isn't a
 * reliable containing block for an absolutely-positioned child across
 * browsers/table layout modes, which was the actual bug (clicking a cell's
 * own text didn't navigate: the overlay link was being sized/positioned
 * against whatever ancestor *did* establish a containing block, not the row
 * directly). A real, normal-flow link per cell has no such ambiguity and
 * needs no absolute positioning at all.
 *
 * Only one cell in a row should pass `primary` — it's the one announced/
 * focusable as a link; the rest are `aria-hidden`/`tabIndex={-1}` so mouse
 * users get full-row click coverage while keyboard/screen-reader users still
 * see exactly one "Open {row}" stop per row.
 *
 * Right for the short admin tables that still use it (catalog, settings,
 * contacts). Not for the long lists: a `<Link>` per cell is a client
 * component instance per cell, and at seven cells × 600 rows that was most of
 * the /quotes page. Those lists keep ONE link per row -- in the primary cell
 * -- and get full-row click coverage from `LinkedRowsBody`
 * (./list-table.tsx), a single delegated handler on the `<tbody>`.
 */
export function RowCell({
  href,
  children,
  primary,
  align,
}: {
  href: string;
  children: React.ReactNode;
  primary?: string;
  align?: "right";
}) {
  return (
    <td className="p-0 align-middle">
      <Link
        href={href}
        aria-label={primary}
        aria-hidden={primary ? undefined : true}
        tabIndex={primary ? undefined : -1}
        className={cn("focus-ring block px-4 py-3", align === "right" && "text-right")}
      >
        {children}
      </Link>
    </td>
  );
}
