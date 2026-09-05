"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/ui-kit/client";
import type { ActionResult } from "@/lib/actions/settings";

/**
 * ADMIN-only editor for the "ui.showOptionIcons" app setting, rendered in
 * the Preferences card on the main /settings page alongside
 * `QuoteValidityForm`. Calls the same `updateSetting` action (bound to
 * "ui.showOptionIcons" by the settings page, exactly like
 * `QuoteValidityForm` binds it to "quote.validityDays") — but since this is
 * a checkbox rather than a text field, and a native unchecked checkbox
 * simply omits itself from `FormData` (which `showOptionIconsSchema`'s
 * literal "true"/"false" strings wouldn't accept), `handleChange` builds its
 * own `FormData` instead of reading the `<form>`'s. Commits immediately on
 * toggle (no separate Save step) and reverts optimistically on failure —
 * the same shape as `ItemShowImageToggle` and `PriceDisplayToggles`.
 */
export function ShowOptionIconsForm({
  action,
  defaultValue,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  defaultValue: boolean;
}) {
  const [checked, setChecked] = useState(defaultValue);
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  function handleChange(next: boolean) {
    setChecked(next);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("value", next ? "true" : "false");
      const result = await action(formData);
      if (result?.error) {
        setChecked(!next);
        toast.error(result.error);
        return;
      }
      toast.success("Saved");
    });
  }

  return (
    <label className="flex h-11 items-center justify-between gap-3">
      <span className="text-sm font-medium text-brand-dark">Show option icons</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={pending}
        onChange={(event) => handleChange(event.target.checked)}
        className="size-4 rounded border-slate-300 accent-brand disabled:cursor-not-allowed"
      />
    </label>
  );
}
