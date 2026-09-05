import type { OptionRole, Prisma } from "@prisma/client";
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
  items: {
    orderBy: { sortOrder: "asc" },
    include: {
      lines: true,
      // The three facts a form reads off the product: which form it prints
      // on, what kind of thing it is (software is gathered for the PathWorks
      // boxes) and its physical specs (model tier, width). Live off the
      // product, not snapshotted on the item.
      product: { select: { kind: true, form: true, specs: true } },
    },
  },
  lines: { where: { itemId: null } },
} satisfies Prisma.DocumentInclude;

/** The catalogue facts a form reads off an OPTION line's option. */
export type FormOptionRow = {
  id: string;
  role: OptionRole | null;
  unitLengthM: number | null;
};

export type DocumentForForms = Prisma.DocumentGetPayload<{ include: typeof productionFormsInclude }> & {
  /**
   * `Option` rows for every OPTION line's `refId` on the document, keyed by
   * id. `DocumentLine.refId` is a plain string with no relation, so the join
   * is done here in one query rather than left to the form context to do per
   * line. A line whose option no longer exists simply has no entry.
   */
  optionsById: Record<string, FormOptionRow>;
};

/**
 * A document loaded for production form rendering, scoped to the caller the
 * same way `getDocumentForBuilder` is.
 */
export async function getDocumentForForms(user: ScopeUser, documentId: string): Promise<DocumentForForms | null> {
  const document = await db.document.findFirst({
    where: { id: documentId, ...documentWhereForUser(user) },
    include: productionFormsInclude,
  });
  if (!document) return null;

  const refIds = Array.from(
    new Set(
      document.items
        .flatMap((item) => item.lines)
        .concat(document.lines)
        .filter((line) => line.kind === "OPTION" && line.refId !== null)
        .map((line) => line.refId as string)
    )
  );
  const options =
    refIds.length > 0
      ? await db.option.findMany({
          where: { id: { in: refIds } },
          select: { id: true, role: true, unitLengthM: true },
        })
      : [];

  return {
    ...document,
    optionsById: Object.fromEntries(
      options.map((option) => [
        option.id,
        {
          id: option.id,
          role: option.role,
          unitLengthM: option.unitLengthM === null ? null : Number(option.unitLengthM),
        },
      ])
    ),
  };
}
