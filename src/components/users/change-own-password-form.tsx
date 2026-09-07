"use client";

import { SetPasswordForm } from "@/components/users/set-password-form";
import type { ActionResult } from "@/lib/actions/users";

/**
 * The Account card's "change my password" control. A thin wrapper over
 * `SetPasswordForm` — same single field, same transition+toast behaviour,
 * same "no confirmation field" decision (a typo just means changing it
 * again). It exists as its own component only so the Account page names
 * what it is rendering, and so the two call sites can diverge later without
 * one of them silently inheriting the other's copy.
 */
export function ChangeOwnPasswordForm({
  action,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
}) {
  return <SetPasswordForm action={action} />;
}
