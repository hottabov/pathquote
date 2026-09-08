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
export type SigningStatus = "NOT_SENT" | "SENT" | "VIEWED" | "SIGNED" | "DECLINED";

/** Use `Verdict` when a function can fail for more than one reason and the
 * caller needs to know which one, so it can show that reason to the user
 * (canSendToClient, canUnfinalize). Use a bare `boolean` when there is
 * exactly one failure mode, since the caller already knows what it means and
 * can supply its own message in context (canRevoke, canComplete, canDecline). */
export type Verdict = { ok: true } | { ok: false; reason: string };

export const NOT_FINAL = "Finalize the quote before signing it.";
export const NO_AUTHOR_SIGNATURE = "Sign the quote before sending it.";
export const NO_CONTACT_EMAIL = "This quote's contact has no email address.";
export const ALREADY_IN_FLIGHT = "This quote is already with the client. Revoke the link first.";
export const SIGNED_IS_FINAL = "A signed quote cannot be reopened. Create a new quote instead.";

/** A link is outstanding: sent, and neither completed nor declined. */
function isInFlight(status: SigningStatus): boolean {
  return status === "SENT" || status === "VIEWED";
}

/**
 * The three preconditions for emailing a quote to its client, checked in a
 * fixed order so the message a manager sees names the first thing to fix
 * rather than an arbitrary one.
 *
 * DECLINED is deliberately sendable: a client who said no, then rang to say
 * they had misread it, should not require a brand-new quote number.
 */
export function canSendToClient(input: {
  documentStatus: "DRAFT" | "FINAL";
  signingStatus: SigningStatus;
  hasAuthorSignature: boolean;
  contactEmail: string | null;
}): Verdict {
  if (input.signingStatus === "SIGNED") return { ok: false, reason: SIGNED_IS_FINAL };
  if (isInFlight(input.signingStatus)) return { ok: false, reason: ALREADY_IN_FLIGHT };
  if (input.documentStatus !== "FINAL") return { ok: false, reason: NOT_FINAL };
  if (!input.hasAuthorSignature) return { ok: false, reason: NO_AUTHOR_SIGNATURE };
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
 * `signQuoteAsAuthor`'s own doc comment) may apply their signature right
 * now. True for exactly two statuses:
 *
 * - NOT_SENT: nobody has been asked to sign yet, the ordinary starting point.
 * - DECLINED: the client said no. The author may re-sign (typically after a
 *   revision) and re-send — same reasoning as `canSendToClient`'s own
 *   comment on why DECLINED is sendable: a client who calls back to say they
 *   misread it shouldn't force a brand-new quote number.
 *
 * False for SENT/VIEWED (a link is already outstanding — revoke it first,
 * `canRevoke` above) and SIGNED (the quote is done; see `SIGNED_IS_FINAL`).
 *
 * Lives here, beside every other transition rule, rather than as a
 * hand-written `!==`/`!==` check inside the action itself — the whole point
 * of this module (see its header comment) is that a rule like this one is
 * testable without a database.
 */
export function canAuthorSign(status: SigningStatus): boolean {
  return status === "NOT_SENT" || status === "DECLINED";
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
