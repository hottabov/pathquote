// Server-only: the Gotenberg call that joins the production forms into one
// download (src/app/api/quotes/[documentId]/production-forms/route.ts). Kept
// separate from the route so each step is independently testable. The HTTP
// call itself is src/lib/pdf.ts's `postToGotenberg`, so the merge waits in the
// same two-slot queue as every conversion rather than beside it.
//
// `readTemplate` and `xlsxToPdf` used to live here too, for the forms drawn
// by patching the original workbook. The last of those (Punchline) was
// dropped on 2026-09-18 and the xlsx path with it, so what is left is the
// merge: every form is HTML, but each sheet is still its own PDF, and the
// order the workshop expects comes from concatenating them here.

import { postToGotenberg } from "@/lib/pdf";

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
