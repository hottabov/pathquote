"use server";

import { revalidateOption, revalidateOptionList } from "@/lib/revalidate";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { optionSchema } from "@/lib/validation/catalog";
import { CODE_EXISTS_ERROR, flattenZodError, type ActionResult } from "../_shared";
import { isUniqueConstraintError, readOptionForm } from "./_internal";

export async function createOption(formData: FormData): Promise<ActionResult> {
  await requireAdmin();

  const parsed = optionSchema.safeParse(readOptionForm(formData));
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  let created;
  try {
    created = await db.option.create({
      data: {
        code: parsed.data.code,
        name: parsed.data.name,
        shortDescription: parsed.data.shortDescription ?? null,
        // Omit rather than pass `null` on create: an optional Json column
        // just defaults to NULL when the field is left unset, and Prisma
        // rejects a literal `null` for Json fields (it wants
        // Prisma.DbNull/Prisma.JsonNull to disambiguate from JSON `null`).
        ...(parsed.data.attributeSchema !== null
          ? { attributeSchema: parsed.data.attributeSchema as Prisma.InputJsonValue }
          : {}),
        active: parsed.data.active,
        noCommission: parsed.data.noCommission,
        sortOrder: parsed.data.sortOrder,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) return { error: CODE_EXISTS_ERROR };
    throw error;
  }

  revalidateOptionList();
  redirect(`/catalog/options/${created.id}`);
}

export async function updateOption(optionId: string, formData: FormData): Promise<ActionResult> {
  await requireAdmin();

  const parsed = optionSchema.safeParse(readOptionForm(formData));
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  const existing = await db.option.findUnique({ where: { id: optionId } });
  if (!existing) return { error: "Option not found" };

  try {
    await db.option.update({
      where: { id: optionId },
      data: {
        code: parsed.data.code,
        name: parsed.data.name,
        shortDescription: parsed.data.shortDescription ?? null,
        // Here we *do* need to actively clear the column when the user
        // emptied the textarea, so use Prisma.DbNull instead of omitting.
        attributeSchema:
          parsed.data.attributeSchema === null
            ? Prisma.DbNull
            : (parsed.data.attributeSchema as Prisma.InputJsonValue),
        active: parsed.data.active,
        noCommission: parsed.data.noCommission,
        sortOrder: parsed.data.sortOrder,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) return { error: CODE_EXISTS_ERROR };
    throw error;
  }

  // The route is keyed by id, which never changes on an update, so unlike
  // the product route (`updateProduct`, products.ts) there's no "old code
  // path" / "new code path" pair to revalidate here — just the one URL.
  revalidateOptionList();
  revalidateOption(optionId);
  redirect(`/catalog/options/${optionId}`);
}

export async function deleteOption(optionId: string): Promise<ActionResult> {
  await requireAdmin();

  const existing = await db.option.findUnique({ where: { id: optionId } });
  if (!existing) return { error: "Option not found" };

  const referencedCount = await db.documentLine.count({ where: { refId: optionId } });
  if (referencedCount > 0) {
    return { error: "This option is used on one or more documents and can't be deleted." };
  }

  // Price, OptionCompatibility and OptionConflictGroupMember rows all
  // cascade (each onDelete: Cascade on its optionId relation in the
  // schema), so no orphaned group membership is left behind either.
  await db.option.delete({ where: { id: optionId } });

  revalidateOptionList();
  redirect("/catalog/options");
}
