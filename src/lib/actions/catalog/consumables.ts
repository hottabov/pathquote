"use server";

import { z } from "zod";
import { revalidateOption } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import type { ActionResult } from "../_shared";

const consumablesSchema = z
  .array(
    z.object({
      consumableId: z.string().min(1),
      qty: z.coerce.number().int().min(1, "Quantity must be at least 1").max(999),
    })
  )
  .max(50);

/**
 * Sets the consumables a tool goes on a quote with (see OptionConsumable) to
 * exactly `items`, in that order. Replaced as a whole: the list is short and
 * its order is what the options editor shows, so a delete-and-recreate is
 * both simpler and more honest than a diff.
 *
 * A tool cannot be its own consumable, and neither can an option that is
 * itself a tool with consumables -- a blade does not come with blades.
 */
export async function setOptionConsumables(
  toolId: string,
  items: { consumableId: string; qty: number }[]
): Promise<ActionResult> {
  await requireAdmin();

  const parsed = consumablesSchema.safeParse(items);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid consumables" };

  const ids = parsed.data.map((item) => item.consumableId);
  if (new Set(ids).size !== ids.length) return { error: "Each consumable can only be listed once" };
  if (ids.includes(toolId)) return { error: "An option cannot be its own consumable" };

  const [tool, consumables] = await Promise.all([
    db.option.findUnique({
      where: { id: toolId },
      select: { id: true, _count: { select: { consumableFor: true } } },
    }),
    db.option.findMany({
      where: { id: { in: ids } },
      select: { id: true, code: true, _count: { select: { consumables: true } } },
    }),
  ]);
  if (!tool) return { error: "Option not found" };
  if (ids.length > 0 && tool._count.consumableFor > 0) {
    return { error: "This option is a consumable of another tool, so it cannot have consumables" };
  }
  if (consumables.length !== ids.length) return { error: "Unknown consumable" };
  const tools = consumables.filter((option) => option._count.consumables > 0).map((option) => option.code);
  if (tools.length > 0) return { error: `${tools.join(", ")} has consumables of its own` };

  await db.$transaction([
    db.optionConsumable.deleteMany({ where: { toolId } }),
    db.optionConsumable.createMany({
      data: parsed.data.map((item, index) => ({
        toolId,
        consumableId: item.consumableId,
        qty: item.qty,
        sortOrder: index,
      })),
    }),
  ]);

  revalidateOption(toolId);
  for (const id of ids) revalidateOption(id);
  return {};
}
