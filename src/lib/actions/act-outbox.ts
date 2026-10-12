"use server";

// The administrator's actions on a quote's write into ACT!, from the ACT! card
// on the quote's own page (src/components/documents/act-state-card.tsx). Each
// one: requireAdmin, then the database half in src/lib/act/outbox-admin-store.ts
// (whose decisions, and the guard on every write, are in
// src/lib/act/outbox-admin.ts) -- which for "ACT! has this person" also
// reads the typed id back from ACT! before writing -- then, for the three
// that leave the quote due, the fast-path drain for this quote, and the pages
// that show the row refreshed.
//
// requireAdmin and nothing narrower: these change what is sent to the
// company's CRM, and two of them cannot be taken back. A manager sees the
// state on the card, and no button.

import { requireAdmin } from "@/lib/authz";
import { drainAfterResponse } from "@/lib/act/drain-after";
import { readActWriteSwitch } from "@/lib/act/drain";
import {
  contactAbsent,
  contactFound,
  dontSend,
  tryAgainNow,
  type AdminOutcome,
} from "@/lib/act/outbox-admin-store";
import { adminDoneMessage } from "@/lib/act/quote-act-view";
import { revalidateActSync, revalidateDocument } from "@/lib/revalidate";
import { idSchema } from "@/lib/validation/documents";
import { NOT_FOUND_ERROR, type ActionResult } from "./_shared";

/** `{}` with the sentence to show on success, or `{ error }`. */
export type ActOutboxActionResult = ActionResult & { message?: string };

type Done = "tryAgain" | "contactFound" | "contactAbsent" | "dontSend";

/**
 * After the write: the page and the Settings list re-read, and -- unless the
 * quote was taken out of the queue -- a send for this quote started once the
 * response has gone, best-effort, exactly as after a finalise. Off, or busy,
 * the row waits for the next 15-minute send; drainAfterResponse logs which.
 *
 * The write has committed by now, so nothing after it may turn the result
 * into a failure: a throw here would reach the card as "That did not go
 * through", and an administrator pressing again would be told the quote's
 * place in the queue has changed -- by their own first press. drainAfterResponse
 * catches its own failures; the revalidation and the switch's read are caught
 * here, and without the switch the message says only what was done.
 */
async function finish(documentId: string, outcome: AdminOutcome, done: Done): Promise<ActOutboxActionResult> {
  if (!outcome.ok) return { error: "notFound" in outcome ? NOT_FOUND_ERROR : outcome.error };
  if (done !== "dontSend") drainAfterResponse(documentId, "administrator's action");
  try {
    revalidateDocument(documentId);
    revalidateActSync();
    return { message: adminDoneMessage(done, await readActWriteSwitch()) };
  } catch (error) {
    console.error("[act] an administrator's action on the queue for ACT! went through; what follows it failed", {
      documentId,
      done,
      error,
    });
    return { message: adminDoneMessage(done, null) };
  }
}

/** Parse the document id the way every document action does; null for one that cannot be an id. */
function documentIdOf(documentId: string): string | null {
  const parsed = idSchema.safeParse(documentId);
  return parsed.success ? parsed.data : null;
}

/** "Try again now", for a row held by ACT!'s answer, its revision, or a lookup's duplicates. */
export async function retryActWrite(documentId: string): Promise<ActOutboxActionResult> {
  await requireAdmin();
  const id = documentIdOf(documentId);
  if (!id) return { error: NOT_FOUND_ERROR };
  return finish(id, await tryAgainNow(id, new Date()), "tryAgain");
}

/**
 * "ACT! has this person": the held contact is given the ACT! id typed in,
 * once ACT! has confirmed a contact with that id whose name or email matches
 * (actContactCheck in src/lib/act/outbox-admin.ts). Waits on ACT!'s answer,
 * which the client retries for a while when ACT! does not answer.
 */
export async function linkHeldContact(documentId: string, actContactId: string): Promise<ActOutboxActionResult> {
  await requireAdmin();
  const id = documentIdOf(documentId);
  if (!id) return { error: NOT_FOUND_ERROR };
  return finish(id, await contactFound(id, String(actContactId ?? ""), new Date()), "contactFound");
}

/** "ACT! has nobody": the held contact's hold is released, and the next send creates them. */
export async function releaseHeldContact(documentId: string): Promise<ActOutboxActionResult> {
  await requireAdmin();
  const id = documentIdOf(documentId);
  if (!id) return { error: NOT_FOUND_ERROR };
  return finish(id, await contactAbsent(id, new Date()), "contactAbsent");
}

/** "Don't send this quote to ACT!": the unfinished row is finished unsent. */
export async function stopActWrite(documentId: string): Promise<ActOutboxActionResult> {
  await requireAdmin();
  const id = documentIdOf(documentId);
  if (!id) return { error: NOT_FOUND_ERROR };
  return finish(id, await dontSend(id, new Date()), "dontSend");
}
