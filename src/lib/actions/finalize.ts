"use server";

import { describeIssues, productionIssues } from "@/lib/production-forms/readiness";
import { revalidateDocument, revalidateDocumentList } from "@/lib/revalidate";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireAdmin, requireSession } from "@/lib/authz";
import { documentWhereForUser } from "@/lib/scope";
import { idSchema } from "@/lib/validation/documents";
import { validateFinalizable, type FinalizableDocument } from "@/lib/validation/finalize";
import { recalcDocument } from "@/lib/documents/recalc";
import { allocateNumber, formatDocNumber } from "@/lib/numbering";
import { getQuoteValidityDays } from "@/lib/queries/settings";
import { getDocumentForBuilder } from "@/lib/queries/documents";
import { getQuoteDocumentsForRegion } from "@/lib/queries/quote-documents";
import { buildQuotationData, resolveQuoteDocuments, type DocumentsSnapshot } from "@/lib/quotation-data";
import { canAccept, canUnfinalize, signatureRolesClearedBy } from "@/lib/signing/state";
import {
  buildAndHashRevisionSnapshot,
  documentToRevisionSnapshotInput,
} from "@/lib/documents/revision-snapshot";
import { planRevision, revisionLabel } from "@/lib/documents/revision-plan";
import { generateRevisionPdf } from "@/lib/documents/revision";
import { NOT_FOUND_ERROR } from "./_shared";

/** Thrown inside `finalizeDocument`'s `$transaction` to roll it back when
 * `validateFinalizable` refuses the document, carrying that check's own
 * message so the catch site can hand it straight back as `{ error }` — the
 * same sentinel-error shape the mutating actions in
 * src/lib/actions/documents.ts use to reject a save from inside a
 * transaction, needed here for the same reason: the validation now runs
 * against a recalc that happens *within* the transaction, so refusing it
 * means unwinding work already done rather than simply returning. */
class NotFinalizableError extends Error {}

export type FinalizeResult = { ok: true; number: string } | { error: string };
export type UnfinalizeResult = { ok: true } | { error: string };
export type VoidSignatureResult = { ok: true } | { error: string };
export type AcceptResult = { ok: true } | { error: string };

// Module-private, not exported: a "use server" file may only export async
// functions (Next enforces this), and nothing outside this file needs these.
const VOID_REASON_REQUIRED = "A reason is required to void a signature.";
const NOT_SIGNED_TO_VOID = "This quote has no client signature to void.";

// Re-exported so callers of this action module (and its own tests) can reach
// the pure eligibility check without a second import — the implementation
// lives in src/lib/validation/finalize.ts purely so it can be unit tested
// without pulling in `@/lib/db` (see that file's header comment).
export { validateFinalizable, type FinalizableDocument };

// --- finalize ----------------------------------------------------------------

/**
 * Turns a DRAFT into a numbered, immutable-going-forward FINAL document:
 * recalculates totals (and, crucially, checks the violations that comes
 * back — see the NOTE on `recalcDocument`), validates the document is
 * actually finalizable, then atomically allocates a display number (or
 * reuses the existing one, for a document that was previously finalized and
 * then unfinalized — see `unfinalizeDocument`) and freezes an
 * `entitySnapshot` from the document's region so a FINAL document's
 * rendering never has to query `Region` again (a later admin edit to the
 * region's bank details/logo/etc. must never retroactively change an
 * already-issued document).
 *
 * A `documentsSnapshot` is frozen in the same write, for the same reason one
 * step further out: the legal text itself. Fixing a typo in General
 * Conditions used to rewrite the PDF of every quote already signed. Both
 * snapshots, the number and the three commission columns land in one
 * `updateMany`, so a quote can never be FINAL without them.
 */
