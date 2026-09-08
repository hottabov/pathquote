/**
 * The document builder's server actions, kept at this one import path while
 * the implementations live in `./documents/` split by what they touch:
 * lifecycle (existence and client), items, options, extra lines, pricing
 * (discounts and hand-set prices), presentation (display flags, validity,
 * delivery terms), terms (the standard-terms overrides and which legal
 * documents the quote prints).
 *
 * This file is a barrel and nothing else. Every consumer of these actions
 * sits in src/app/ or src/components/ and imports from
 * "@/lib/actions/documents", so re-exporting from here is what lets that
 * split happen without touching a single one of them.
 *
 * It carries no `"use server"` directive of its own, and must not: such a
 * module may only export async *declarations*, and Turbopack rejects a bare
 * `export { … } from` inside one outright ("Only async functions are allowed
 * to be exported in a 'use server' file") — the alternative, wrapping each
 * action in a locally declared forwarder, would put a second server-action
 * reference in front of every real one for no gain. The directive belongs on
 * the modules that actually declare the actions, which each carry their own;
 * what passes through here is already a server reference, so a client
 * component importing from this path still gets the same action it did
 * before. The shared result type, the DRAFT guard and the sentinel mapping
 * those modules reach for live in `./documents/_internal.ts`, which
 * deliberately carries no directive either.
 */

export type { ActionResult } from "./documents/_internal";

export { createDraft, deleteDraft, deleteDocument, setDocumentClient } from "./documents/lifecycle";
export { addItem, removeItem, reorderItems } from "./documents/items";
export { setItemOptions, setEasyLoaderLayout } from "./documents/options";
export { addCustomLine, removeLine } from "./documents/lines";
export {
  setItemDiscount,
  setDocumentDiscount,
  setItemUnitPrice,
  resetItemUnitPrice,
  setLineUnitPrice,
  resetLineUnitPrice,
} from "./documents/pricing";
export {
  setItemShowImage,
  setItemSerialNumber,
  setPriceDisplay,
  setDocumentNotes,
  setDocumentHeroImage,
  setValidityDays,
  setDeliveryTerms,
} from "./documents/presentation";
export { setQuoteTerms, setDocumentExclusions } from "./documents/terms";
