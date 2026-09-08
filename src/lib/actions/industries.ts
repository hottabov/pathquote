"use server";

import { revalidateCompany, revalidateCompanyList, revalidateIndustryList } from "@/lib/revalidate";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireAdmin, requireSession } from "@/lib/authz";
import { idSchema, optionalIdSchema } from "@/lib/validation/documents";
import { industryNameSchema, normalizeIndustryName } from "@/lib/validation/industries";
import { companyWhereForUser } from "@/lib/scope";
import { NOT_FOUND_ERROR, flattenZodError, type ActionResult } from "./_shared";

export type { ActionResult };

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Finds the industry row whose normalized name matches `key`, or undefined
 * if there is none. Prisma cannot query the database's case-insensitive
 * functional unique index (Industry_name_lower_key, added in Task 1)
 * directly, so this loads every row and compares in JS -- correct and cheap
 * since the table holds hundreds of rows at most. `excludeId` lets a rename
 * check for a clash against every *other* row.
 */
async function findByNormalizedName(key: string, excludeId?: string) {
  const rows = await db.industry.findMany();
  return rows.find((row) => row.id !== excludeId && normalizeIndustryName(row.name) === key);
}

/**
 * Creates an industry, or returns the existing one when a case-insensitive
 * match is already present -- typing "automotive" next to an existing
 * "Automotive" must not grow the list by a near-duplicate.
 */
export async function createIndustry(name: string): Promise<ActionResult & { id?: string }> {
  await requireSession();

  const parsed = industryNameSchema.safeParse(name);
  if (!parsed.success) return { error: flattenZodError(parsed.error) };

  const key = normalizeIndustryName(parsed.data);
  const existing = await findByNormalizedName(key);
  if (existing) return { id: existing.id };

  try {
    const created = await db.industry.create({ data: { name: parsed.data } });
    revalidateCompanyList();
    revalidateIndustryList();
    return { id: created.id };
  } catch (error) {
    // The findByNormalizedName() check above is check-then-act and can
    // race: two concurrent creates for the same normalized name can both
    // pass it. The database's unique index is what actually guarantees
    // uniqueness. Losing that race is expected, not an error -- re-resolve
    // to the row that won and hand back its id, exactly as if the initial
    // check had found it.
    if (isUniqueConstraintError(error)) {
      const winner = await findByNormalizedName(key);
      if (winner) return { id: winner.id };
    }
    throw error;
  }
}

/**
 * Renames the shared row. The caller shows the affected-company count first
 * (see `countCompaniesUsingIndustry`); this only guards the data.
 *
 * Admin-only, unlike `createIndustry`. Creating is additive and deduplicated,
 * so the worst case is a redundant row. Renaming changes a value every
 * manager's companies display and every production form prints, with no trace
 * for the people who did not do it -- the same blast radius that makes every
 * mutation on the other global tables (Region, Series, Product, Option)
 * admin-only. See `requireAdmin` in src/lib/authz.ts.
 */
export async function renameIndustry(industryId: string, name: string): Promise<ActionResult> {
  await requireAdmin();

  const parsedId = idSchema.safeParse(industryId);
  if (!parsedId.success) return { error: NOT_FOUND_ERROR };

  const parsed = industryNameSchema.safeParse(name);
  if (!parsed.success) return { error: flattenZodError(parsed.error) };

  const industry = await db.industry.findUnique({ where: { id: parsedId.data } });
  if (!industry) return { error: NOT_FOUND_ERROR };

  const key = normalizeIndustryName(parsed.data);
  const clash = await findByNormalizedName(key, industry.id);
  if (clash) return { error: `"${clash.name}" already exists` };

  try {
    await db.industry.update({ where: { id: industry.id }, data: { name: parsed.data } });
  } catch (error) {
    // Same check-then-act race as createIndustry: the clash check above can
    // pass while a concurrent rename to the same normalized name lands
    // first. Re-resolve to name the row that won instead of surfacing the
    // raw constraint error.
    if (isUniqueConstraintError(error)) {
      const winner = await findByNormalizedName(key, industry.id);
      return { error: `"${winner?.name ?? parsed.data}" already exists` };
    }
    throw error;
  }

  revalidateCompanyList();
  revalidateIndustryList();
  return {};
}

