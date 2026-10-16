import { z } from "zod";
import { INDUSTRY_NAME_MAX } from "./industries-client";

// The matching helpers the pickers run on every keystroke have no zod in
// them and live in industries-client.ts, so the client bundle can take them
// without the schema runtime (PERF-08). Re-exported here so the server side
// and the existing tests keep their one import.
export {
  INDUSTRY_NAME_MAX,
  industryEqualsQuery,
  industryMatchesQuery,
  matchingIndustryAlias,
  normalizeIndustryName,
  type IndustryMatchable,
} from "./industries-client";

/** An industry name as typed by a user (the limit and its reason are with
 * `INDUSTRY_NAME_MAX` in industries-client.ts). */
export const industryNameSchema = z
  .string()
  .trim()
  .min(1, "Industry name is required")
  .max(INDUSTRY_NAME_MAX, `Industry name must be ${INDUSTRY_NAME_MAX} characters or fewer`);

/**
 * An alias as typed by an admin. Same shape as the name it stands in for --
 * an alias records a spelling some other system uses for an industry, and
 * that spelling is an industry name over there, so anything acceptable as a
 * name has to be acceptable as an alias. Kept as its own schema rather than
 * an `export { industryNameSchema as industryAliasSchema }` only so the
 * messages read right in the alias editor.
 */
export const industryAliasSchema = z
  .string()
  .trim()
  .min(1, "Alias is required")
  .max(80, "Alias must be 80 characters or fewer");
