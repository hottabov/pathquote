import type { OptionRole, ProductionForm } from "@prisma/client";
import { mtsMetresValid } from "./mts";
import { missingRequirements, resolveForm } from "./resolve";

/**
 * What stops a quote from being finalized on the production side: an item
 * whose order form would come out incomplete.
 *
 * One function for three callers -- the finalize action (the real gate), the
 * builder's Finalize button (so the manager sees the list before clicking)
 * and the item card -- so the three can never disagree about what is
 * missing (Vadym, 2026-09-17: "не давай фіналізувати квоту якщо є якісь
 * помилки").
 *
 * Checked per item:
 * - the form's `requires` keys (`missingRequirements`), e.g. knife size, or
 *   drills ticked with no detail;
 * - an MTS with no travel distance. The distance decides both the price
 *   (MTS-M past nine metres) and what the workshop builds, so an MTS
 *   without one is not an answer.
 */

/** The label a missing key shows under, in the builder and in the finalize error. */
export const REQUIREMENT_LABELS: Record<string, string> = {
  knifeSize: "knife size",
  drills: "drill details",
  usage: "EasyLoader usage",
  sections: "table sections",
  mtsTravel: "MTS travel (m)",
};

export type ReadinessItem = {
  code: string;
  form: ProductionForm | null;
  productionSpec: unknown;
  /** OPTION lines, with the role of the option each came from. */
  options: Array<{ role: OptionRole | null; attributes: unknown }>;
};

export type ReadinessIssue = { code: string; missing: string[] };

/** The missing keys for one item (`mtsTravel` for the MTS distance). */
export function itemMissing(item: ReadinessItem): string[] {
  const missing: string[] = [];
  const spec = resolveForm(item.form);
  if (spec) missing.push(...missingRequirements(spec, item.productionSpec));

  const mts = item.options.find((option) => option.role === "MTS");
  if (mts && !mtsMetresValid(mts.attributes)) missing.push("mtsTravel");

  return missing;
}

export function productionIssues(items: ReadinessItem[]): ReadinessIssue[] {
  return items.flatMap((item) => {
    const missing = itemMissing(item);
    return missing.length > 0 ? [{ code: item.code, missing }] : [];
  });
}

/** "M-7220: knife size, MTS travel (m); X-10220: drill details" */
export function describeIssues(issues: ReadinessIssue[]): string {
  return issues
    .map((issue) => `${issue.code}: ${issue.missing.map((key) => REQUIREMENT_LABELS[key] ?? key).join(", ")}`)
    .join("; ");
}
