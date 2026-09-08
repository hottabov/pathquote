"use server";

import { revalidateSettings } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import {
  isAllowedSettingKey,
  quoteValidityDaysSchema,
  showOptionIconsSchema,
  commissionTiersSchema,
  signingLinkValidityDaysSchema,
} from "@/lib/validation/settings";
import type { ActionResult } from "./_shared";

export type { ActionResult };

const UNKNOWN_SETTING_ERROR = "Unknown setting";

/**
 * Writes a single `Setting` row (key/value), ADMIN-only. Deliberately generic
 * in shape — `key` is a parameter, not baked into the function name — but
 * `isAllowedSettingKey` (src/lib/validation/settings.ts) whitelists which
 * keys may actually be written and which schema validates each one's
 * `value` field, so this can't be used to write an arbitrary key/value pair
 * from a crafted request. A new setting only needs a new case here plus an
 * entry in `ALLOWED_SETTING_KEYS`.
 */
export async function updateSetting(key: string, formData: FormData): Promise<ActionResult> {
  await requireAdmin();

  if (!isAllowedSettingKey(key)) {
    return { error: UNKNOWN_SETTING_ERROR };
  }

  switch (key) {
    case "quote.validityDays": {
      const parsed = quoteValidityDaysSchema.safeParse(formData.get("value"));
      if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "Invalid value" };
      }
      await db.setting.upsert({
        where: { key },
        create: { key, value: parsed.data },
        update: { value: parsed.data },
      });
      break;
    }
    case "signing.linkValidityDays": {
      const parsed = signingLinkValidityDaysSchema.safeParse(formData.get("value"));
      if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "Invalid value" };
      }
      await db.setting.upsert({
        where: { key },
        create: { key, value: parsed.data },
        update: { value: parsed.data },
      });
      break;
    }
    case "ui.showOptionIcons": {
      const parsed = showOptionIconsSchema.safeParse(formData.get("value"));
      if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "Invalid value" };
      }
      await db.setting.upsert({
        where: { key },
        create: { key, value: parsed.data },
        update: { value: parsed.data },
      });
      break;
    }
    case "commission.tiers": {
      const parsed = commissionTiersSchema.safeParse(formData.get("value"));
      if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "Invalid value" };
      }
      // `parsed.data` is a plain `CommissionTier[]` (possibly empty — see
      // `commissionTiersSchema`'s doc comment); Prisma's Json column takes
      // it as-is.
      await db.setting.upsert({
        where: { key },
        create: { key, value: parsed.data },
        update: { value: parsed.data },
      });
      break;
    }
  }

  revalidateSettings();
  return {};
}