export async function finalizeDocument(documentId: string): Promise<FinalizeResult> {
  const session = await requireSession();

  const parsedId = idSchema.safeParse(documentId);
  if (!parsedId.success) return { error: NOT_FOUND_ERROR };

  const document = await db.document.findFirst({
    where: { id: parsedId.data, status: "DRAFT", ...documentWhereForUser(session.user) },
    include: {
      items: { include: { lines: true } },
      lines: { where: { itemId: null } },
      company: true,
      contact: true,
      region: true,
    },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  // Every document carries a validity window. A draft may already carry its
  // own override (see `setValidityDays` in actions/documents.ts — a
  // salesperson giving one customer a longer capex-approval window); only
  // when it doesn't do we fall back to the org-wide default (read once here;
  // that fallback applies both when the Setting row is missing and when its
  // value isn't a finite number — see getQuoteValidityDays).
  const validityDays = document.validityDays ?? (await getQuoteValidityDays());

  const entitySnapshot = {
    entityName: document.region.entityName,
    entityLegalId: document.region.entityLegalId,
    entityAddress: document.region.entityAddress,
    bankDetails: document.region.bankDetails,
    logoUrl: document.region.logoUrl,
    footerText: document.region.footerText,
    regionCode: document.region.code,
    currency: document.currency,
    taxName: document.taxName,
    taxRate: document.taxRate.toString(),
  };

  // Recalculation, validation, number allocation and the FINAL update all
  // happen inside one interactive transaction: if any of it fails (e.g. the
  // validation below refusing the document, an extremely unlikely `number`
  // unique-constraint collision, or the concurrent-finalize guard tripping),
  // the whole transaction — counter increment and recomputed totals included
  // — rolls back rather than leaving an allocated counter value that was
  // never actually assigned to a document. The allocation must stay ordered
  // *before* the guarded update (both still inside this same interactive
  // txn): if the update's status guard fails and throws, the txn rolls back
  // and undoes the counter increment along with it, so a lost race never
  // burns a number.
  //
  // The recalc in particular has to be in here rather than ahead of the
  // transaction, where it used to sit: an item mutation committing in the gap
  // between a recalc outside and the write in here would have been finalized
  // with the totals as they stood *before* it — a number issued against money
  // the document no longer adds up to. Inside, the recalc's own write to the
  // document row holds it for the rest of the transaction, and every mutating
  // action's draft guard (`assertStillDraft`, src/lib/actions/documents.ts)
  // meets that same lock and rolls back rather than editing a document this
  // is in the middle of finalizing.
  let result: { number: string; revisionId: string | null };
  try {
    result = await db.$transaction(async (tx) => {
      // Recompute totals first (a discount cap may have been lowered since
      // this was last saved) and check the violations it reports before
      // allowing the document to become FINAL. `negativeSubtotal` isn't
      // consulted here — the mutating actions in documents.ts already refuse
      // to save a change that would produce one (see NegativeSubtotalError
      // there), so a DRAFT reaching this point should never carry one;
      // rejecting finalize on it is a later task's concern (see the P0 plan's
      // validity-fields task), not this one's. `commission` — the same
      // `RecalcResult.commission` `getDocumentForBuilder` shows live for a
      // draft — is what gets frozen onto the document below.
      const { violations, documentConcession, commission } = await recalcDocument(document.id, tx);

      // Eligibility is judged on the document as it stands *under* the lock
      // the recalc above just took, not on the copy loaded before the
      // transaction opened: an item removed, or a client cleared, in the gap
      // between the two would otherwise be validated as though it were still
      // there — the same staleness the recalc itself was moved in here to
      // avoid. From this point nothing else can change either set (a mutating
      // action's draft guard blocks on the row the recalc just wrote), so this
      // read is the last word.
      const current = await tx.document.findUnique({
        where: { id: document.id },
        select: {
          companyId: true,
          items: { select: { id: true } },
          lines: { where: { itemId: null }, select: { itemId: true } },
        },
      });
      if (!current) throw new NotFinalizableError(NOT_FOUND_ERROR);

      const validationError = validateFinalizable(
        { companyId: current.companyId, items: current.items, lines: current.lines },
        violations,
        documentConcession,
        session.user.role,
        document.region.name,
        document.currency,
        document.currencySymbol
      );
      if (validationError) throw new NotFinalizableError(validationError);

      // Production readiness: nothing becomes FINAL while an item's order
      // form would print incomplete (a missing knife size, drills ticked with
      // no detail, an MTS with no travel distance). Same check the builder's
      // Finalize button shows before the click -- see readiness.ts.
      const productionItems = await tx.documentItem.findMany({
        where: { documentId: document.id },
        orderBy: { sortOrder: "asc" },
        select: {
          code: true,
          productionSpec: true,
          product: { select: { form: true } },
          lines: { where: { kind: "OPTION" }, select: { refId: true, attributes: true } },
        },
      });
      const optionRefIds = productionItems.flatMap((item) =>
        item.lines.map((line) => line.refId).filter((id): id is string => id !== null)
      );
      const optionRoles = new Map(
        (optionRefIds.length > 0
          ? await tx.option.findMany({ where: { id: { in: optionRefIds } }, select: { id: true, role: true } })
          : []
        ).map((option) => [option.id, option.role])
      );
      const issues = productionIssues(
        productionItems.map((item) => ({
          code: item.code,
          form: item.product?.form ?? null,
          productionSpec: item.productionSpec,
          options: item.lines.map((line) => ({
            role: line.refId ? (optionRoles.get(line.refId) ?? null) : null,
            attributes: line.attributes,
          })),
        }))
      );
      if (issues.length > 0) {
        throw new NotFinalizableError(`Complete the production details first — ${describeIssues(issues)}`);
      }

      // Frozen alongside entitySnapshot above — see Document.commissionAmount's
      // doc comment (schema.prisma) for the full reasoning. `null` across all
      // three when `commission` itself is null (no commission-tier table
      // configured at finalize time), preserving the "unconfigured, not $0.00"
      // distinction rather than collapsing it. Re-finalizing (after
      // unfinalizeDocument) reaches this same code path again and overwrites
      // whatever was frozen before with a fresh computation — there is no
      // "keep the old commission" option, the same as entitySnapshot itself.
      const commissionFields = {
        commissionAmount: commission ? new Prisma.Decimal(commission.amount) : null,
        commissionRatePct: commission ? new Prisma.Decimal(commission.ratePct) : null,
        commissionBase: commission ? new Prisma.Decimal(commission.base) : null,
      };

      // Re-finalizing a document that was unfinalized keeps its original
      // number (unfinalizeDocument never clears it) instead of burning a new
      // counter value.
      let resolvedNumber = document.number;
      if (!resolvedNumber) {
        // Year is derived from the server's current date (Australia/Melbourne
        // TZ isn't threaded through explicitly — `new Date().getFullYear()` is
        // accepted per plan; revisit if this ever runs in a non-AU-local
        // deployment near a year boundary).
        const year = new Date().getFullYear();
        const counter = await allocateNumber(tx, document.region.code, year);
        resolvedNumber = formatDocNumber(document.region.code, year, counter);
      }

      // The issue date is written below and also feeds `{{validityDate}}` in
      // the documents frozen just after, so it is resolved once here rather
      // than inline in the update — two `new Date()` calls would put a
      // "valid until" in the frozen Terms that the document's own issue date
      // disagrees with by a millisecond's worth of rounding.
      const issuedAt = new Date();

      // Every legal document and every item's category copy, substituted and
      // rendered exactly as the preview renders them — because it IS the
      // preview: `buildQuotationData` is the only thing in this app that
      // knows how to turn a document plus its region's `QuoteDocument` rows
      // into printed text, and a second implementation here would be two
      // definitions of what this quote says the day it stops being editable.
      //
      // Both reads take `tx`, so they see the totals `recalcDocument` wrote
      // moments ago inside this transaction — item prices feed `{{price}}` in
      // a category's copy, and a snapshot built from the pre-recalc row would
      // freeze a price the document no longer adds up to.
      //
      // Four fields are overridden on the way in, because the row this reads
      // is still the DRAFT and the snapshot must describe the FINAL quote:
      // the number and issue date the update below is about to write (both
      // are document tokens), the resolved `validityDays` behind
      // `{{validityDate}}`, and the `entitySnapshot` behind `{{bankDetails}}`.
      // `documentsSnapshot` is forced to null so a re-finalize renders live
      // text rather than replaying the snapshot the previous finalize left in
      // the column — that is what makes an admin's unfinalize/edit/finalize
      // cycle pick up the edit.
      const forSnapshot = await getDocumentForBuilder(session.user, document.id, tx);
      if (!forSnapshot) throw new NotFinalizableError(NOT_FOUND_ERROR);
      const quoteDocuments = await getQuoteDocumentsForRegion(forSnapshot.regionId, tx);
      const quotation = buildQuotationData(
        {
          ...forSnapshot,
          status: "FINAL",
          number: resolvedNumber,
          issueDate: issuedAt,
          validityDays,
          entitySnapshot,
          documentsSnapshot: null,
        },
        quoteDocuments
      );

      // Every item gets an entry, including one whose category has no copy or
      // whose copy was stripped to nothing (`""` — which `buildQuotationData`
      // reads back as "this item printed nothing"). Freezing only the items
      // that printed something would leave the rest falling back to live copy,
      // so writing a category's first-ever quote description would make it
      // appear on a quote signed before it existed — the same leak the
      // snapshot exists to close. A *missing* entry still falls back to live,
      // deliberately, for a snapshot written by an older version of this code.
      const documentsSnapshot: DocumentsSnapshot = {
        version: 1,
        documents: quotation.documents.map((doc) => ({
          key: doc.key,
          title: doc.title,
          bodyHtml: doc.bodyHtml,
        })),
        itemCopyHtml: Object.fromEntries(
          quotation.machineSections.map((section) => [section.itemId, section.titleBlockHtml ?? ""])
        ),
      };

      // --- Revision snapshot (spec §5) ------------------------------------
      // Freeze a self-contained, catalogue-independent description of
      // everything the sheet renders from (buildRevisionSnapshot,
      // src/lib/documents/revision-snapshot.ts) and hash it. The RAW,
      // pre-substitution document bodies go in — never the date-substituted
      // `documentsSnapshot` above — so the hash depends on content alone and a
      // no-op unfinalize→finalize hashes identically. Totals are read fresh
      // from the row `recalcDocument` just wrote, not from the pre-transaction
      // `document` copy which predates the recalc.
      const freshTotals = await tx.document.findUnique({
        where: { id: document.id },
        select: { subtotal: true, taxAmount: true, total: true },
      });
      if (!freshTotals) throw new NotFinalizableError(NOT_FOUND_ERROR);

      // Resolve the included legal documents exactly as buildQuotationData
      // does (resolveQuoteDocuments → included-and-not-excluded → sortOrder),
      // keeping the RAW body so the hash never depends on the per-finalize
      // date `{{validityDate}}` would bake in. The rest of the projection is
      // shared with the backfill via documentToRevisionSnapshotInput.
      const excludedKeys = new Set(forSnapshot.excludedDocumentKeys);
      const resolvedDocuments = Array.from(
        resolveQuoteDocuments(quoteDocuments, forSnapshot.regionId).values()
      )
        .filter((row) => row.includedByDefault && !excludedKeys.has(row.key))
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((row) => ({ key: row.key, title: row.title, body: row.body }));

      const snapshotInput = documentToRevisionSnapshotInput({
        document,
        entity: entitySnapshot,
        totals: freshTotals,
        validityDays,
        documents: resolvedDocuments,
      });

      const { snapshot, snapshotHash } = buildAndHashRevisionSnapshot(snapshotInput);

      const lastRevision = await tx.quoteRevision.findFirst({
        where: { documentId: document.id },
        orderBy: { revision: "desc" },
        select: { revision: true, snapshotHash: true },
      });
      const plan = planRevision({
        lastRevision: lastRevision?.revision ?? null,
        lastSnapshotHash: lastRevision?.snapshotHash ?? null,
        newSnapshotHash: snapshotHash,
      });
      const label = revisionLabel(resolvedNumber, plan.revision) ?? resolvedNumber;

      // Only mint a row when the content actually changed (plan.create). A
      // no-op re-finalize keeps the number and adds nothing — the whole point
      // of the hash. `createdRevisionId` drives the post-commit PDF below.
      let createdRevisionId: string | null = null;
      if (plan.create) {
        const created = await tx.quoteRevision.create({
          data: {
            documentId: document.id,
            revision: plan.revision,
            label,
            snapshot: snapshot as unknown as Prisma.InputJsonValue,
            snapshotHash,
            total: freshTotals.total,
            createdById: session.user.id,
          },
          select: { id: true },
        });
        createdRevisionId = created.id;
      }

      // A finalize is a lifecycle event worth recording (spec §2/§5): the
      // reason field stays null here (finalize needs no reason), meta carries
      // the resolved revision so the history reads without a join.
      await tx.quoteEvent.create({
        data: {
          documentId: document.id,
          type: "FINALIZED",
          actorId: session.user.id,
          meta: { revision: plan.revision, label, created: plan.create },
        },
      });

      // Guard against a concurrent finalize (e.g. a double-click, or two
      // requests racing) with a status-scoped `updateMany` instead of an
      // unconditional `update`: if another request already flipped this
      // document to FINAL between our `findFirst` above and here, `count`
      // comes back 0 and we throw to roll back the whole transaction —
      // including the number allocation and the revision row above.
      const res = await tx.document.updateMany({
        where: { id: document.id, status: "DRAFT" },
        data: {
          status: "FINAL",
          number: resolvedNumber,
          issueDate: issuedAt,
          validityDays,
          revision: plan.revision,
          finalizedAt: issuedAt,
          finalizedById: session.user.id,
          entitySnapshot: entitySnapshot as Prisma.InputJsonValue,
          documentsSnapshot: documentsSnapshot as Prisma.InputJsonValue,
          ...commissionFields,
        },
      });
      if (res.count !== 1) throw new Error("ALREADY_FINALIZED");

      return { number: resolvedNumber, revisionId: createdRevisionId };
    });
  } catch (err) {
    if (err instanceof NotFinalizableError) return { error: err.message };
    if (err instanceof Error && err.message === "ALREADY_FINALIZED") {
      return { error: "Document was already finalized" };
    }
    throw err;
  }

  // Best-effort: render and store this revision's PDF outside the transaction
  // so a Gotenberg failure can never roll back an issued quote (spec §5.4). A
  // null pdfPath just means "not generated yet", regenerable later.
  if (result.revisionId) {
    await generateRevisionPdf(session.user, document.id, result.revisionId).catch((err) => {
      console.error("[finalize] revision PDF generation failed", {
        documentId: document.id,
        revisionId: result.revisionId,
        err,
      });
    });
  }

  revalidateDocumentList();
  revalidateDocument(document.id);

  return { ok: true, number: result.number };
}

// --- unfinalize (owner or admin, before the client signs) --------------------

/**
 * Reopens a FINAL quote for editing (spec §4): flips it back to DRAFT, but
 * deliberately keeps `number`, `entitySnapshot`, and the frozen `commission*`
 * columns set —
 * re-finalizing (see above) reuses the existing number rather than
 * allocating a new one, so a document can never accumulate more than one
 * number across an unfinalize/finalize cycle. The stale `commission*`
 * values sitting in the row are harmless: `getDocumentForBuilder`
 * (src/lib/queries/documents.ts) only ever reads them for a `status ===
 * "FINAL"` document, so the moment this flips the status back to DRAFT the
 * builder immediately falls back to computing commission live again,
 * regardless of what's still sitting in those columns — they're simply
 * overwritten with a fresh computation the next time `finalizeDocument`
 * runs (same as `entitySnapshot` and `documentsSnapshot`), never read in
 * between.
 *
 * `documentsSnapshot` is the deliberate exception, and is CLEARED here. The
 * asymmetry is the point: `number`, `entitySnapshot` and the `commission*`
 * columns describe the IDENTITY of the issued quote and are reused when it is
 * re-finalized, whereas the snapshot describes what it PRINTED — and printing
 * is exactly what reopening a quote is meant to change. `buildQuotationData`
 * prefers a parsed snapshot whatever the status, so leaving one behind made a
 * reopened quote uneditable in every way that matters:
 *
 *  - an admin fixing a typo in General Conditions saw no change in the
 *    preview or the draft PDF, because the frozen bodies still won;
 *  - worse with money — a salesperson applying a discount got a page showing
 *    the PRE-discount figure, because `titleBlockHtml` came from the frozen
 *    `itemCopyHtml` with the old `{{price}}` baked in while `hasInlinePrice`
 *    was computed from the live copy, which then suppressed the live
 *    `sectionPrice` beside it;
 *  - the D6 stripped-token banner went quiet, since nothing is reported for a
 *    frozen item.
 *
 * Nothing is lost by clearing it: `finalizeDocument` rebuilds the snapshot
 * from live text on every finalize, so the re-finalize that closes this cycle
 * writes a fresh one. D7's guarantee ("legal text is frozen into the quote at
 * FINAL") is untouched — the quote is DRAFT at this moment, and a DRAFT has
 * never been the thing that must not change.
 *
 * Access (spec §3/§4): the OWNER (a manager on their own quote) or an ADMIN,
 * and only before the client has signed. Ownership is enforced by
 * `documentWhereForUser` in the load below — a manager who isn't the author
 * simply gets `null` → NOT_FOUND — and `canUnfinalize` refuses a SIGNED quote
 * for everyone (a signed quote is reopened only by an admin's `voidSignature`,
 * which keeps the signed revision as a legal record). Reopening a quote that
 * was already SENT sets `hasUnsentChanges` so the page can warn that the
 * client is holding a version that no longer matches; `reason` is optional
 * (making it mandatory would only breed "." — spec §4.4).
 */
export async function unfinalizeDocument(
  documentId: string,
  reason?: string
): Promise<UnfinalizeResult> {
  const session = await requireSession();

  const parsedId = idSchema.safeParse(documentId);
  if (!parsedId.success) return { error: NOT_FOUND_ERROR };

  const document = await db.document.findFirst({
    where: { id: parsedId.data, status: "FINAL", ...documentWhereForUser(session.user) },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  // A SIGNED quote cannot be reopened by anyone through this path — see
  // `canUnfinalize`. Every other immutability guarantee already comes from the
  // `status: "DRAFT"` clause every editing action carries (see
  // src/lib/actions/documents/_internal.ts), which is what makes FINAL
  // immutable today.
  const verdict = canUnfinalize(document.signingStatus);
  if (!verdict.ok) return { error: verdict.reason };

  // A version already out with the client (SENT or VIEWED) means the copy in
  // their inbox is about to stop matching the quote — flagged so the page can
  // show the "changes not yet sent" banner until a resend clears it.
  const wasSent = document.signingStatus === "SENT" || document.signingStatus === "VIEWED";

  // Reopening an issued quote is consequential: it un-issues a numbered
  // document, and the next finalize overwrites the entity snapshot, the
  // documents snapshot and the commission columns with whatever is true then.
  // The durable record is now the QuoteEvent written in the transaction below;
  // this grep-able server-log line (prefix "[finalize] unfinalize") stays for
  // operational visibility.
  console.warn("[finalize] unfinalize: FINAL document returned to DRAFT", {
    documentId: document.id,
    documentNumber: document.number,
    actorId: session.user.id,
    wasSent,
  });

  // The content is about to become editable again, so everything that
  // referenced it stops being true: outstanding links point at a quote that
  // is no longer the one that was sent, and the author signed text that is
  // about to change.
  await db.$transaction(async (tx) => {
    await tx.signingRequest.updateMany({
      where: { documentId: document.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Both roles, not just the author: the text is about to change, so
    // neither party signed what will exist afterwards. Which roles an event
    // invalidates is decided by `signatureRolesClearedBy` (src/lib/signing/state.ts),
    // beside the other transition rules, rather than being re-derived here
    // and in `revokeSigningLink` (src/lib/actions/signing.ts).
    await tx.signature.deleteMany({
      where: { documentId: document.id, role: { in: signatureRolesClearedBy("unfinalize") } },
    });
    await tx.document.update({
      where: { id: document.id },
      // `documentsSnapshot` cleared — see the doc comment above: the frozen
      // bodies would otherwise keep winning over the live text this quote was
      // reopened to edit. `Prisma.DbNull` rather than `null`, which a
      // `Json?` column does not accept: it must be a SQL NULL, the one thing
      // `readDocumentsSnapshot` reads back as "no snapshot". Cleared in the
      // same write that flips the status, so a quote is never DRAFT while
      // still carrying what it printed. `hasUnsentChanges` is set only when a
      // version was actually out with the client.
      data: {
        status: "DRAFT",
        signingStatus: "NOT_SENT",
        documentsSnapshot: Prisma.DbNull,
        ...(wasSent ? { hasUnsentChanges: true } : {}),
      },
    });
    await tx.quoteEvent.create({
      data: {
        documentId: document.id,
        type: "UNFINALIZED",
        actorId: session.user.id,
        reason: reason?.trim() ? reason.trim() : null,
        meta: { wasSent },
      },
    });
  });

  revalidateDocumentList();
  revalidateDocument(document.id);

  return { ok: true };
}

// --- voidSignature (admin only) ----------------------------------------------

/**
 * ADMIN-only (spec §6): annuls a client's signature on a CLIENT_SIGNED quote
 * and reopens it to DRAFT, so a signature captured in error (wrong version,
 * wrong signatory, a client who says they didn't mean to) can be undone —
 * something `unfinalizeDocument` deliberately refuses for a SIGNED quote.
 *
 * The signed revision is a permanent legal record and is NEVER destroyed:
 * `signedRevisionId` is left pointing at the QuoteRevision the client signed,
 * that QuoteRevision row (its snapshot and its signed PDF) stays in the
 * database, and only the live CLIENT/AUTHOR `Signature` rows are cleared (the
 * text is about to change, so neither party's signature is a signature of what
 * will exist afterwards). `reason` is MANDATORY — a void is exactly the event
 * where "why" matters — and recorded as a SIGNATURE_VOIDED QuoteEvent.
 * `hasUnsentChanges` is set: the client is holding a version that has just
 * been un-signed under them.
 */
export async function voidSignature(documentId: string, reason: string): Promise<VoidSignatureResult> {
  const session = await requireAdmin();

  const parsedId = idSchema.safeParse(documentId);
  if (!parsedId.success) return { error: NOT_FOUND_ERROR };

  const trimmedReason = reason?.trim() ?? "";
  if (trimmedReason === "") return { error: VOID_REASON_REQUIRED };

  const document = await db.document.findFirst({
    where: { id: parsedId.data, status: "FINAL", ...documentWhereForUser(session.user) },
  });
  if (!document) return { error: NOT_FOUND_ERROR };
  if (document.signingStatus !== "SIGNED") return { error: NOT_SIGNED_TO_VOID };

  console.warn("[finalize] voidSignature: client signature annulled", {
    documentId: document.id,
    documentNumber: document.number,
    adminUserId: session.user.id,
  });

  await db.$transaction(async (tx) => {
    // Clear both live signatures (the quote is going back to DRAFT), but NOT
    // `signedRevisionId` and NOT the QuoteRevision it points at — that is the
    // legal trail the spec (§6) insists survives a void forever.
    await tx.signature.deleteMany({
      where: { documentId: document.id, role: { in: signatureRolesClearedBy("unfinalize") } },
    });
    await tx.document.update({
      where: { id: document.id },
      data: {
        status: "DRAFT",
        signingStatus: "NOT_SENT",
        hasUnsentChanges: true,
        documentsSnapshot: Prisma.DbNull,
      },
    });
    await tx.quoteEvent.create({
      data: {
        documentId: document.id,
        type: "SIGNATURE_VOIDED",
        actorId: session.user.id,
        reason: trimmedReason,
        meta: { signedRevisionId: document.signedRevisionId },
      },
    });
  });

  revalidateDocumentList();
  revalidateDocument(document.id);

  return { ok: true };
}

// --- acceptQuote (owner or admin) --------------------------------------------

/**
 * Accepts a client-signed quote into production (CLIENT_SIGNED → ACCEPTED,
 * spec §1). Owner or admin (scoped by `documentWhereForUser`). Gated by
 * `canAccept`: the client must have signed AND the manager (AUTHOR Signature)
 * must have signed too — accepting is the manager committing the deal, and a
 * quote goes into production with both signatures on it. Sets `acceptedAt`/
 * `acceptedById`; the quote stays FINAL/SIGNED (ACCEPTED is derived from
 * `acceptedAt` being set — see the schema comment on the status mapping).
 */
export async function acceptQuote(documentId: string): Promise<AcceptResult> {
  const session = await requireSession();

  const parsedId = idSchema.safeParse(documentId);
  if (!parsedId.success) return { error: NOT_FOUND_ERROR };

  const document = await db.document.findFirst({
    where: { id: parsedId.data, status: "FINAL", ...documentWhereForUser(session.user) },
    include: { signatures: { where: { role: "AUTHOR" }, select: { id: true } } },
  });
  if (!document) return { error: NOT_FOUND_ERROR };
  if (document.acceptedAt) return { ok: true }; // idempotent: already accepted

  const verdict = canAccept({
    signingStatus: document.signingStatus,
    hasAuthorSignature: document.signatures.length > 0,
  });
  if (!verdict.ok) return { error: verdict.reason };

  const now = new Date();
  await db.$transaction(async (tx) => {
    // Guard the transition with a status/acceptance-scoped updateMany so two
    // concurrent accepts don't both write an event.
    const res = await tx.document.updateMany({
      where: { id: document.id, status: "FINAL", signingStatus: "SIGNED", acceptedAt: null },
      data: { acceptedAt: now, acceptedById: session.user.id },
    });
    if (res.count !== 1) throw new Error("ALREADY_ACCEPTED");
    await tx.quoteEvent.create({
      data: { documentId: document.id, type: "ACCEPTED", actorId: session.user.id },
    });
  }).catch((err) => {
    if (err instanceof Error && err.message === "ALREADY_ACCEPTED") return;
    throw err;
  });

  revalidateDocumentList();
  revalidateDocument(document.id);

  return { ok: true };
}
