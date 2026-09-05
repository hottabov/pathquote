"use server";

import { revalidateRegion, revalidateRegionList } from "@/lib/revalidate";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { idSchema } from "@/lib/validation/documents";
import { createRegionSchema, updateRegionSchema } from "@/lib/validation/regions";
import { countActiveUsersInRegion } from "@/lib/queries/regions";
import {
  CODE_EXISTS_ERROR,
  NOT_FOUND_ERROR,
  flattenZodError,
  parseImageUrl,
  type ActionResult,
} from "./_shared";

export type { ActionResult };

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function readRegionForm(formData: FormData) {
  return {
    name: formData.get("name"),
    currency: formData.get("currency"),
    taxName: formData.get("taxName"),
    taxRate: formData.get("taxRate"),
    entityName: formData.get("entityName"),
    entityLegalId: formData.get("entityLegalId"),
    entityAddress: formData.get("entityAddress"),
    footerText: formData.get("footerText"),
    bankDetails: formData.get("bankDetails"),
    maxDiscountPct: formData.get("maxDiscountPct"),
    maxMarkupPct: formData.get("maxMarkupPct"),
    active: formData.get("active"),
  };
}

function revalidateRegionPaths(regionId: string) {
  revalidateRegionList();
  revalidateRegion(regionId);
}

/** Builds the `bankDetails` write for a Prisma `create`/`update` call: `null`
 * clears the column (via `Prisma.DbNull`, since Prisma rejects a literal
 * JSON `null` for a Json field — see the same pattern for
 * `Option.attributeSchema` in src/lib/actions/catalog.ts), otherwise the
 * validated record is passed straight through. */
function bankDetailsWrite(value: Record<string, string> | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

/**
 * Creates a new region, active by default per the submitted toggle. `code`
 * is only ever set here — there is no `code` field in `updateRegionSchema`,
 * and the edit form renders it read-only, matching the "immutable after
 * create" requirement.
 */
export async function createRegion(formData: FormData): Promise<ActionResult> {
  await requireAdmin();

  const parsed = createRegionSchema.safeParse({
    code: formData.get("code"),
    ...readRegionForm(formData),
  });
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  let created;
  try {
    created = await db.region.create({
      data: {
        code: parsed.data.code,
        name: parsed.data.name,
        currency: parsed.data.currency,
        taxName: parsed.data.taxName,
        taxRate: new Prisma.Decimal(parsed.data.taxRate),
        entityName: parsed.data.entityName,
        entityLegalId: parsed.data.entityLegalId ?? null,
        entityAddress: parsed.data.entityAddress ?? null,
        footerText: parsed.data.footerText ?? null,
        bankDetails: bankDetailsWrite(parsed.data.bankDetails),
        maxDiscountPct:
          parsed.data.maxDiscountPct === null ? null : new Prisma.Decimal(parsed.data.maxDiscountPct),
        maxMarkupPct: parsed.data.maxMarkupPct === null ? null : new Prisma.Decimal(parsed.data.maxMarkupPct),
        active: parsed.data.active,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) return { error: CODE_EXISTS_ERROR };
    throw error;
  }

  revalidateRegionList();
  redirect(`/settings/regions/${created.id}`);
}

/**
 * Updates every region field except `code` (immutable) and `logoUrl` (see
 * `updateRegionLogo`). Deactivating a region that still has active users
 * assigned is blocked — see `countActiveUsersInRegion`
 * (src/lib/queries/regions.ts) — since those users would otherwise be left
 * pointing at a region no longer meant to be used for new work.
 */
export async function updateRegion(regionId: string, formData: FormData): Promise<ActionResult> {
  await requireAdmin();

  const idParsed = idSchema.safeParse(regionId);
  if (!idParsed.success) return { error: NOT_FOUND_ERROR };

  const parsed = updateRegionSchema.safeParse(readRegionForm(formData));
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  const existing = await db.region.findUnique({ where: { id: regionId } });
  if (!existing) return { error: NOT_FOUND_ERROR };

  if (existing.active && !parsed.data.active) {
    const activeUserCount = await countActiveUsersInRegion(regionId);
    if (activeUserCount > 0) {
      return {
        error: `Can't deactivate this region — ${activeUserCount} active user${activeUserCount === 1 ? "" : "s"} ${activeUserCount === 1 ? "is" : "are"} still assigned to it.`,
      };
    }
  }

  // No try/catch for a P2002 here (unlike createRegion): `code` — the only
  // unique column on Region — is never part of this update.
  await db.region.update({
    where: { id: regionId },
    data: {
      name: parsed.data.name,
      currency: parsed.data.currency,
      taxName: parsed.data.taxName,
      taxRate: new Prisma.Decimal(parsed.data.taxRate),
      entityName: parsed.data.entityName,
      entityLegalId: parsed.data.entityLegalId ?? null,
      entityAddress: parsed.data.entityAddress ?? null,
      footerText: parsed.data.footerText ?? null,
      bankDetails: bankDetailsWrite(parsed.data.bankDetails),
      maxDiscountPct:
        parsed.data.maxDiscountPct === null ? null : new Prisma.Decimal(parsed.data.maxDiscountPct),
      maxMarkupPct: parsed.data.maxMarkupPct === null ? null : new Prisma.Decimal(parsed.data.maxMarkupPct),
      active: parsed.data.active,
    },
  });

  revalidateRegionPaths(regionId);
  return {};
}

/** A region's logo is stored and validated exactly like a catalogue image —
 * `parseImageUrl` (src/lib/actions/_shared.ts) is shared with every other
 * image write for that reason. */
export async function updateRegionLogo(regionId: string, url: string | null): Promise<ActionResult> {
  await requireAdmin();

  const idParsed = idSchema.safeParse(regionId);
  if (!idParsed.success) return { error: NOT_FOUND_ERROR };

  const parsed = parseImageUrl(url);
  if (!parsed.ok) return { error: "Invalid image URL" };

  const existing = await db.region.findUnique({ where: { id: regionId } });
  if (!existing) return { error: NOT_FOUND_ERROR };

  await db.region.update({ where: { id: regionId }, data: { logoUrl: parsed.value } });

  revalidateRegionPaths(regionId);
  return {};
}
