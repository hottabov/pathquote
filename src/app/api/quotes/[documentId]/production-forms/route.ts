import { auth } from "@/auth";
import { getDocumentForForms } from "@/lib/queries/documents";
import { getSpecImages } from "@/lib/queries/spec-images";
import { fileImageResolver, htmlToPdf, inlineSheetImages } from "@/lib/pdf";
import {
  buildFormContexts,
  buildSoftwareFormContext,
  softwareItemsOnDocument,
} from "@/lib/production-forms/context";
import {
  missingRequirements,
  resolveForm,
  unmatchedOptions,
} from "@/lib/production-forms/resolve";
import { mergePdfs } from "@/lib/production-forms/render";
import { AdditionalItemsSheet, type AdditionalItem } from "@/components/sheet/additional-items-sheet";
import { FormDocument } from "@/components/forms/form-sheet";
import { SoftwareForm } from "@/components/forms/software-form";
import { formComponent, isRenderable } from "@/components/forms/registry";

// `react-dom/server` (imported dynamically below, see the comment at the top
// of src/lib/pdf.ts for why) and Gotenberg's HTTP calls both need the Node
// runtime -- not available on the edge runtime.
export const runtime = "nodejs";

type Params = { documentId: string };

/** `?item=extras` is the reserved value that downloads ONLY the Additional
 * items page (a real item id is a cuid, so it can never collide with this). */
const EXTRAS_PARAM = "extras";

/** `?item=software` downloads ONLY the Software Order Form -- the one sheet
 * that belongs to the whole quote rather than to a machine. Reserved the same
 * way as `extras`: a real item id is a cuid. */
const SOFTWARE_PARAM = "software";

