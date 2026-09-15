import { auth } from "@/auth";
import { getDocumentForForms } from "@/lib/queries/documents";
import { getSpecImages } from "@/lib/queries/spec-images";
import { fileImageResolver, htmlToPdf, inlineSheetImages } from "@/lib/pdf";
import { buildFormContexts } from "@/lib/production-forms/context";
import {
  buildPatches,
  missingRequirements,
  resolveForm,
  unmatchedOptions,
} from "@/lib/production-forms/resolve";
import { patchWorkbook } from "@/lib/production-forms/xlsx-patch";
import { isXlsxForm } from "@/lib/production-forms/types";
import { mergePdfs, readTemplate, xlsxToPdf } from "@/lib/production-forms/render";
import { AdditionalItemsSheet, type AdditionalItem } from "@/components/sheet/additional-items-sheet";
import { FormDocument } from "@/components/forms/form-sheet";
import { formComponent, isRenderable } from "@/components/forms/registry";

// `react-dom/server` (imported dynamically below, see the comment at the top
// of src/lib/pdf.ts for why) and Gotenberg's HTTP calls both need the Node
// runtime -- not available on the edge runtime.
export const runtime = "nodejs";

type Params = { documentId: string };

/**
 * Streams the production forms for a finalized quote as one PDF, one A4 page
 * per machine. `?item=<itemId>` narrows it to a single form and suppresses
 * the "Additional items" page (that page always speaks for the whole
 * document -- "from M-320" only makes sense next to the other machines'
 * forms, not on its own).
 *
 * FINAL quotes only: a draft is still being reworked, and the workshop must
 * not receive a form for a machine whose options are about to change.
 */
