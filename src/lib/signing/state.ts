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
