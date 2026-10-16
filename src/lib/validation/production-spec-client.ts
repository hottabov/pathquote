// The zod-free half of validation/production-spec.ts.
//
// The builder's item cards and the production-spec panel are client
// components, and until 2026-10 they imported `production-spec.ts` for three
// things: the screen-side reader, `missingKeys`, and one `safeParse` of the
// EasyLoader spec to get its sections. That one import put the whole zod
// runtime (~380 KB) into the builder's and the client pages' JavaScript
// (docs/technical-audit/FINDINGS.md, PERF-08). Everything a browser needs is
// here, written by hand against the same rules; the zod schemas stay the
// server's source of truth and `tests/production-spec-client.test.ts` holds
// the two to the same answers.
//
// Rule: nothing in this module may import `zod`, `@/lib/db`, or anything
// under `./specs`. The shared limits are exported from here and imported by
// the zod schema, so a number can only be changed in one place.

import { MAX_SECTIONS, type Section, type SectionSurface } from "@/lib/production-forms/table-sections";

/** The two operator-screen sides, as `productionSpec.ui` stores them. */
export const SCREEN_SIDE_VALUES = ["+Y", "-Y"] as const;
export type ScreenSide = (typeof SCREEN_SIDE_VALUES)[number];

/** `-Y` -- material running right to left -- which the M-Series form prints
 * as `(STD)`. What a spec that never said means. */
export const DEFAULT_SCREEN_SIDE: ScreenSide = "-Y";

export function isScreenSide(value: unknown): value is ScreenSide {
  return value === "+Y" || value === "-Y";
}

/**
 * The side a stored `productionSpec` actually means, defaults included --
 * `-Y` for a spec that is null, unparseable, or simply has not been opened
 * yet. Same answer as `screenSideSchema.safeParse(spec.ui)` with its default,
 * which is what this replaced.
 */
export function readScreenSide(productionSpec: unknown): ScreenSide {
  const ui = (productionSpec as { ui?: unknown } | null | undefined)?.ui;
  return isScreenSide(ui) ? ui : DEFAULT_SCREEN_SIDE;
}

/**
 * Which of a form's `requires` keys are not yet answered. Drives both the
 * disabled download button and the 422 the route returns, so the UI and the
 * server can never disagree about what is missing.
 *
 * Two keys need more than a presence check: `drills` is satisfied when absent
 * or answered "no" and missing only when ticked with no detail, and
 * `sections` is not satisfied by an empty array.
 */
export function missingKeys(spec: unknown, required: readonly string[]): string[] {
  const record = (spec ?? {}) as Record<string, unknown>;

  return required.filter((key) => {
    const value = record[key];
    // Drills are optional: the "Drills required" box is a yes/no, and an
    // unticked box means no. Only "required, but no detail" blocks the form.
    if (key === "drills") {
      if (value === undefined || value === null) return false;
      const drills = value as { required?: boolean; detail?: string };
      if (drills.required === false) return false;
      return !drills.detail || drills.detail.trim().length === 0;
    }

    if (value === undefined || value === null) return true;

    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "string") return value.trim().length === 0;

    return false;
  });
}

// --- EasyLoader -----------------------------------------------------------

export const EASYLOADER_USAGES = ["onload", "offload"] as const;
export type EasyLoaderUsage = (typeof EASYLOADER_USAGES)[number];

export function isEasyLoaderUsage(value: unknown): value is EasyLoaderUsage {
  return value === "onload" || value === "offload";
}

export const SECTION_SURFACES = ["static", "conveyor"] as const;

function isSectionSurface(value: unknown): value is SectionSurface {
  return value === "static" || value === "conveyor";
}

/** The limits `easyLoaderSpecSchema` enforces, in one place for both. */
export const EASYLOADER_CUSTOM_WIDTH_MAX_MM = 9999;
export const SECTION_LENGTH_MAX_M = 99;
export const ROLL_FEED_MAX = 4;
export const ROLL_FEED_DISTANCE_MAX_MM = 99999;

