// The zod-free reader for `Product.specs`, for client components.
//
// `readProductSpecs` in product-specs.ts is one `safeParse`, and the builder's
// item list called it per item to hand the production-spec panel the
// product's figures -- which pulled the zod runtime into the builder's
// JavaScript (PERF-08). This is the same reader written by hand against the
// same rules; `productSpecsSchema` stays the server's source of truth, imports
// the enum tuples from here so they cannot drift, and
// tests/product-specs-client.test.ts holds the two to the same answers.
//
// Rule: no `zod` import in this file.

import type { ProductSpecs } from "./product-specs";

export const BELTS = ["urethane", "felt"] as const;
export const SOFTWARE_MODES = ["standalone", "integrated"] as const;
export const PATHWORKS_MODULES = ["PDG", "WPN", "WPL", "ANT_V5", "ANT_V6"] as const;

/** Every key `productSpecsSchema` knows. The schema is `.strict()`, so a
 * specs blob carrying any other key reads as "no specs" -- see below. */
const KNOWN_KEYS: ReadonlySet<string> = new Set<keyof ProductSpecs>([
  "cutHeightCm",
  "cutWidthCm",
  "tableWidthMm",
  "paperWidthMm",
  "modelTier",
  "widthCode",
  "extended",
  "belt",
  "softwareMode",
  "pathworksModule",
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** `z.number().positive()` */
function isPositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

/** `z.number().int().positive()` -- zod v4's `int` is the safe-integer range. */
function isPositiveInt(value: unknown): value is number {
  return isPositive(value) && Number.isSafeInteger(value);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/**
 * `productSpecsSchema.safeParse(raw).data`, by hand, or `null` where the
 * schema would refuse. Each check below is one line of the schema in
 * product-specs.ts, in the same order; keep them aligned when either changes.
 *
 * An optional field given as `undefined` is accepted (that is what optional
 * means) and, like zod, kept on the output only when the key was present.
 */
export function parseProductSpecs(raw: unknown): ProductSpecs | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.has(key)) return null; // .strict()
  }

  const out: ProductSpecs = {};
  const checks: Array<[keyof ProductSpecs, (value: unknown) => boolean]> = [
    ["cutHeightCm", isPositive],
    ["cutWidthCm", isPositive],
    ["tableWidthMm", isPositiveInt],
    ["paperWidthMm", isPositiveInt],
    ["modelTier", (value) => typeof value === "string" && value.length >= 1],
    ["widthCode", isPositiveInt],
    ["extended", (value) => typeof value === "boolean"],
    ["belt", (value) => isOneOf(BELTS, value)],
    ["softwareMode", (value) => isOneOf(SOFTWARE_MODES, value)],
    ["pathworksModule", (value) => isOneOf(PATHWORKS_MODULES, value)],
  ];

  for (const [key, ok] of checks) {
    if (!(key in input)) continue;
    const value = input[key];
    if (value !== undefined && !ok(value)) return null;
    (out as Record<string, unknown>)[key] = value;
  }

  return out;
}

/**
 * Reads `Product.specs` defensively: a null column, a pre-migration blob
 * or a hand-edited one that fails validation all read as "no specs" rather
 * than throwing inside a render. Same contract as the zod `readProductSpecs`.
 */
export function readProductSpecs(raw: unknown): ProductSpecs {
  return parseProductSpecs(raw ?? {}) ?? {};
}
