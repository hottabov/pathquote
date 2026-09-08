// Server-only: template loading + Gotenberg conversion for production forms
// (src/app/api/quotes/[documentId]/production-forms/route.ts). Kept
// separate from the route so each step is independently testable, matching
// the split src/lib/pdf.ts makes for the document PDF pipeline.
import { readFileSync } from "node:fs";
import path from "node:path";

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

/** Templates are committed beside the specs and read straight off disk. */
export function readTemplate(name: string): Uint8Array {
  const file = path.join(process.cwd(), "src/lib/production-forms/templates", name);
  return new Uint8Array(readFileSync(file));
}

/**
 * Converts a patched workbook to PDF. LibreOffice honours the template's own
 * print settings -- A4 portrait, an explicit print area, fitToPage -- so the
 * one-page-per-form guarantee comes from the template rather than from us.
 * Do not add paper size/margin options to this call: the template already
 * carries correct ones, and Gotenberg's own would override them.
 */
export async function xlsxToPdf(xlsx: Uint8Array, filename: string): Promise<Buffer> {
  const form = new FormData();
  form.set("files", new Blob([xlsx as BlobPart]), filename);
  return postToGotenberg("/forms/libreoffice/convert", form);
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
