import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { documentWhereForUser } from "@/lib/scope";
import { resolveSignedPdfPath } from "@/lib/uploads";

// Streams a file from the uploads volume — needs real filesystem APIs, same
// as the sibling signed-pdf/quotation-pdf routes.
export const runtime = "nodejs";

type Params = { documentId: string; revisionId: string };

/**
 * Streams a frozen revision's PDF for the manager's Revisions tab. Serves the
 * signed PDF once the client has signed this revision (`signedPdfPath`),
 * otherwise the unsigned one (`pdfPath`) — the same "signed version wins"
 * rule the client's own download follows (spec §8.4). Scoped through the
 * document relation so a manager can only reach their own quotes' revisions;
 * anything foreign, or a revision whose PDF hasn't been generated / has gone
 * missing from disk, 404s uniformly.
 */
export async function GET(_request: Request, { params }: { params: Promise<Params> }) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { documentId, revisionId } = await params;
  const revision = await db.quoteRevision.findFirst({
    where: { id: revisionId, documentId, document: documentWhereForUser(session.user) },
    select: { label: true, pdfPath: true, signedPdfPath: true },
  });
  if (!revision) return Response.json({ error: "Not found" }, { status: 404 });

  const name = revision.signedPdfPath ?? revision.pdfPath;
  const diskPath = name ? resolveSignedPdfPath(name) : null;
  if (!diskPath) return Response.json({ error: "Not found" }, { status: 404 });

  try {
    await stat(diskPath);
  } catch {
    console.error("[revisions] revision PDF missing on disk", { documentId, revisionId });
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  return new Response(Readable.toWeb(createReadStream(diskPath)) as ReadableStream, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${revision.label}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
