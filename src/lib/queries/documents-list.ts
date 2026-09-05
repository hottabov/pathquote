import type { DocumentStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { documentWhereForUser, type ScopeUser } from "@/lib/scope";

export type DocumentListItem = {
  id: string;
  status: DocumentStatus;
  number: string | null;
  companyName: string | null;
  total: string;
  currency: string;
  updatedAt: Date;
};

/**
 * Documents visible to `user` (all for ADMIN, own-only for MANAGER, via
 * `documentWhereForUser`), optionally narrowed by a case-insensitive search
 * on the client company's name, newest-edited first. A document with no
 * client yet (`companyId` is null pre-Task-D-finalize) never matches a
 * non-empty `q`.
 */
export async function listDocuments(
  user: ScopeUser,
  params: { q?: string } = {}
): Promise<DocumentListItem[]> {
  const { q } = params;

  const where: NonNullable<Parameters<typeof db.document.findMany>[0]>["where"] = {
    ...documentWhereForUser(user),
  };

  if (q && q.trim()) {
    where.company = { name: { contains: q.trim(), mode: "insensitive" } };
  }

  const documents = await db.document.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      status: true,
      number: true,
      total: true,
      currency: true,
      updatedAt: true,
      company: { select: { name: true } },
    },
  });

  return documents.map((d) => ({
    id: d.id,
    status: d.status,
    number: d.number,
    companyName: d.company?.name ?? null,
    total: d.total.toString(),
    currency: d.currency,
    updatedAt: d.updatedAt,
  }));
}
