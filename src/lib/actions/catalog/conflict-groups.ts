"use server";

import {
  revalidateConflictGroup,
  revalidateConflictGroupList,
  revalidateOption,
} from "@/lib/revalidate";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { compatDiff, conflictGroupNameSchema } from "@/lib/validation/catalog";
import { flattenZodError, type ActionResult } from "../_shared";

/**
 * Creates a new, empty `OptionConflictGroup` and redirects to its editor,
 * where an admin adds members -- mirrors `createOption`'s
 * create-then-redirect-to-detail shape. A group with no members yet is
 * legal but inert (see the model comment in schema.prisma), so there's
 * nothing unsafe about creating it before any member is chosen.
 */
export async function createConflictGroup(formData: FormData): Promise<ActionResult> {
  await requireAdmin();

  const parsed = conflictGroupNameSchema.safeParse(formData.get("name"));
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  const created = await db.optionConflictGroup.create({ data: { name: parsed.data } });

  revalidateConflictGroupList();
  redirect(`/settings/option-conflict-groups/${created.id}`);
}

/** Renames a conflict group -- the only field its own editor form has. */
export async function updateConflictGroupName(
  groupId: string,
  formData: FormData
): Promise<ActionResult> {
  await requireAdmin();

  const parsed = conflictGroupNameSchema.safeParse(formData.get("name"));
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  const existing = await db.optionConflictGroup.findUnique({ where: { id: groupId } });
  if (!existing) return { error: "Conflict group not found" };

  await db.optionConflictGroup.update({ where: { id: groupId }, data: { name: parsed.data } });

  revalidateConflictGroupList();
  revalidateConflictGroup(groupId);
  return {};
}

/**
 * Deletes a conflict group. Unlike `deleteProduct`/`deleteOption`, there's
 * no "used on a document" guard here -- a group (and its membership rows)
 * is purely a catalogue-admin concept that no `DocumentLine` ever
 * references, so removing one only stops a future `setItemOptions` from
 * treating its former members as conflicting; it can never orphan or
 * invalidate an existing document (see the "existing documents" note on
 * `setItemOptions` in actions/documents.ts).
 */
export async function deleteConflictGroup(groupId: string): Promise<ActionResult> {
  await requireAdmin();

  const existing = await db.optionConflictGroup.findUnique({ where: { id: groupId } });
  if (!existing) return { error: "Conflict group not found" };

  // Membership rows cascade (OptionConflictGroupMember.groupId is
  // onDelete: Cascade).
  await db.optionConflictGroup.delete({ where: { id: groupId } });

  revalidateConflictGroupList();
  redirect("/settings/option-conflict-groups");
}

/**
 * Sets a conflict group's members to exactly `optionIds`, diffing against
 * what's currently stored (same `compatDiff` "hand over the full desired
 * set, let the action diff it" shape `setOptionCompatibility`
 * (compatibility.ts) uses)
 * and only writing the delta. Unlike the old `setOptionConflicts` this
 * replaces, there's no pair-normalisation step and no self-conflict guard
 * to worry about -- a group's members are just a set, so "membership" has
 * no directionality and an option can't accidentally conflict with itself
 * by being listed once.
 *
 * Unknown ids in `optionIds` are silently ignored, mirroring
 * `setOptionCompatibility`'s handling of unknown series codes.
 */
export async function setConflictGroupMembers(
  groupId: string,
  optionIds: string[]
): Promise<ActionResult> {
  await requireAdmin();

  const group = await db.optionConflictGroup.findUnique({ where: { id: groupId } });
  if (!group) return { error: "Conflict group not found" };

  const [existingMembers, matchedOptions] = await Promise.all([
    db.optionConflictGroupMember.findMany({ where: { groupId }, select: { optionId: true } }),
    db.option.findMany({ where: { id: { in: optionIds } }, select: { id: true } }),
  ]);

  const currentIds = existingMembers.map((m) => m.optionId);
  const submittedIds = matchedOptions.map((o) => o.id);
  const { toAdd, toRemove } = compatDiff(currentIds, submittedIds);

  await db.$transaction([
    ...(toRemove.length > 0
      ? [db.optionConflictGroupMember.deleteMany({ where: { groupId, optionId: { in: toRemove } } })]
      : []),
    ...toAdd.map((optionId) => db.optionConflictGroupMember.create({ data: { groupId, optionId } })),
  ]);

  revalidateConflictGroup(groupId);
  revalidateConflictGroupList();
  // Every affected option's own editor page shows this group in its
  // read-only "Conflict groups" summary -- revalidate each so it doesn't
  // show stale membership after a save here.
  for (const optionId of [...toAdd, ...toRemove]) {
    revalidateOption(optionId);
  }
  return {};
}
