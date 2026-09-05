"use server";

import { revalidateContentBlock } from "@/lib/revalidate";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { isHtmlContent, sanitizeRichText } from "@/lib/rich-text";
import { contentBlockSchema, regionCodeSchema, CONTENT_KEY_REGEX } from "@/lib/validation/content";
import { flattenZodError, type ActionResult } from "./_shared";

export type { ActionResult };

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function readContentBlockForm(formData: FormData) {
  return {
    title: formData.get("title"),
    body: formData.get("body"),
    sortOrder: formData.get("sortOrder"),
  };
}

/** Resolves a region code to its id, or `null` for the default (regionId
 * null) row. Returns `{ error }` if a non-null code doesn't match an
 * existing region. */
async function resolveRegionId(regionCode: string | null): Promise<{ error: string } | { regionId: string | null }> {
  if (regionCode === null) return { regionId: null };
  const parsed = regionCodeSchema.safeParse(regionCode);
  if (!parsed.success) return { error: flattenZodError(parsed.error) };
  const region = await db.region.findUnique({ where: { code: parsed.data } });
  if (!region) return { error: "Region not found" };
  return { regionId: region.id };
}

/**
 * Creates or updates the content block at `key` for `regionCode` (or the
 * region-null default when `regionCode` is null). `ContentBlock`'s
 * `@@unique([key, regionId])` can't stop two regionId:null rows for the
 * same key at the Postgres level (NULL is never equal to NULL for
 * uniqueness purposes), so this always finds-then-writes rather than
 * relying on Prisma's composite-key upsert — same pattern as
 * `setOptionCompatibility` in src/lib/actions/catalog.ts. A P2002 from a
 * concurrent create (two admins saving the same new override at once) is
 * retried as an update against the row the other request just created,
 * rather than failing the whole save.
 *
 * `body` is HTML from the WYSIWYG `RichTextEditor` (or legacy markdown for a
 * key nobody has re-saved through the new editor yet — `contentBlockSchema`
 * accepts either shape, it's just a 1-20000 char string) — HTML content is
 * allowlist-sanitized via `sanitizeRichText` before it's written, the one
 * place that actually stops something unwanted from being persisted (the
 * read-side `renderStoredRichText` sanitizes again defensively, but by then
 * the row already exists).
 */
export async function updateContentBlock(
  key: string,
  regionCode: string | null,
  formData: FormData
): Promise<ActionResult> {
  await requireAdmin();

  if (!CONTENT_KEY_REGEX.test(key)) return { error: "Invalid content block key" };

  const parsed = contentBlockSchema.safeParse({ key, ...readContentBlockForm(formData) });
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  const resolved = await resolveRegionId(regionCode);
  if ("error" in resolved) return { error: resolved.error };
  const { regionId } = resolved;

  const data = {
    title: parsed.data.title ?? null,
    body: isHtmlContent(parsed.data.body) ? sanitizeRichText(parsed.data.body) : parsed.data.body,
    sortOrder: parsed.data.sortOrder,
  };

  const existing = await db.contentBlock.findFirst({ where: { key: parsed.data.key, regionId } });

  if (existing) {
    await db.contentBlock.update({ where: { id: existing.id }, data });
  } else {
    try {
      await db.contentBlock.create({ data: { key: parsed.data.key, regionId, ...data } });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await db.contentBlock.findFirst({ where: { key: parsed.data.key, regionId } });
      if (!raced) throw error;
      await db.contentBlock.update({ where: { id: raced.id }, data });
    }
  }

  revalidateContentBlock(parsed.data.key);
  return {};
}

/**
 * Creates a region override for `key`/`regionCode`, seeded with a copy of
 * the current default (regionId:null) block's title/body/sortOrder — the
 * admin then edits it independently via `updateContentBlock`. Fails if the
 * default block doesn't exist (nothing to copy from) or an override for
 * this region already exists.
 *
 * `defaultBlock.body` is copied verbatim except for one defensive pass: if
 * it's HTML, it's re-sanitized via `sanitizeRichText` on the way into the
 * new row (cheap idempotent re-check, not a trust boundary this action
 * itself introduces — the default row was already sanitized when
 * `updateContentBlock` wrote it) rather than assumed clean.
 */
export async function createRegionOverride(key: string, regionCode: string): Promise<ActionResult> {
  await requireAdmin();

  if (!CONTENT_KEY_REGEX.test(key)) return { error: "Invalid content block key" };

  const parsedRegion = regionCodeSchema.safeParse(regionCode);
  if (!parsedRegion.success) return { error: flattenZodError(parsedRegion.error) };

  const region = await db.region.findUnique({ where: { code: parsedRegion.data } });
  if (!region) return { error: "Region not found" };

  const [defaultBlock, existingOverride] = await Promise.all([
    db.contentBlock.findFirst({ where: { key, regionId: null } }),
    db.contentBlock.findFirst({ where: { key, regionId: region.id } }),
  ]);
  if (!defaultBlock) return { error: "Default block not found" };
  if (existingOverride) return { error: "An override already exists for this region" };

  try {
    await db.contentBlock.create({
      data: {
        key,
        regionId: region.id,
        title: defaultBlock.title,
        body: isHtmlContent(defaultBlock.body) ? sanitizeRichText(defaultBlock.body) : defaultBlock.body,
        sortOrder: defaultBlock.sortOrder,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    return { error: "An override already exists for this region" };
  }

  revalidateContentBlock(key);
  return {};
}

/**
 * Deletes the region override for `key`/`regionCode`, so that region falls
 * back to the default block again. Never touches the default (regionId:
 * null) row — there is no `regionCode: null` overload of this action, and a
 * non-existent/invalid region code just fails with "Region not found"
 * rather than resolving to the default.
 */
export async function deleteRegionOverride(key: string, regionCode: string): Promise<ActionResult> {
  await requireAdmin();

  if (!CONTENT_KEY_REGEX.test(key)) return { error: "Invalid content block key" };

  const parsedRegion = regionCodeSchema.safeParse(regionCode);
  if (!parsedRegion.success) return { error: flattenZodError(parsedRegion.error) };

  const region = await db.region.findUnique({ where: { code: parsedRegion.data } });
  if (!region) return { error: "Region not found" };

  const existing = await db.contentBlock.findFirst({ where: { key, regionId: region.id } });
  if (!existing) return { error: "Override not found" };

  await db.contentBlock.delete({ where: { id: existing.id } });

  revalidateContentBlock(key);
  return {};
}