/** What `easyLoaderSpecSchema` parses to -- every default applied. */
export type EasyLoaderSpecData = {
  ui: ScreenSide;
  usage: EasyLoaderUsage;
  customWidthMm?: number;
  sections: Section[];
  fabricProCompatible: boolean;
  syncWithCutter: boolean;
  rollFeedDistancesMm: number[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `z.number()`: a finite number. NaN and the infinities are refused. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** `z.number().int()`: zod v4's `int` is the safe-integer range, not merely
 * `Number.isInteger` -- 2**53 is an integer it refuses. */
function isInt(value: number): boolean {
  return Number.isSafeInteger(value);
}

/**
 * `easyLoaderSpecSchema.safeParse(input).data`, by hand: the parsed spec with
 * its defaults filled in, or `null` where the schema would refuse. A zod
 * object strips keys it does not know, so stray keys on a stored spec are
 * dropped rather than failing it, exactly as before.
 *
 * Each field below is one line of the schema in production-spec.ts, in the
 * same order; keep them aligned when either changes.
 */
export function parseEasyLoaderSpec(input: unknown): EasyLoaderSpecData | null {
  if (!isPlainObject(input)) return null;

  // ui: screenSideSchema (enum, default "-Y")
  const ui = input.ui === undefined ? DEFAULT_SCREEN_SIDE : input.ui;
  if (!isScreenSide(ui)) return null;

  // usage: enum, default "onload"
  const usage = input.usage === undefined ? "onload" : input.usage;
  if (!isEasyLoaderUsage(usage)) return null;

  // customWidthMm: int, positive, <= 9999, optional
  const customWidthMm = input.customWidthMm;
  if (customWidthMm !== undefined) {
    if (!isFiniteNumber(customWidthMm) || !isInt(customWidthMm)) return null;
    if (customWidthMm <= 0 || customWidthMm > EASYLOADER_CUSTOM_WIDTH_MAX_MM) return null;
  }

  // sections: array of { lengthM: positive <= 99, surface: enum }, max MAX_SECTIONS, default []
  const rawSections = input.sections === undefined ? [] : input.sections;
  if (!Array.isArray(rawSections) || rawSections.length > MAX_SECTIONS) return null;
  const sections: Section[] = [];
  for (const raw of rawSections) {
    if (!isPlainObject(raw)) return null;
    const { lengthM, surface } = raw;
    if (!isFiniteNumber(lengthM) || lengthM <= 0 || lengthM > SECTION_LENGTH_MAX_M) return null;
    if (!isSectionSurface(surface)) return null;
    sections.push({ lengthM, surface });
  }

  // fabricProCompatible: boolean, default false
  const fabricProCompatible = input.fabricProCompatible === undefined ? false : input.fabricProCompatible;
  if (typeof fabricProCompatible !== "boolean") return null;

  // syncWithCutter: boolean, default true
  const syncWithCutter = input.syncWithCutter === undefined ? true : input.syncWithCutter;
  if (typeof syncWithCutter !== "boolean") return null;

  // rollFeedDistancesMm: array of int 0..99999, max 4, default []
  const rawDistances = input.rollFeedDistancesMm === undefined ? [] : input.rollFeedDistancesMm;
  if (!Array.isArray(rawDistances) || rawDistances.length > ROLL_FEED_MAX) return null;
  const rollFeedDistancesMm: number[] = [];
  for (const raw of rawDistances) {
    if (!isFiniteNumber(raw) || !isInt(raw) || raw < 0 || raw > ROLL_FEED_DISTANCE_MAX_MM) return null;
    rollFeedDistancesMm.push(raw);
  }

  const data: EasyLoaderSpecData = { ui, usage, sections, fabricProCompatible, syncWithCutter, rollFeedDistancesMm };
  // An optional key zod leaves absent when the input had none; `data` is
  // compared structurally by the tests, so mirror that rather than writing
  // `customWidthMm: undefined`.
  if (customWidthMm !== undefined) data.customWidthMm = customWidthMm;
  return data;
}

/**
 * The table sections a stored EasyLoader spec describes, or none when the
 * spec is absent or would not parse -- the one question the builder's item
 * list asks of `easyLoaderSpecSchema` (to price the installation hours).
 */
export function readEasyLoaderSections(productionSpec: unknown): Section[] {
  return parseEasyLoaderSpec(productionSpec ?? {})?.sections ?? [];
}
