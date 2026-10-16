"use server";

// Saving the ACT! section of Settings -> Users -> <user>: which ACT! user this
// PathQuote user is (User.actUserId) and their Acc Mgr value (User.actAccountMgr),
// chosen by hand. Every decision is in src/lib/act/user-link.ts; this is
// requireAdmin, the reads, and the write.

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { revalidateUser } from "@/lib/revalidate";
import { idSchema } from "@/lib/validation/documents";
import { readActLinkLists } from "@/lib/act/user-link-read";
import {
  actUnreachableMessage,
  actUserHeldError,
  parseActLinkForm,
  validateActLink,
} from "@/lib/act/user-link";
import { NOT_FOUND_ERROR, type ActionResult } from "./_shared";

export type { ActionResult };

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Stores the ACT! user and the Acc Mgr value posted from the user page, as one
 * write of both columns. ADMIN/DEVELOPER only, as is the page.
 *
 * Nothing the browser sends is trusted as a list: ACT!'s users and its Rep
 * picklist are read again here (within ~10 s, readActLinkLists) and the pair is
 * refused unless the id is one of ACT!'s users and the Acc Mgr value is exactly
 * a Rep item -- an empty field clears its column. When ACT! cannot be read,
 * nothing is written. An ACT! user already stored on another PathQuote user is
 * refused with that user's name, before the write and again if the unique index
 * on actUserId catches a race.
 */
export async function setUserActLink(userId: string, formData: FormData): Promise<ActionResult> {
  await requireAdmin();

  const idParsed = idSchema.safeParse(userId);
  if (!idParsed.success) return { error: NOT_FOUND_ERROR };

  const parsed = parseActLinkForm({
    actUserId: formData.get("actUserId"),
    accountMgr: formData.get("accountMgr"),
  });
  if (!parsed.ok) return { error: parsed.error };

  const target = await db.user.findUnique({ where: { id: idParsed.data }, select: { id: true } });
  if (!target) return { error: NOT_FOUND_ERROR };

  const lists = await readActLinkLists(db);
  if (!lists.ok) return { error: actUnreachableMessage(lists.reason) };

  const holders = parsed.value.actUserId
    ? await db.user.findMany({
        where: { actUserId: parsed.value.actUserId, id: { not: target.id } },
        select: { id: true, name: true, email: true, actUserId: true },
      })
    : [];

  const verdict = validateActLink({
    userId: target.id,
    submission: parsed.value,
    actUsers: lists.actUsers,
    repItems: lists.repItems,
    otherUsers: holders,
  });
  if (!verdict.ok) return { error: verdict.error };

  try {
    await db.user.update({
      where: { id: target.id },
      data: { actUserId: verdict.value.actUserId, actAccountMgr: verdict.value.accountMgr },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error) || verdict.value.actUserId === null) throw error;
    // Another admin linked the same ACT! user between the check and the write.
    const holder = await db.user.findFirst({
      where: { actUserId: verdict.value.actUserId, id: { not: target.id } },
      select: { name: true, email: true },
    });
    return {
      error: holder
        ? actUserHeldError(holder)
        : "That ACT! user is already linked to another PathQuote user. Reload the page to see who.",
    };
  }

  revalidateUser(target.id);
  return {};
}
