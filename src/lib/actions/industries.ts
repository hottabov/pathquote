"use server";

import { revalidateCompany, revalidateCompanyList, revalidateIndustryList } from "@/lib/revalidate";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireAdmin, requireSession } from "@/lib/authz";
import { idSchema, optionalIdSchema } from "@/lib/validation/documents";
import {
  industryAliasSchema,
  industryNameSchema,
  normalizeIndustryName,
} from "@/lib/validation/industries";
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
 * Whether a spelling is already spoken for, by an industry's own name or by
 * any alias -- the check every write of a name or an alias has to make.
 *
 * The two tables are one namespace by intent, not by accident: an incoming
 * ACT! category is looked up in both, so a string that is one industry's name
 * and another's alias has two correct destinations and therefore none. The
 * database enforces uniqueness *within* each table (Industry_name_lower_key,
 * IndustryAlias_name_lower_key); nothing but this function enforces it
 * across them, which is why it hands back a finished message naming the row
 * that holds the spelling: "already exists" alone leaves an admin looking at
 * a list the name is visibly not in.
 *
 * `excludeIndustryId` ignores one industry *and its aliases* -- the shape a
 * rename needs. A row holding "Retail trade" as an alias and being renamed to
 * "Retail trade" is not in conflict with itself; `renameIndustry` resolves
 * that pair by dropping the now-redundant alias, and it can only do so if
 * this does not report the pair as a clash first.
 */
async function findNameOwner(
  key: string,
  excludeIndustryId?: string
): Promise<{ industryId: string; conflict: string } | undefined> {
  const [industries, aliases] = await Promise.all([db.industry.findMany(), db.industryAlias.findMany()]);

  const industry = industries.find(
    (row) => row.id !== excludeIndustryId && normalizeIndustryName(row.name) === key
  );
  if (industry) return { industryId: industry.id, conflict: `"${industry.name}" already exists` };

  const alias = aliases.find(
    (row) => row.industryId !== excludeIndustryId && normalizeIndustryName(row.name) === key
  );
  if (!alias) return undefined;

  const owner = industries.find((row) => row.id === alias.industryId);
  return {
    industryId: alias.industryId,
    conflict: owner
      ? `"${alias.name}" is already an alias of "${owner.name}"`
      : `"${alias.name}" is already an alias`,
  };
}

/**
 * Creates an industry, or returns the existing one when a case-insensitive
 * match is already present -- typing "automotive" next to an existing
 * "Automotive" must not grow the list by a near-duplicate.
 *
 * An alias counts as a match and resolves to the industry holding it. That is
 * the whole return on recording aliases: someone typing ACT!'s "Retail trade"
 * into the picker lands on our "Retail" instead of creating the duplicate a
 * previous merge already cleaned up once.
 */