/**
 * Deletes an industry nothing is using.
 *
 * Refuses while any company still points at it, rather than relying on the
 * schema's `onDelete: SetNull` to quietly unset the field on every one of
 * them. That FK exists so a delete can never orphan a row; it is not a
 * decision about whether the delete was wanted. An admin who genuinely wants
 * the rows moved has `mergeIndustries` for it, which says where they go.
 *
 * The count is re-read here rather than trusted from the screen: the list was
 * rendered at some earlier moment, and a manager may have picked this industry
 * for a company since.
 */
export async function deleteIndustry(industryId: string): Promise<ActionResult> {
  await requireAdmin();

  const parsedId = idSchema.safeParse(industryId);
  if (!parsedId.success) return { error: NOT_FOUND_ERROR };

  const industry = await db.industry.findUnique({ where: { id: parsedId.data } });
  if (!industry) return { error: NOT_FOUND_ERROR };

  const inUse = await db.company.count({ where: { industryId: industry.id } });
  if (inUse > 0) {
    return {
      error: `"${industry.name}" is used by ${inUse} ${inUse === 1 ? "company" : "companies"}. Merge it into another industry instead.`,
    };
  }

  // Between the count above and this delete, a company could be pointed at
  // the row. `onDelete: SetNull` means that company survives with a blank
  // industry rather than the delete failing, which is the acceptable end of
  // that race — the alternative is a transaction taken out on a table every
  // company edit touches, to close a window measured in milliseconds on an
  // action an admin performs by hand.
  await db.industry.delete({ where: { id: industry.id } });

  revalidateCompanyList();
  revalidateIndustryList();
  return {};
}

/**
 * Moves every company off `sourceId` onto `targetId` and deletes the source —
 * the fix for the duplicates the inline picker's "Create ..." accumulates
 * ("Retail" / "Retail trade" / "Retailing"), which `createIndustry`'s
 * case-insensitive dedupe cannot catch because they are not the same word.
 *
 * One transaction: a half-done merge would leave companies split across two
 * rows with the source gone or still there, and no way to tell which half ran.
 *
 * Deliberately not reversible and deliberately not asked twice here — the
 * caller confirms, naming both rows and the number of companies about to
 * move.
 */
export async function mergeIndustries(sourceId: string, targetId: string): Promise<ActionResult> {
  await requireAdmin();

  const parsedSource = idSchema.safeParse(sourceId);
  const parsedTarget = idSchema.safeParse(targetId);
  if (!parsedSource.success || !parsedTarget.success) return { error: NOT_FOUND_ERROR };

  // Not merely pointless: it would delete the row every affected company was
  // just moved onto, taking the industry off all of them.
  if (parsedSource.data === parsedTarget.data) {
    return { error: "Can't merge an industry into itself." };
  }

  const [source, target] = await Promise.all([
    db.industry.findUnique({ where: { id: parsedSource.data } }),
    db.industry.findUnique({ where: { id: parsedTarget.data } }),
  ]);
  if (!source || !target) return { error: NOT_FOUND_ERROR };

  await db.$transaction(async (tx) => {
    await tx.company.updateMany({
      where: { industryId: source.id },
      data: { industryId: target.id },
    });
    await tx.industry.delete({ where: { id: source.id } });
  });

  revalidateCompanyList();
  revalidateIndustryList();
  return {};
}

/**
 * Points a company at an industry, or clears it. Scoped like every other
 * company mutation in src/lib/actions/clients.ts.
 */
export async function setCompanyIndustry(
  companyId: string,
  industryId: string | null,
): Promise<ActionResult> {
  const session = await requireSession();

  const parsedCompanyId = idSchema.safeParse(companyId);
  if (!parsedCompanyId.success) return { error: NOT_FOUND_ERROR };

  const parsedIndustryId = optionalIdSchema.safeParse(industryId ?? undefined);
  if (!parsedIndustryId.success) return { error: NOT_FOUND_ERROR };

  const company = await db.company.findFirst({
    where: { id: parsedCompanyId.data, ...companyWhereForUser(session.user) },
  });
  if (!company) return { error: NOT_FOUND_ERROR };

  // A well-formed id naming no Industry row would otherwise reach the
  // foreign key and throw an unhandled Prisma error. `undefined` here means
  // "clear the field" and must not trigger this lookup.
  if (parsedIndustryId.data !== undefined) {
    const industry = await db.industry.findUnique({ where: { id: parsedIndustryId.data } });
    if (!industry) return { error: NOT_FOUND_ERROR };
  }

  await db.company.update({
    where: { id: company.id },
    data: { industryId: parsedIndustryId.data ?? null },
  });

  revalidateCompany(company.id);
  revalidateIndustryList();
  return {};
}
