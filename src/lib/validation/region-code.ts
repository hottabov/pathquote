// The one definition of "a region code" for the whole app. It used to be
// copy-pasted into src/lib/validation/{content,regions,clients}.ts and, in a
// nullable disguise, into users.ts; the copies had drifted nowhere yet, but
// four hand-maintained spellings of the same 2-3-letter rule is three too
// many. Those modules now re-export from here so every existing import path
// (several of them in src/lib/actions/**) keeps working unchanged. No
// imports beyond zod, for the same reason the modules that re-export it have
// none: they must stay importable from a plain unit test with no
// `DATABASE_URL`.
import { z } from "zod";

/** A region code — 2-3 letters (AU, US, UK, USA...), accepted in any case
 * and normalized to uppercase so it always matches `Region.code`, which is
 * stored uppercase. Surrounding whitespace is stripped first because these
 * arrive from `FormData` and from route params, neither of which the user
 * can be trusted to have typed cleanly. */
export const regionCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z]{2,3}$/.test(value), {
    message: "Region code must be 2-3 letters",
  });

/** A region code, or `null`/absent for "no region assigned" — a User's
 * `regionId` is optional in the schema, unlike Company's mandatory region.
 * Missing/blank/the sentinel empty-option value all collapse to `null`. */
export const userRegionCodeSchema = z.preprocess(
  (value) =>
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
      ? null
      : value,
  regionCodeSchema.nullable()
);
