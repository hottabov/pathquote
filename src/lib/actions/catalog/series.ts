"use server";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { revalidateCatalog } from "@/lib/revalidate";
import { sanitizeIfHtml } from "@/lib/rich-text";
import { seriesQuoteDescriptionSchema } from "@/lib/validation/series";
import { categorySpecPresence, categoryTokensFor, findUnknownTokens } from "@/lib/quote-variables";
import { flattenZodError, type ActionResult } from "../_shared";

/** Saves the copy printed under every product of this category on a quote.
 *
 * Rejects a token the category has no data for — the editor only offers
 * in-scope tokens, so reaching here means a hand-typed or pasted one. This is
 * the check that makes "a table template cannot ask for cut height" a
 * property of the system rather than a convention. */
export async function updateSeriesQuoteDescription(
  seriesId: string,
  formData: FormData
): Promise<ActionResult> {
  await requireAdmin();

  const parsed = seriesQuoteDescriptionSchema.safeParse(formData.get("quoteDescription"));
  if (!parsed.success) return { error: flattenZodError(parsed.error) };

  const series = await db.series.findUnique({
    where: { id: seriesId },
    include: { products: { select: { specs: true, kind: true } } },
  });
  if (!series) return { error: "Series not found" };

  const body = parsed.data;
  if (body) {
    const presence = categorySpecPresence(series.products);
    const unknown = findUnknownTokens(body, categoryTokensFor(presence));
    if (unknown.length > 0) {
      return {
        error: `No value exists for ${unknown.map((t) => `{{${t}}}`).join(", ")} in this category. Remove it or pick a variable from the list.`,
      };
    }
  }

  await db.series.update({
    where: { id: seriesId },
    data: { quoteDescription: body === null ? null : sanitizeIfHtml(body) },
  });

  revalidateCatalog(seriesId);
  return {};
}