/**
 * Streams the production forms for a finalized quote as one PDF, one A4 page
 * per machine. `?item=<itemId>` narrows it to a single form and suppresses
 * the "Additional items" page (that page speaks for the whole document, so it
 * only makes sense next to the other machines' forms). `?item=extras` does
 * the opposite: it downloads just the Additional items page on its own — the
 * document-level custom lines plus every option no machine form has a box for.
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

  const onlyParam = new URL(request.url).searchParams.get("item");
  const extrasOnly = onlyParam === EXTRAS_PARAM;
  const softwareOnly = onlyParam === SOFTWARE_PARAM;
  const onlyItemId = extrasOnly || softwareOnly ? null : onlyParam;

  // SOFTWARE products sold on this quote -- what the Software Order Form
  // lists. Document-level, like the Additional items page: software has no
  // machine to hang off, and three programs are one order, not three sheets.
  const softwareItems = softwareItemsOnDocument(document);

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

  const allContexts = buildFormContexts(document, { screenSideImages });
  const contexts = allContexts.filter((ctx) => !onlyItemId || ctx.item.id === onlyItemId);

  // Document-level lines, plus every option whose machine's form has no box
  // for it. The second half is the important one: without it an option would
  // reach neither the form nor the workshop. Built from ALL contexts, since an
  // unmatched option can belong to any machine on the quote.
  const extras: AdditionalItem[] = [
    ...document.lines.map((line) => ({
      name: line.name,
      qty: line.qty,
      description: line.description,
      source: null,
    })),
    ...allContexts.flatMap((ctx) => {
      const spec = resolveForm(ctx.item.form)!;
      const item = document.items.find((row) => row.id === ctx.item.id);
      return unmatchedOptions(spec, ctx).map((option) => {
        // The line is found by `refId` (the option's id), not by its
        // snapshotted code: the catalogue may have renamed the option since
        // the quote was written. A line with no `refId` has no catalogue row
        // at all, so its code is as stable as anything.
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

  /** The Software Order Form as its own one-page PDF. */
  const softwarePdf = async (): Promise<Buffer> => {
    // Dynamic import for the reason given at the top of src/lib/pdf.ts.
    const { renderToStaticMarkup } = await import("react-dom/server");
    const sheet = renderToStaticMarkup(
      FormDocument({ children: SoftwareForm({ ctx: buildSoftwareFormContext(document) }) }),
    );
    return htmlToPdf(
      `<!doctype html><html><head><meta charSet="utf-8"></head><body>${sheet}</body></html>`,
      undefined,
      { printBackground: true },
    );
  };

  // `?item=software`: the Software Order Form on its own. Ahead of the
  // machine-form checks for the same reason `extras` is -- a quote selling
  // only software has no machine form and must still produce this sheet.
  if (softwareOnly) {
    if (softwareItems.length === 0) {
      return Response.json({ error: "No software on this quote" }, { status: 404 });
    }
    let pdf: Buffer;
    try {
      pdf = await softwarePdf();
    } catch (error) {
      console.error("Software order form generation failed", error);
      return Response.json({ error: "PDF service unavailable" }, { status: 502 });
    }
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${document.number ?? document.id}-software-order.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  }

  // `?item=extras`: render just the Additional items page and return.
  // Deliberately ahead of the "no forms apply" and blockers checks below —
  // those are about the machine forms, and this page is independent of them,
  // so a quote of only custom lines (no machine forms), or one whose machine
  // form isn't built yet, can still produce it.
  if (extrasOnly) {
    if (extras.length === 0) {
      return Response.json({ error: "No additional items on this quote" }, { status: 404 });
    }
    let pdf: Buffer;
    try {
      // Dynamic import for the reason given at the top of src/lib/pdf.ts.
      const { renderToStaticMarkup } = await import("react-dom/server");
      const body = renderToStaticMarkup(
        AdditionalItemsSheet({
          documentNumber: document.number ?? "",
          companyName: document.company?.name ?? "",
          items: extras,
        }),
      );
      pdf = await htmlToPdf(
        `<!doctype html><html><head><meta charSet="utf-8"><style>@page{size:A4;margin:15mm}body{margin:0}</style></head><body>${body}</body></html>`,
      );
    } catch (error) {
      console.error("Additional items generation failed", error);
      return Response.json({ error: "PDF service unavailable" }, { status: 502 });
    }
    const extrasFilename = `${document.number ?? document.id}-additional-items.pdf`;
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${extrasFilename}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  // A quote of software alone still produces a sheet -- the software one.
  if (contexts.length === 0 && softwareItems.length === 0) {
    return Response.json({ error: "No production forms apply to this quote" }, { status: 404 });
  }

  const blockers = contexts.flatMap((ctx) => {
    const spec = resolveForm(ctx.item.form)!;

    // A form nothing can draw: a spec exists but no component has been
    // written for it yet. Every form is a component now, so having none is
    // the whole of the question. Blocked loudly rather than skipped: a PDF
    // quietly missing one machine's page is how a machine gets built from
    // nothing.
    if (!isRenderable(ctx.item.form!)) {
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
    // Still one Gotenberg call and one PDF per sheet rather than one html
    // document with `break-before: page` between the sheets. That collapse
    // is now possible -- it was blocked only while workbook pages and
    // component pages had to interleave in `sortOrder` -- but it is a change
    // to what Chromium is handed for every quote, so it is worth doing on
    // its own with a printed pair to compare, not as a side effect of
    // deleting the xlsx path. `FormDocument` and the `.pf-sheet + .pf-sheet`
    // rule are already written for it.
    //
    // Dynamic import for the reason given at the top of src/lib/pdf.ts.
    const { renderToStaticMarkup } = await import("react-dom/server");

    for (const ctx of contexts) {
      // Non-null: a form with no component was blocked above.
      const Component = formComponent(ctx.item.form!)!;
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
    }

    // The software sheet, after the machine forms and before the additional
    // items page. Whole-document runs only, like that page: a single
    // machine's download is the sheet for that machine.
    if (softwareItems.length > 0 && !onlyItemId) {
      pdfs.push(await softwarePdf());
    }

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
