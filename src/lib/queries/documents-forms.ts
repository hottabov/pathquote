import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { documentWhereForUser, type ScopeUser } from "@/lib/scope";

/**
 * The document as the production forms need it — a much narrower read than
 * the builder's, and deliberately so: these rows are printed for the
 * workshop, not priced.
 */

export const productionFormsInclude = {
  region: true,
  // `select`, not `true`: `author: true` would pull the whole User row --
  // passwordHash included -- into a payload that flows on to the form
  // renderer. The forms print one field, the salesperson's name. Same
  // narrowing getDocumentForBuilder does for the same reason.
  author: { select: { name: true } },
  company: { include: { industry: true } },
  contact: true,
  items: { orderBy: { sortOrder: "asc" }, include: { lines: true } },
  lines: { where: { itemId: null } },
} satisfies Prisma.DocumentInclude;

export type DocumentForForms = Prisma.DocumentGetPayload<{ include: typeof productionFormsInclude }>;

/**
 * A document loaded for production form rendering, scoped to the caller the
 * same way `getDocumentForBuilder` is.
 */
export async function getDocumentForForms(user: ScopeUser, documentId: string) {
  return db.document.findFirst({
    where: { id: documentId, ...documentWhereForUser(user) },
    include: productionFormsInclude,
  });
}
