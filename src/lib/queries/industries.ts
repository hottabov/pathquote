import { db } from "@/lib/db";

/**
 * Every industry, alphabetically. The picker filters client-side: the list
 * is expected to hold hundreds of imported rows, which is small enough to
 * ship whole and makes typeahead instant with no round trip per keystroke.
 */
export async function listIndustries() {
  return db.industry.findMany({ orderBy: { name: "asc" } });
}

/**
 * How many companies point at an industry, across every owner. Shown in the
 * rename confirmation so a shared-row edit is never silent.
 *
 * ADMIN-ONLY BY CONTRACT. The count is deliberately unscoped — a rename
 * really does reach every company, and a per-owner number would understate
 * that. But it is therefore cross-manager data, so callers must not show it
 * to a MANAGER; see the client card, which passes `usageCount: null` for
 * one and renders a qualitative warning instead. Scoping this to fix the
 * leak would trade a small disclosure for a wrong number, which is worse.
 */
export async function countCompaniesUsingIndustry(industryId: string): Promise<number> {
  return db.company.count({ where: { industryId } });
}
