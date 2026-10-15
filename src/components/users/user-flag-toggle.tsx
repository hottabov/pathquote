"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";

/**
 * One checkbox for a per-user yes/no an admin sets on the user-edit screen —
 * today, whether this user is shown the ACT! sync section
 * (`User.actSyncVisible`).
 *
 * It saves on change, with no Save button beside it. A single boolean has no
 * half-made state worth holding in the browser, and a Save button next to one
 * tick is a thing to forget — unlike CatalogVisibilityEditor and
 * ContactsVisibilityEditor on the same page, where an admin ticks their way
 * through a list and one save sends the whole set. The checkbox stays where
 * the admin put it while the write is in flight and snaps back if it fails,
 * so what is on screen is always what is stored.
 *
 * The label is written for the person setting it, not for the person it
 * affects: "Show the ACT! sync section to this user" says what ticking does,
 * which a column name and a permission name would not.
 */
export function UserFlagToggle({
  id,
  userId,
  visible,
  action,
  label,
  hint,
  shownToast,
  hiddenToast,
}: {
  /** The checkbox's DOM id — unique per toggle, since a page holds several. */
  id: string;
  userId: string;
  visible: boolean;
  action: (userId: string, visible: boolean) => Promise<{ error?: string }>;
  label: string;
  hint: string;
  shownToast: string;
  hiddenToast: string;
}) {
  const [checked, setChecked] = useState(visible);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  function save(next: boolean) {
    setChecked(next);
    setError(null);
    startTransition(async () => {
      const result = await action(userId, next);
      if (result.error) {
        // Back to what is actually stored. A tick left standing over a write
        // that failed is the one outcome worth preventing here: it reads as a
        // permission granted.
        setChecked(!next);
        setError(result.error);
        return;
      }
      toast.success(next ? shownToast : hiddenToast);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={id}
        className={cn(
          "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-slate-50",
          checked ? "border-brand bg-brand/5" : "border-slate-200"
        )}
      >
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={pending}
          onChange={(e) => save(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 rounded border-slate-300 accent-brand"
        />
        <span className="flex min-w-0 flex-col">
          <span className="font-medium text-brand-dark">{label}</span>
          <span className="text-xs text-slate-500">{hint}</span>
        </span>
      </label>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <p className="text-xs text-slate-500">
        Reaches a signed-in user within a few minutes, or at their next sign-in.
      </p>
    </div>
  );
}