export async function GET(request: Request, { params }: { params: Promise<Params> }) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { documentId } = await params;
  const document = await getDocumentForForms(session.user, documentId);
  if (!document) return Response.json({ error: "Not found" }, { status: 404 });

  if (document.status !== "FINAL") {
    return Response.json({ error: "Production forms require a finalized quote" }, { status: 409 });
  }

  const onlyItemId = new URL(request.url).searchParams.get("item");

  // The operator/control-box side diagrams, the same admin-uploaded pair the
  // builder shows beside the dropdown. Marked rather than linked: Gotenberg's
  // Chromium has no session, so an `/api/files/...` URL would print as a
  // broken image -- `inlineSheetImages` swaps each mark for the bytes after
  // the sheet is rendered. A value with no upload yet simply never reaches
  // the page (see `ScreenSideBlock`).
  const screenSideImages = Object.fromEntries(
    Object.entries(await getSpecImages("screenSide")).flatMap(([value, url]) => {
      const mark = fileImageResolver(url);
      return mark ? [[value, mark]] : [];
    }),
  );

  const contexts = buildFormContexts(document, { screenSideImages }).filter(
    (ctx) => !onlyItemId || ctx.item.id === onlyItemId,
  );

  if (contexts.length === 0) {
    return Response.json({ error: "No production forms apply to this quote" }, { status: 404 });
  }

  const blockers = contexts.flatMap((ctx) => {
    const spec = resolveForm(ctx.item.form)!;

    // A form nothing can draw. Blocked loudly rather than skipped: a PDF
    // quietly missing one machine's page is how a machine gets built from
    // nothing.
    if (!isRenderable(ctx.item.form!) && !isXlsxForm(spec)) {
      return [{ itemId: ctx.item.id, code: ctx.item.code, missing: [`${spec.title} is not built yet`] }];
    }

    const missing = missingRequirements(spec, ctx.item.spec);

    // The EasyLoader's table used to be checked against the options sold
    // here as well. It no longer can disagree: the options are computed from
    // the table (see `setEasyLoaderLayout`), so there are no two numbers left
    // to reconcile.
    return missing.length ? [{ itemId: ctx.item.id, code: ctx.item.code, missing }] : [];
  });

  if (blockers.length > 0) {
    return Response.json({ error: "Production details are incomplete", blockers }, { status: 422 });
  }

  const pdfs: Buffer[] = [];

  try {
    // One pass over the items, in `sortOrder` -- the order the quote lists
    // them and the order the workshop expects the printed stack in.
    //
    // Component forms were briefly batched into one html document (one
    // Gotenberg call, no merge) but that put every component page ahead of
    // every workbook page, so a quote whose EasyLoader still renders from
    // xlsx came out shuffled. While the two paths coexist, order wins over
    // the round trip; once the last workbook is gone this collapses back to
    // a single call with `break-before: page` between sheets, which is what
    // `FormDocument` and the `.pf-sheet + .pf-sheet` rule are already for.
    //
    // A form with a component is drawn by it even while its workbook is
    // still committed: that is the migration order the render spec sets out
    // (§10) -- build the components behind this route, compare a printed
    // pair by eye with production, then delete the xlsx path. The component
    // registry is the single answer to "what draws this form"; there is no
    // flag to get out of step with.
    const { renderToStaticMarkup } = contexts.some((ctx) => isRenderable(ctx.item.form!))
      ? // Dynamic import for the reason given at the top of src/lib/pdf.ts.
        await import("react-dom/server")
      : { renderToStaticMarkup: null as never };

    for (const ctx of contexts) {
      const spec = resolveForm(ctx.item.form)!;
      const Component = formComponent(ctx.item.form!);

      if (Component) {
        const sheet = await inlineSheetImages(
          renderToStaticMarkup(FormDocument({ children: Component({ ctx }) })),
        );
        pdfs.push(
          await htmlToPdf(
            `<!doctype html><html><head><meta charSet="utf-8"></head><body>${sheet}</body></html>`,
            undefined,
            { printBackground: true },
          ),
        );
        continue;
      }

      // Blocked above; narrowing only.
      if (!isXlsxForm(spec)) continue;
      const patched = patchWorkbook(
        readTemplate(spec.template),
        spec.sheetPath,
        buildPatches(spec, ctx),
      );
      pdfs.push(await xlsxToPdf(patched, `${spec.id}.xlsx`));
    }

    // Document-level lines, plus every option whose machine's form has no box
    // for it. The second half is the important one: without it an option
    // would reach neither the form nor the workshop.
    const extras: AdditionalItem[] = [
      ...document.lines.map((line) => ({
        name: line.name,
        qty: line.qty,
        description: line.description,
        source: null,
      })),
      ...contexts.flatMap((ctx) => {
        const spec = resolveForm(ctx.item.form)!;
        const item = document.items.find((row) => row.id === ctx.item.id);
        return unmatchedOptions(spec, ctx).map((option) => {
          // The line is found by `refId` (the option's id), not by its
          // snapshotted code: the catalogue may have renamed the option
          // since the quote was written. A line with no `refId` has no
          // catalogue row at all, so its code is as stable as anything.
          const line = item?.lines.find((row) =>
            option.id !== null ? row.refId === option.id : row.code === option.code,
          );
          return {
            name: line?.name ?? option.code,
            qty: line?.qty ?? option.qty,
            description: line?.description ?? null,
            source: `${ctx.item.code} — ${ctx.item.name}`,
          };
        });
      }),
    ];

    // Only when the run covers the whole document -- see the doc comment on
    // `onlyItemId` above for why a single-item download never gets this page.
    if (extras.length > 0 && !onlyItemId) {
      // Dynamic import, not a static one: see the long comment at the top of
      // src/lib/pdf.ts -- Next's bundler statically forbids importing
      // react-dom/server from anything reachable through the RSC graph, even
      // a route handler pinned to the Node runtime.
      const { renderToStaticMarkup: renderExtras } = await import("react-dom/server");
      const body = renderExtras(
        AdditionalItemsSheet({
          documentNumber: document.number ?? "",
          companyName: document.company?.name ?? "",
          items: extras,
        }),
      );
      pdfs.push(
        await htmlToPdf(
          `<!doctype html><html><head><meta charSet="utf-8"><style>@page{size:A4;margin:15mm}body{margin:0}</style></head><body>${body}</body></html>`,
        ),
      );
    }
  } catch (error) {
    console.error("Production form generation failed", error);
    return Response.json({ error: "PDF service unavailable" }, { status: 502 });
  }

  let merged: Buffer;
  try {
    merged = await mergePdfs(pdfs);
  } catch (error) {
    console.error("Production form merge failed", error);
    return Response.json({ error: "PDF service unavailable" }, { status: 502 });
  }

  const filename = `${document.number ?? document.id}-production-forms.pdf`;

  return new Response(new Uint8Array(merged), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
