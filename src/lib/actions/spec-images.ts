"use server";

import { revalidateSpecImages } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { parseImageUrl, type ActionResult } from "./_shared";

export type { ActionResult };

/**
 * Sets (or, given `url: null`, clears) the diagram for one `(field, value)`
 * pair of the `SpecImage` table (see that model's doc comment in
 * schema.prisma) — e.g. `setSpecImage("screenSide", "+Y", url)`. ADMIN/
 * DEVELOPER only, same as every other catalogue-image write
 * (`updateProductImage`/`updateOptionImage`/`updateRegionLogo`). Upserts on
 * the `(field, value)` unique constraint rather than a separate
 * create-then-update, since a value with no diagram yet has no row at all;
 * `url: null` deletes the row outright (there's nothing useful to keep a
 * row with a null `imageUrl` for — every consumer already treats "no row"
 * and "row with no image" identically, see `getSpecImages`).
 */
export async function setSpecImage(field: string, value: string, url: string | null): Promise<ActionResult> {
  await requireAdmin();

  const parsed = parseImageUrl(url);
  if (!parsed.ok) return { error: "Invalid image URL" };

  if (parsed.value === null) {
    await db.specImage.deleteMany({ where: { field, value } });
  } else {
    await db.specImage.upsert({
      where: { field_value: { field, value } },
      create: { field, value, imageUrl: parsed.value },
      update: { imageUrl: parsed.value },
    });
  }

  revalidateSpecImages();
  return {};
}
