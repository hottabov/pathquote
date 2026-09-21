// Server-only: the Gotenberg call that joins the production forms into one
// download (src/app/api/quotes/[documentId]/production-forms/route.ts). Kept
// separate from the route so each step is independently testable, matching
// the split src/lib/pdf.ts makes for the document PDF pipeline.
//
// `readTemplate` and `xlsxToPdf` used to live here too, for the forms drawn
// by patching the original workbook. The last of those (Punchline) was
// dropped on 2026-09-18 and the xlsx path with it, so what is left is the
// merge: every form is HTML, but each sheet is still its own PDF, and the
// order the workshop expects comes from concatenating them here.

const GOTENBERG_TIMEOUT_MS = 60_000;

function gotenbergUrl(): string {
  const baseUrl = process.env.GOTENBERG_URL;
  if (!baseUrl) throw new Error("GOTENBERG_URL is not configured");
  return baseUrl;
}

async function postToGotenberg(route: string, form: FormData): Promise<Buffer> {
  const response = await fetch(`${gotenbergUrl()}${route}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(GOTENBERG_TIMEOUT_MS),
  });

  if (!response.ok) {
    const snippet = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(`Gotenberg returned ${response.status}: ${snippet}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Concatenates PDFs in the order given. Gotenberg's merge route orders by
 * filename, not upload order, so callers rely on this preserving the order
 * of `pdfs` -- the zero-padded index below is what makes that true past 9
 * inputs (`10.pdf` sorts before `2.pdf` under plain lexical order).
 */
export async function mergePdfs(pdfs: Buffer[]): Promise<Buffer> {
  if (pdfs.length === 1) return pdfs[0];

  const form = new FormData();
  pdfs.forEach((pdf, index) => {
    form.append(
      "files",
      new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
      `${String(index).padStart(3, "0")}.pdf`,
    );
  });
  return postToGotenberg("/forms/pdfengines/merge", form);
}
