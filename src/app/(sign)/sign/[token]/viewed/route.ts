import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getDocumentForSigning } from "@/lib/queries/signing";
import { hashSigningToken } from "@/lib/signing/token";
import { resolveLinkState } from "@/lib/signing/link";
import { statusAfterView } from "@/lib/signing/state";

// Records that a human opened the quote.
//
// This used to happen during the GET render of the signing page, which meant a
// machine could do it on the client's behalf: Microsoft 365 Defender fetches
// every emailed URL in a headless browser, so a quote flipped SENT → VIEWED
// seconds after it was sent, before the recipient had seen anything. The
// manager watching the pipeline was told the client had opened it. On a
// document a customer signs, that is not a cosmetic inaccuracy — it is the
// system asserting something about the client that never happened.
//
// So the write moved off the render and behind evidence of a person: the page
// posts here after the first real interaction (see view-beacon.tsx). A scanner
// renders the page and leaves; nothing is written. The trade is that a visitor
// who opens the quote and neither scrolls, moves the pointer, nor touches the
// screen goes unrecorded — deliberately, because under-reporting a view is a
// gap and over-reporting one is a lie.
//
// POST rather than GET for the same reason the route exists at all: a GET here
// would just move the problem to a new URL.

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const request = await getDocumentForSigning(hashSigningToken(token));

  // Unknown token. Says nothing either way — this endpoint reports no state.
  if (!request) return new NextResponse(null, { status: 204 });

  // Only a live link may record a view. An expired, revoked, declined or
  // already-completed link is not something a client is "viewing" in any sense
  // the pipeline should act on.
  const state = resolveLinkState({
    expiresAt: request.expiresAt,
    revokedAt: request.revokedAt,
    declinedAt: request.declinedAt,
    signingStatus: request.document.signingStatus,
    now: new Date(),
  });
  if (state.kind !== "live") return new NextResponse(null, { status: 204 });

  // Already recorded: a reload is not a second first-view.
  if (request.firstViewedAt !== null) return new NextResponse(null, { status: 204 });

  // Unchanged from the version that ran during render — a status-guarded
  // updateMany matching sendQuoteForSignature's claim idiom, so two
  // simultaneous opens cannot both claim the transition.
  const now = new Date();
  await db.$transaction(async (tx) => {
    const claimed = await tx.signingRequest.updateMany({
      where: { id: request.id, firstViewedAt: null },
      data: { firstViewedAt: now },
    });
    if (claimed.count === 0) return;
    await tx.document.update({
      where: { id: request.document.id },
      data: { signingStatus: statusAfterView(request.document.signingStatus) },
    });
  });

  return new NextResponse(null, { status: 204 });
}
