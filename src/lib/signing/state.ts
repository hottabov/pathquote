/**
 * Every "may this happen?" question the signing feature asks, as pure
 * functions over plain values.
 *
 * The server actions in src/lib/actions/signing.ts and signing-client.ts
 * are deliberately thin wrappers around these: the actions know how to read
 * and write rows, this module knows the rules, and only this module is unit
 * tested (the suite has no database — see vitest.config.ts).
 *
 * `SigningStatus` is re-declared here as a string union rather than
 * imported from `@prisma/client` so the module stays free of generated
 * types and can be imported by tests without a `prisma generate` having
 * run. The two are kept in step by `tests/signing-status-parity.test.ts`.
 */
import { isDeveloperRole } from "@/lib/roles";

export type SigningStatus = "NOT_SENT" | "SENT" | "VIEWED" | "SIGNED" | "DECLINED";

/** Use `Verdict` when a function can fail for more than one reason and the
 * caller needs to know which one, so it can show that reason to the user
 * (canSendToClient, canUnfinalize). Use a bare `boolean` when there is
 * exactly one failure mode, since the caller already knows what it means and
 * can supply its own message in context (canRevoke, canComplete, canDecline). */
export type Verdict = { ok: true } | { ok: false; reason: string };

export const NOT_FINAL = "Finalize the quote before signing it.";
export const NO_CONTACT_EMAIL = "This quote's contact has no email address.";
export const ALREADY_IN_FLIGHT = "This quote is already with the client. Revoke the link first.";
export const SIGNED_IS_FINAL = "A signed quote cannot be reopened. Create a new quote instead.";
export const NOT_CLIENT_SIGNED = "The client hasn't signed this quote yet.";
export const NO_MANAGER_SIGNATURE = "Add your signature before accepting the quote.";
export const SIGNED_QUOTE_NOT_DELETABLE =
  "This quote was signed by the client and is a permanent commercial record. It cannot be deleted.";

/** A link is outstanding: sent, and neither completed nor declined. */
function isInFlight(status: SigningStatus): boolean {
  return status === "SENT" || status === "VIEWED";
}

/**
 * The preconditions for emailing a quote to its client, checked in a fixed
 * order so the message a manager sees names the first thing to fix rather than
 * an arbitrary one.
 *
 * The manager's own signature is NOT one of them (revisions/send spec §6.1):
 * a quote is sent with an empty manager-signature block, the client signs
 * first, and the manager signs only when accepting the signed quote (see
 * `canAccept`). This reverses the old "sign before send" order.
 *
 * DECLINED is deliberately sendable: a client who said no, then rang to say
 * they had misread it, should not require a brand-new quote number.
 */
export function canSendToClient(input: {
  documentStatus: "DRAFT" | "FINAL";
  signingStatus: SigningStatus;
  contactEmail: string | null;
}): Verdict {
  if (input.signingStatus === "SIGNED") return { ok: false, reason: SIGNED_IS_FINAL };
  if (isInFlight(input.signingStatus)) return { ok: false, reason: ALREADY_IN_FLIGHT };
  if (input.documentStatus !== "FINAL") return { ok: false, reason: NOT_FINAL };
  if (!input.contactEmail || input.contactEmail.trim() === "") {
    return { ok: false, reason: NO_CONTACT_EMAIL };
  }
  return { ok: true };
}

/** DocuSign's Void, with DocuSign's restriction: only while the envelope is
 * still in flight. Nothing revokes a completed quote. */
export function canRevoke(status: SigningStatus): boolean {
  return isInFlight(status);
}

/**
 * Whether the document's author (or an admin signing on their behalf — see
 * `signQuoteAsAuthor`'s own doc comment) may apply their signature right now.
 *
 * True for EVERY signing status of a FINAL quote — the two parties sign
 * independently and in any order (product decision: "everyone should be able
 * to sign, the order doesn't matter"). The manager can sign before sending,
 * while the client's link is still out (SENT/VIEWED), after the client has
 * signed (SIGNED — the counter-signature, which then makes the quote
 * `canAccept`), or after a decline. Adding an AUTHOR `Signature` never reopens
 * or changes the quote; it only records the manager's signature. When the
 * client has already signed, `signQuoteAsAuthor` re-archives the signed PDF so
 * the executed document shows both.
 *
 * The document must still be FINAL — enforced by `signQuoteAsAuthor`'s own
 * `status: "FINAL"` load, not here — so a DRAFT (which has no signing status
 * that matters) is never reached. Kept as a function beside every other
 * transition rule (and gating `SignButton`'s visibility) so the button and the
 * action can never disagree, even though the rule is now unconditional.
 */
export function canAuthorSign(): boolean {
  return true;
}

/**
 * Whether a client-signed quote may be accepted into production
 * (CLIENT_SIGNED → ACCEPTED, spec §1). Two conditions, in priority order so
 * the manager is told the more fundamental problem first:
 *
 * - the client must have signed (signingStatus SIGNED); and
 * - the manager must have signed too (an AUTHOR Signature exists) — accepting
 *   is the manager committing the deal, and a quote goes into production with
 *   both signatures on it, not one.
 */
export function canAccept(input: { signingStatus: SigningStatus; hasAuthorSignature: boolean }): Verdict {
  if (input.signingStatus !== "SIGNED") return { ok: false, reason: NOT_CLIENT_SIGNED };
  if (!input.hasAuthorSignature) return { ok: false, reason: NO_MANAGER_SIGNATURE };
  return { ok: true };
}