export async function createIndustry(name: string): Promise<ActionResult & { id?: string }> {
  await requireSession();

  const parsed = industryNameSchema.safeParse(name);
  if (!parsed.success) return { error: flattenZodError(parsed.error) };

  const key = normalizeIndustryName(parsed.data);
  const owner = await findNameOwner(key);
  if (owner) return { id: owner.industryId };

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
  const clash = await findNameOwner(key, industry.id);
  if (clash) return { error: clash.conflict };

  // The row's own alias for the name it is being renamed to. Not a clash --
  // "Retail" renamed to "Retail trade" while holding "Retail trade" as an
  // alias is an admin promoting a spelling, and the alias is simply now
  // redundant. Left in place it would break the next rename in the opposite
  // direction and, worse, the name and the alias would both match an import
  // with two answers that happen to agree today. Dropped in the same
  // transaction as the rename so the pair is never briefly both.
  const redundantAlias = (await db.industryAlias.findMany({ where: { industryId: industry.id } })).find(
    (alias) => normalizeIndustryName(alias.name) === key
  );

  try {
    await db.$transaction(async (tx) => {
      if (redundantAlias) await tx.industryAlias.delete({ where: { id: redundantAlias.id } });
      await tx.industry.update({ where: { id: industry.id }, data: { name: parsed.data } });
    });
  } catch (error) {
    // Same check-then-act race as createIndustry: the clash check above can
    // pass while a concurrent rename to the same normalized name lands
    // first. Re-resolve to name the row that won instead of surfacing the
    // raw constraint error.
    if (isUniqueConstraintError(error)) {
      const winner = await findNameOwner(key, industry.id);
      return { error: winner?.conflict ?? `"${parsed.data}" already exists` };
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
 *
 * Any aliases go with it (ON DELETE CASCADE). That is the right end for a row
 * nothing uses -- an alias exists to route an import onto an industry, and
 * there is no longer an industry to route it to. An admin who wants the
 * spellings kept wants `mergeIndustries`, which moves them.
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
 * The source's name and aliases move too, as aliases of the target -- see the
 * comments in the body. Merging alone fixes the rows that exist; the aliases
 * are what stop the next import from re-creating the duplicate.
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

  const [sourceAliases, targetAliases] = await Promise.all([
    db.industryAlias.findMany({ where: { industryId: source.id } }),
    db.industryAlias.findMany({ where: { industryId: target.id } }),
  ]);

  // Every spelling the target will answer to once the merge lands. Seeded with
  // its own name, because an alias equal to the name it points at is a row
  // that can only ever be redundant.
  const taken = new Set([
    normalizeIndustryName(target.name),
    ...targetAliases.map((alias) => normalizeIndustryName(alias.name)),
  ]);

  // The source's aliases follow its companies -- they were recorded to catch
  // an import that means this industry, and after the merge that industry is
  // the target. Any that the target already answers to are dropped instead of
  // moved: a second row with the same normalized name would fail
  // IndustryAlias_name_lower_key and take the whole transaction with it.
  const aliasesToMove = sourceAliases.filter((alias) => !taken.has(normalizeIndustryName(alias.name)));
  for (const alias of aliasesToMove) taken.add(normalizeIndustryName(alias.name));

  // And the source's own name becomes an alias of the target -- the point of
  // the merge from ACT!'s side. Merging "Retail trade" into "Retail" fixes the
  // companies today; without this the next import types "Retail trade" again
  // and re-creates the row. Skipped when the target already answers to it,
  // which is the case for a merge that only differed by case.
  const sourceNameKey = normalizeIndustryName(source.name);
  // Third check, for a spelling some *other* industry already claims as an
  // alias. `findNameOwner` refuses to create that situation, but the two
  // tables share a namespace only by application rule, and an import or a
  // hand-run script could have produced it. Creating the alias anyway would
  // hit IndustryAlias_name_lower_key inside the transaction and roll the
  // whole merge back — the companies included — over a mapping that is not
  // the point of the operation. Skipped instead.
  const claimedElsewhere = (await db.industryAlias.findMany()).some(
    (alias) => alias.industryId !== source.id && normalizeIndustryName(alias.name) === sourceNameKey
  );
  const adoptSourceName = !taken.has(sourceNameKey) && !claimedElsewhere;

  await db.$transaction(async (tx) => {
    await tx.company.updateMany({
      where: { industryId: source.id },
      data: { industryId: target.id },
    });
    if (aliasesToMove.length > 0) {
      await tx.industryAlias.updateMany({
        where: { id: { in: aliasesToMove.map((alias) => alias.id) } },
        data: { industryId: target.id },
      });
    }
    if (adoptSourceName) {
      await tx.industryAlias.create({ data: { name: source.name, industryId: target.id } });
    }
    // Whatever aliases are still on the source at this point are the ones the
    // target already covers; the schema's ON DELETE CASCADE takes them.
    await tx.industry.delete({ where: { id: source.id } });
  });

  revalidateCompanyList();
  revalidateIndustryList();
  return {};
}

/**
 * Records another spelling for an industry -- ACT!'s "Retail trade" against
 * our "Retail", or the typo someone in sales will enter next week.
 *
 * Admin-only and for the same reason as `renameIndustry`: the row is shared,
 * and an alias silently changes where a future import lands for every
 * manager. Unlike a rename it prints nowhere, which is why it is additive and
 * cheap to undo -- delete the alias and the mapping is simply gone.
 *
 * Adding a spelling the industry already answers to is a no-op rather than an
 * error, mirroring `createIndustry`: the admin's intent ("this name should
 * find this row") is already true, and the list below is the honest answer.
 */
export async function addIndustryAlias(industryId: string, name: string): Promise<ActionResult> {
  await requireAdmin();

  const parsedId = idSchema.safeParse(industryId);
  if (!parsedId.success) return { error: NOT_FOUND_ERROR };

  const parsed = industryAliasSchema.safeParse(name);
  if (!parsed.success) return { error: flattenZodError(parsed.error) };

  const industry = await db.industry.findUnique({ where: { id: parsedId.data } });
  if (!industry) return { error: NOT_FOUND_ERROR };

  const key = normalizeIndustryName(parsed.data);
  if (normalizeIndustryName(industry.name) === key) {
    return { error: `That is already the name of "${industry.name}".` };
  }

  const owner = await findNameOwner(key);
  if (owner) {
    // Already this row's alias: nothing to do, and nothing wrong either.
    if (owner.industryId === industry.id) return {};
    return { error: owner.conflict };
  }

  try {
    await db.industryAlias.create({ data: { name: parsed.data, industryId: industry.id } });
  } catch (error) {
    // Same check-then-act race the create/rename paths above document: two
    // admins adding the same alias at once both pass the check, and
    // IndustryAlias_name_lower_key decides. Losing that race to *this* row is
    // the no-op case again; losing it to another row is the real conflict.
    if (isUniqueConstraintError(error)) {
      const winner = await findNameOwner(key);
      if (winner?.industryId === industry.id) return {};
      return { error: winner?.conflict ?? `"${parsed.data}" already exists` };
    }
    throw error;
  }

  revalidateIndustryList();
  return {};
}

/**
 * Drops one alias. Nothing points at an alias -- no company, no document, no
 * printed field -- so this only narrows what a future import will match, and
 * needs neither a usage count nor a confirmation the way a rename or a merge
 * does.
 */
export async function deleteIndustryAlias(aliasId: string): Promise<ActionResult> {
  await requireAdmin();

  const parsedId = idSchema.safeParse(aliasId);
  if (!parsedId.success) return { error: NOT_FOUND_ERROR };

  const alias = await db.industryAlias.findUnique({ where: { id: parsedId.data } });
  if (!alias) return { error: NOT_FOUND_ERROR };

  await db.industryAlias.delete({ where: { id: alias.id } });

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
