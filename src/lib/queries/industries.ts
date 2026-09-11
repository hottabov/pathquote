import { db } from "@/lib/db";

/**
 * Every industry, alphabetically, each with the alternative spellings that
 * should also find it. The picker filters client-side: the list is expected
 * to hold hundreds of imported rows, which is small enough to ship whole and
 * makes typeahead instant with no round trip per keystroke.
 *
 * The aliases ride along for the same reason. They are a handful of short
 * strings per row and the picker has to search them (see
 * `industryMatchesQuery`), so fetching them here costs one join and saves the
 * per-keystroke round trip the whole shape of this query exists to avoid.
 */
export async function listIndustries() {
  return db.industry.findMany({
    orderBy: { name: "asc" },
    include: { aliases: { orderBy: { name: "asc" }, select: { id: true, name: true } } },
  });
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

export type IndustryAliasItem = { id: string; name: string };

export type IndustryAdminListItem = {
  id: string;
  name: string;
  /** Companies pointing at this row, across every owner. */
  companyCount: number;
  /** Other spellings that resolve to this row, alphabetically. Never printed
   * on a document -- see the `IndustryAlias` model. */
  aliases: IndustryAliasItem[];
};

/**
 * Every industry with the number of companies using it — the whole table, for
 * the ADMIN-only /settings/industries screen.
 *
 * ADMIN-ONLY BY CONTRACT, for the same reason as `countCompaniesUsingIndustry`
 * above: the counts are unscoped, so they are cross-manager data. That is the
 * point here — the screen exists so an admin can see which rows are unused
 * (safe to delete) and which duplicates are worth merging, and a per-owner
 * count would answer neither question.
 *
 * One grouped count rather than a count per row: the table is small, but a
 * screen whose whole job is showing every row must not issue a query per row.
 * Industries with no companies at all are absent from the group-by, hence the
 * `?? 0`.
 */
export async function listIndustriesWithCounts(): Promise<IndustryAdminListItem[]> {
  const [industries, grouped] = await Promise.all([
    db.industry.findMany({
      orderBy: { name: "asc" },
      include: { aliases: { orderBy: { name: "asc" }, select: { id: true, name: true } } },
    }),
    db.company.groupBy({
      by: ["industryId"],
      where: { industryId: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const counts = new Map(grouped.map((row) => [row.industryId, row._count._all]));
  return industries.map((industry) => ({
    id: industry.id,
    name: industry.name,
    companyCount: counts.get(industry.id) ?? 0,
    aliases: industry.aliases,
  }));
}
