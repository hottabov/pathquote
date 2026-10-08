"use server";

import { revalidateUser } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { grantFromSelection } from "@/lib/country-grant";
import type { ActionResult } from "./_shared";

export type { ActionResult };

/**
 * Sets a user's `visibleCountries` to exactly what the editor sends: every
 * client of the ticked countries, or every client everywhere when
 * `allCountries` is on. Replaces the whole value in one write -- the same
 * "send the full desired set" shape `setCatalogVisibility` uses, with no diff
 * to compute because the column is a plain array.
 *
 * This is an ALLOW list, the opposite of `setCatalogVisibility`'s deny list:
 * a code here makes clients visible, and an empty list shows the user only the
 * clients they own (never "all" -- see `ALL_COUNTRIES` in src/lib/scope.ts).
 *
 * The rules for what is a valid grant are `grantFromSelection`'s, shared with
 * `npm run user:countries`. Notably an unknown code is an error naming it, not
 * dropped: the admin has to learn their list was wrong, and a silent drop would
 * look like a grant that was saved.
 *
 * A grant stored on an ADMIN or DEVELOPER is harmless and changes nothing
 * (they see every client by role), so it is not refused here; the page simply
 * does not offer the editor for one. The change reaches a signed-in user within
 * a few minutes, when their session next re-reads the database (src/auth.ts).
 */
export async function setContactsVisibility(
  userId: string,
  allCountries: boolean,
  codes: string[]
): Promise<ActionResult> {
  await requireAdmin();

  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return { error: "User not found" };

  const grant = grantFromSelection(allCountries, codes);
  if (!grant.ok) {
    // The parser's messages are written for a terminal ("not a known
    // country: ..."); this one is shown in a form.
    return { error: grant.error.charAt(0).toUpperCase() + grant.error.slice(1) };
  }

  await db.user.update({ where: { id: user.id }, data: { visibleCountries: grant.countries } });

  revalidateUser(user.id);
  return {};
}
