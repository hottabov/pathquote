import type { DocumentStatus, SigningStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { documentWhereForUser, type ScopeUser } from "@/lib/scope";

export type DocumentListItem = {
  id: string;
  status: DocumentStatus;
  number: string | null;
  companyName: string | null;
  total: string;
  currency: string;
  /** The document's frozen `currencySymbol` (see `Document.currencySymbol`
   * in prisma/schema.prisma) — passed to `formatMoney` so a list row prints
   * the same symbol the document itself does. */
  currencySymbol: string | null;
  updatedAt: Date;
  /** `Document.signingStatus` — feeds the list's signing badge (see
   * `signingStatusLabel`, src/lib/signing/state.ts) beside the existing
   * DRAFT/FINAL one. `NOT_SENT` is the common case and renders nothing. */
  signingStatus: SigningStatus;
  /** Who wrote the quote — `User.name`, falling back to `User.email` when a
   * user has no name set (the same fallback the users list makes). Feeds the
   * list's `Salesperson` column, which is rendered for every role whose list
   * can hold more than one person's quotes (`canSeeSalesperson`,
   * src/lib/roles.ts) and omitted for a MANAGER.
   *
   * Always selected, never conditionally: the read is a join on an indexed FK
   * that is already loaded for the row, and making the SELECT depend on the
   * viewer's role would mean two shapes of `DocumentListItem` and a caller
   * that has to remember which one it got. The role decides what is
   * displayed, not what is fetched. */
  salespersonName: string;
};

/**
 * How many rows `listDocuments` returns unless told otherwise, and so how many
 * the /quotes page renders before offering "Show all". 200 is well past what a
 * salesperson scrolls through -- the search box is how anything older is
 * found -- while keeping the page's HTML and RSC payload bounded: the audit
 * measured ~7.5 KB per row before this limit existed, which at 600 quotes was
 * a 4.5 MB page for an admin.
 */
export const DOCUMENT_LIST_PAGE_SIZE = 200;

export type DocumentListPage = {
  rows: DocumentListItem[];
  /** Every document in the viewer's scope, counted with the same `where` the
   * rows were read with -- what the page compares `rows.length` against to
   * know whether there is more to show. */
  total: number;
};

/**
 * Documents visible to `user` — all for ADMIN, this region's for a
 * REGIONAL_MANAGER, own-only for MANAGER, all via `documentWhereForUser` —
 * newest-edited first, together with how many there are in all.
 *
 * `limit` bounds the rows (default `DOCUMENT_LIST_PAGE_SIZE`; `null` means
 * every row, which only the "Show all" action asks for) and `skip` is the
 * offset the "Show all" action continues from: the number of rows the browser
 * already holds. For an offset to mean anything the order has to be total, so
 * `id` breaks ties on `updatedAt` -- a seeded database writes many rows in
 * the same millisecond, and without the tiebreak two reads could disagree
 * about which of them fall either side of row 200. Postgres serves this as a
 * bounded top-N over the `[authorId, updatedAt]` / `[regionId, updatedAt]`
 * indexes with an incremental sort on `id` for the ties.
 */
export async function listDocuments(
  user: ScopeUser,
  params: { limit?: number | null; skip?: number } = {}
): Promise<DocumentListPage> {
  const limit = params.limit === undefined ? DOCUMENT_LIST_PAGE_SIZE : params.limit;
  const skip = params.skip ?? 0;

  const where = documentWhereForUser(user);

  const [documents, total] = await Promise.all([
    db.document.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      ...(limit === null ? {} : { take: limit }),
      ...(skip > 0 ? { skip } : {}),
      select: {
        id: true,
        status: true,
        number: true,
        total: true,
        currency: true,
        currencySymbol: true,
        updatedAt: true,
        signingStatus: true,
        company: { select: { name: true } },
        // `authorId` is a required column with an FK to User, so `author` is
        // never null -- unlike `company`, which is null until the builder's
        // client step. No `?.` needed below.
        author: { select: { name: true, email: true } },
      },
    }),
    db.document.count({ where }),
  ]);

  return {
    rows: documents.map((d) => ({
      id: d.id,
      status: d.status,
      number: d.number,
      companyName: d.company?.name ?? null,
      total: d.total.toString(),
      currency: d.currency,
      currencySymbol: d.currencySymbol,
      updatedAt: d.updatedAt,
      signingStatus: d.signingStatus,
      salespersonName: d.author.name ?? d.author.email,
    })),
    total,
  };
}
