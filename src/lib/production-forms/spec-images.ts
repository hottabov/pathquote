// Shared source of truth for which discrete production-spec fields have an
// admin-manageable diagram (`SpecImage`, see that model's doc comment in
// schema.prisma) and what values each one takes — read by both the builder's
// `ProductionSpecEditor` (which field/value the salesperson currently has
// selected) and the Settings → Catalogue admin page (which upload slots to
// render). Kept as its own dependency-free module, same discipline as
// src/lib/production-forms/table-sections.ts, so it's trivially usable from
// both a "use client" component and a server component/page with no `@/lib/db`
// import dragged into either.
//
// Only "screenSide" is wired up today (the owner asked for that one
// specifically — see the commit's own brief) — `SPEC_IMAGE_FIELDS` is an
// array precisely so a future discrete choice (knife size, voltage) is one
// more entry here, not a new mechanism.

/** `DocumentItem.productionSpec.ui` — see production-spec-editor.tsx's
 * `SCREEN_SIDES` select. Exported so both that editor and the admin page
 * import the exact same two values rather than risking drift between two
 * hand-typed copies. */
export const SCREEN_SIDES = ["+Y", "-Y"] as const;
export type ScreenSide = (typeof SCREEN_SIDES)[number];

/** The `SpecImage.field` key the two diagrams above are stored under. A
 * string literal in four places until the quotation started printing the
 * diagram too (2026-09-22) — a typo in any one of them is a silently missing
 * picture, not an error, which is exactly the kind of bug a constant ends. */
export const SCREEN_SIDE_FIELD = "screenSide";

/** `value -> imageUrl` for one field's uploaded diagrams — structurally the
 * same thing `getSpecImages` returns (src/lib/queries/spec-images.ts),
 * declared here as well so a module with this file's purity rule can name
 * the shape without importing one that opens a database connection. */
export type SpecImageMap = Record<string, string>;

export type SpecImageFieldConfig = {
  /** The `SpecImage.field` key — also the production-spec JSON key this
   * illustrates (`draft.ui` for "screenSide" — see
   * production-spec-editor.tsx). */
  field: string;
  /** Admin-facing label for this field's section on the Settings →
   * Catalogue page. */
  label: string;
  /** Every value this field takes, in display order — also what
   * `listSpecImages` (src/lib/queries/spec-images.ts) uses to render one
   * upload slot per value regardless of what's been uploaded yet. */
  values: readonly string[];
};

/** The one field wired up today. Add an entry here (and a matching
 * `SpecDiagram` lookup at its own call site — see production-spec-editor.tsx)
 * to extend the same treatment to another discrete spec choice; the model
 * and admin page both already support any `field`. */
export const SPEC_IMAGE_FIELDS: SpecImageFieldConfig[] = [
  { field: SCREEN_SIDE_FIELD, label: "Operator screen side / Control box side", values: SCREEN_SIDES },
];

/**
 * Looks up the diagram for one field's current `value` in an already-fetched
 * `value -> imageUrl` map (`getSpecImages`, src/lib/queries/spec-images.ts) —
 * `null` when nothing's been uploaded for that exact value yet, in which
 * case the caller (see `SpecDiagram`, src/components/builder/spec-diagram.tsx)
 * falls back to its placeholder box rather than a broken image. Pulled out
 * as its own pure function (rather than an inline `images[value] ?? null` at
 * each call site) so the "what image goes with this value" rule is
 * unit-testable without rendering any component.
 */
export function resolveSpecImage(images: Record<string, string>, value: string): string | null {
  return images[value] ?? null;
}
