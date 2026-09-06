import { auth } from "@/auth";
import { isAdminRole } from "@/lib/roles";
import { loadCatalogSnapshot } from "@/lib/queries/catalog-xlsx";
import { exportFileName, writeCatalogWorkbook } from "@/lib/catalog-xlsx/export";

// SheetJS builds the workbook in memory with Buffer -- Node only.
export const runtime = "nodejs";
// A download of live data; never serve a cached body.
export const dynamic = "force-dynamic";

/**
 * Settings -> Import / Export -> "Download catalogue": the live catalogue as
 * the four-sheet workbook (README, Products, Options, Prices) an admin edits
 * in Excel and uploads back. Same builder as `npm run catalog:export`
 * (src/lib/catalog-xlsx/export.ts), so the file the script writes and the
 * file this route sends are byte-for-byte the same shape.
 *
 * ADMIN/DEVELOPER only, like the page that links here (plan §3.6): the
 * workbook carries every price in every region.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAdminRole(session.user.role)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const snapshot = await loadCatalogSnapshot();
  const bytes = writeCatalogWorkbook(snapshot);

  return new Response(bytes as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${exportFileName()}"`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