/**
 * The one new lock in the whole feature. Every other guarantee already
 * comes from the `status: "DRAFT"` clause every editing action carries (see
 * src/lib/actions/documents/_internal.ts), which is what makes FINAL
 * immutable today.
 */
export function canUnfinalize(status: SigningStatus): Verdict {
  if (status === "SIGNED") return { ok: false, reason: SIGNED_IS_FINAL };
  return { ok: true };
}

/**
 * Whether a document may be permanently deleted (`deleteDocument`,
 * src/lib/actions/documents/lifecycle.ts).
 *
 * `canUnfinalize` above already refuses to reopen a SIGNED quote no matter
 * who is asking, because `Document.signedPdfSha256` is a durable commercial
 * record: the archived PDF proves the bytes the client actually signed.
 * Deleting the row would cascade away its `Signature` and `SigningRequest`
 * rows and leave that archived PDF (and both `Signature.imageUrl` files --
 * see `deleteDocument`'s own comment) on disk referenced by nothing -- the
 * same destruction `canUnfinalize` blocks, just reached by a longer route.
 * For that reason an ADMIN who cannot reopen a signed quote still cannot
 * delete it either.
 *
 * The one exception: a DEVELOPER may delete a SIGNED quote anyway. This is a
 * testing affordance the product owner asked for -- a developer needs to be
 * able to clear a signed quote out of a test/staging environment without a
 * database console -- not a business capability, and it is deliberately the
 * one place a DEVELOPER outranks an ADMIN (see `isAdminRole`'s and
 * `isDeveloperRole`'s own comments in src/lib/roles.ts, and the `Role` enum's
 * comment in schema.prisma, all three updated alongside this to say so). The
 * refusal message for everyone else is unchanged: it still reads as an
 * absolute rule to a MANAGER or an ADMIN, because for them it is one.
 *
 * Every other status may be deleted by anyone this action's scope check
 * already lets see the document: a quote that was sent and then ignored, or
 * one the client declined, is still just a quote, with no signed record to
 * protect. The FINAL-requires-admin rule is a separate concern, layered on
 * top by `deleteDocument` itself, not decided here.
 */
export function canDeleteDocument(status: SigningStatus, role: string | null | undefined): Verdict {
  if (status === "SIGNED" && !isDeveloperRole(role)) {
    return { ok: false, reason: SIGNED_QUOTE_NOT_DELETABLE };
  }
  return { ok: true };
}

/** Completion needs both an outstanding link and a signature already drawn.
 * The drawn-but-unconfirmed window is what lets a client change their mind. */
export function canComplete(status: SigningStatus, hasClientSignature: boolean): boolean {
  return isInFlight(status) && hasClientSignature;
}

/** Declining stays available right up to completion — including after the
 * client has drawn a signature, which commits them to nothing. */
export function canDecline(status: SigningStatus): boolean {
  return isInFlight(status);
}

/** First open promotes SENT to VIEWED; every later open, and every other
 * status, is a no-op. Written as a total function so the caller can assign
 * unconditionally instead of branching. */
export function statusAfterView(status: SigningStatus): SigningStatus {
  return status === "SENT" ? "VIEWED" : status;
}

export type SignerRole = "AUTHOR" | "CLIENT";

/**
 * Which Signature rows an event invalidates.
 *
 * "unfinalize" clears both roles: the document is about to become editable,
 * so neither party signed the text that will exist afterwards — a surviving
 * row of either role would attest to a version of the document that no
 * longer exists once editing resumes.
 *
 * "revoke" clears CLIENT only: revoking kills the outstanding link but
 * leaves the document FINAL and unchanged, so the author's signature is
 * still a signature of exactly this text and survives. The client's row
 * must not survive: revoke is only reachable while the link is in flight
 * (see canRevoke/isInFlight), i.e. at most "drawn but not confirmed", never
 * a completed SIGNED. Leaving that row behind would mean the next send opens
 * the client's page already showing "Signed", with the confirm button
 * enabled, for a document the client never actually saw.
 *
 * Returns a fresh array on every call so a caller cannot mutate a shared
 * singleton out from under a later caller.
 */
export function signatureRolesClearedBy(event: "unfinalize" | "revoke"): SignerRole[] {
  return event === "unfinalize" ? ["AUTHOR", "CLIENT"] : ["CLIENT"];
}

/**
 * The manager-facing label for a signing badge (src/components/ui-kit/status-badge.tsx),
 * or `null` for NOT_SENT — the ordinary, unlabelled case for both the quotes
 * list and the document page's signing panel (see those two files). Kept
 * here, not duplicated in each caller, so the two places that render this
 * badge (the list row and the document panel) can never drift on wording.
 *
 * Returns a bare label rather than a `{ label, tone }` pair: the tone for
 * each of these four keys already lives in `STATUS_TONE`
 * (src/components/ui-kit/status-badge.tsx), keyed by these same strings —
 * this module stays free of any `@/components` import (see the header
 * comment on why it has no UI or Prisma-generated dependency) and leaves
 * `STATUS_TONE[status]` to the caller.
 */
export function signingStatusLabel(status: SigningStatus): string | null {
  switch (status) {
    case "NOT_SENT":
      return null;
    case "SENT":
      return "Sent";
    case "VIEWED":
      return "Viewed";
    case "SIGNED":
      return "Signed";
    case "DECLINED":
      return "Declined";
  }
}
