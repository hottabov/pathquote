"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/ui-kit/client";
import { setItemShowImage } from "@/lib/actions/documents";

/**
 * "Show image in PDF" checkbox on an item card — only ever rendered when
 * the item's product actually has an image (see `BuilderItem.productHasImage`
 * in src/lib/queries/documents.ts); an item with no snapshotted image has
 * nothing to toggle. Flips `DocumentItem.showImage` immediately on click —
 * unlike `ItemDiscountField` there's no intermediate value to type before
 * committing, so there's no separate "Save" step. Optimistic: the checkbox
 * reflects the clicked state right away and reverts if `setItemShowImage`
 * rejects it, same failure-recovery shape as `RemoveItemButton`.
 */
export function ItemShowImageToggle({
  itemId,
  showImage,
}: {
  itemId: string;
  showImage: boolean;
}) {
  const toast = useToast();
  const [checked, setChecked] = useState(showImage);
  const [pending, startTransition] = useTransition();

  function handleChange(next: boolean) {
    setChecked(next);
    startTransition(async () => {
      const result = await setItemShowImage(itemId, next);
      if (result?.error) {
        setChecked(!next);
        toast.error(result.error);
      }
    });
  }

  return (
    <label className="flex h-11 items-center gap-2 text-xs font-medium text-slate-500">
      <input
        type="checkbox"
        checked={checked}
        disabled={pending}
        onChange={(event) => handleChange(event.target.checked)}
        className="size-4 rounded border-slate-300 accent-brand disabled:cursor-not-allowed"
      />
      Show image in PDF
    </label>
  );
}
