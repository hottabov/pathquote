/**
 * Reads for the quote page's Revisions tab and email history (spec §5/§7).
 * Scoped like every other document read (`documentWhereForUser`) so a manager
 * only ever sees their own quote's history; a foreign id returns null, which
 * the page maps to nothing rendered rather than a leak.
 *
 * `createdById`/`sentById` are bare user ids (no FK — see the schema comment),
 * so the display names are resolved here in one `user.findMany` rather than a
 * per-row join.
 */
import { db } from "@/lib/db";
import { documentWhereForUser, type ScopeUser } from "@/lib/scope";

export interface QuoteRevisionRow {
  id: string;
  revision: number;
  label: string;
  total: string;
  pdfPath: string | null;
  signedPdfPath: string | null;
  createdAt: Date;
  createdByName: string | null;
  /** True for the revision the client actually signed (survives an admin void
   * as the legal record — see `Document.signedRevisionId`). */
  isSigned: boolean;
}

export interface QuoteHistory {
  revisions: QuoteRevisionRow[];
}

export async function getQuoteHistory(user: ScopeUser, documentId: string): Promise<QuoteHistory | null> {
  const document = await db.document.findFirst({
    where: { id: documentId, ...documentWhereForUser(user) },
    select: {
      signedRevisionId: true,
      revisions: {
        orderBy: { revision: "desc" },
        select: {
          id: true,
          revision: true,
          label: true,
          total: true,
          pdfPath: true,
          signedPdfPath: true,
          createdAt: true,
          createdById: true,
        },
      },
    },
  });
  if (!document) return null;

  const userIds = Array.from(new Set(document.revisions.map((r) => r.createdById)));
  const users = userIds.length
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  return {
    revisions: document.revisions.map((r) => ({
      id: r.id,
      revision: r.revision,
      label: r.label,
      total: r.total.toString(),
      pdfPath: r.pdfPath,
      signedPdfPath: r.signedPdfPath,
      createdAt: r.createdAt,
      createdByName: nameById.get(r.createdById) ?? null,
      isSigned: document.signedRevisionId === r.id,
    })),
  };
}
