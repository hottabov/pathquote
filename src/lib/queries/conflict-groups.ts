import { cache } from "react";
import { db } from "@/lib/db";

// Admin reads for /settings/option-conflict-groups — the settings-area
// analogue of src/lib/queries/catalog-visibility-admin.ts, kept as its own
// module for the same reason that file is: these are admin-only reads for a
// settings screen, not something a catalogue/builder query needs.

export type ConflictGroupListItem = {
  id: string;
  name: string;
  memberCount: number;
};

/**
 * Every conflict group, ordered by name, with how many options are in each
 * — feeds the /settings/option-conflict-groups index list so an admin can
 * see at a glance which groups actually block anything (a 0- or 1-member
 * group is legal but inert — see the `OptionConflictGroup` model comment in
 * schema.prisma) before opening one.
 */
export async function listConflictGroups(): Promise<ConflictGroupListItem[]> {
  const groups = await db.optionConflictGroup.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { members: true } } },
  });

  return groups.map((g) => ({ id: g.id, name: g.name, memberCount: g._count.members }));
}

export type ConflictGroupDetail = {
  id: string;
  name: string;
  memberIds: string[];
};

/** A single conflict group (by id) with its current member option ids, for
 * the group's own editor page — which reads it in `generateMetadata` and
 * again in the page body, hence the request memo. */
export const getConflictGroupDetail = cache(async function getConflictGroupDetail(
  groupId: string
): Promise<ConflictGroupDetail | null> {
  const group = await db.optionConflictGroup.findUnique({
    where: { id: groupId },
    include: { members: { select: { optionId: true } } },
  });
  if (!group) return null;

  return {
    id: group.id,
    name: group.name,
    memberIds: group.members.map((m) => m.optionId),
  };
});
