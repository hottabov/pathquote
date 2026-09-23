"use client";

import { useState, useTransition } from "react";
import { Copy, Eye, EyeOff, Trash2 } from "lucide-react";
import { ItemDiscountField } from "@/components/builder/item-discount-field";
import { Tooltip, useConfirm, useToast } from "@/components/ui-kit/client";
import { duplicateItem, removeItem, setItemShowImage } from "@/lib/actions/documents";
import { cn } from "@/lib/utils";
import type { DiscountMode } from "@prisma/client";

/**
 * Everything that is true of the machine rather than of one of its tabs:
 * its discount on the left, and on the right the three things you can do to
 * the whole line.
 *
 * The row sits *under* the sub-tab strip, not inside Price, where the first
 * draft of this redesign put it. A tab holds what its label names, and
 * delete does not belong a mis-click away from a number field.
 *
 * Icons with a delayed tooltip rather than an overflow menu, for two
 * reasons: a popover would have to escape the disclosure's
 * `overflow-hidden` wrapper, and the row exists precisely so that every
 * action is visible without a guess. Each one keeps its own `aria-label`,
 * which is what a screen reader announces -- the tooltip is for sighted
 * users and is not announced twice.
 */

const iconButton =
  "focus-ring flex size-11 items-center justify-center rounded-(--radius-control) text-slate-500 transition-colors duration-(--duration-micro) ease-out-soft motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-40 md:hover:bg-slate-100 md:hover:text-brand-dark";

export function ItemActionBar({
  itemId,
  itemName,
  isCredit,
  productHasImage,
  showImage,
  discountMode,
  discountValue,
  currency,
  currencySymbol,
  readOnly = false,
}: {
  itemId: string;
  itemName: string;
  /** A credit item (the TRADE-IN product) is already a negative line, so a
   * discount on it is meaningless and, entered by accident, silently wrong.
   * The control does not exist for it rather than being disabled. See
   * `setItemDiscount`'s own guard for the server-side half. */
  isCredit: boolean;
  productHasImage: boolean;
  showImage: boolean;
  discountMode: DiscountMode;
  discountValue: string | null;
  currency: string;
  currencySymbol: string | null;
  readOnly?: boolean;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  // Optimistic, and reverted by the server's own answer -- same shape the
  // old standalone checkbox had.
  const [photoOn, setPhotoOn] = useState(showImage);
  const [photoPending, startPhoto] = useTransition();
  const [copyPending, startCopy] = useTransition();
  const [deletePending, startDelete] = useTransition();

  function togglePhoto() {
    const next = !photoOn;
    setPhotoOn(next);
    startPhoto(async () => {
      const result = await setItemShowImage(itemId, next);
      if (result?.error) {
        setPhotoOn(!next);
        toast.error(result.error);
      }
    });
  }

  function duplicate() {
    startCopy(async () => {
      const result = await duplicateItem(itemId);
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      // A concession warning is the server telling us the copy pushed the
      // document past its discount cap. It is not a failure -- the copy
      // exists -- so it is surfaced rather than swallowed.
      if (result?.warning) toast.error(result.warning);
      else toast.success(`Duplicated ${itemName}`);
    });
  }

  async function remove() {
    const confirmed = await confirm({
      title: `Remove ${itemName}?`,
      description: "You can add it back afterwards if this was a mistake.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!confirmed) return;
    startDelete(async () => {
      const result = await removeItem(itemId);
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      toast.success(`Removed ${itemName}`);
    });
  }

  if (readOnly) {
    if (isCredit) return null;
    const discount = (
      <ItemDiscountField
        itemId={itemId}
        discountMode={discountMode}
        discountValue={discountValue}
        currency={currency}
        currencySymbol={currencySymbol}
        readOnly
      />
    );
    // ItemDiscountField renders nothing at all for a zero discount in
    // read-only mode, and a bare divider under an empty row is worse than
    // no row, so the border comes with the content or not at all.
    if (!discountValue || Number(discountValue) === 0) return null;
    return <div className="mt-4 border-t border-divider pt-3">{discount}</div>;
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-divider pt-3">
      {!isCredit ? (
        <ItemDiscountField
          itemId={itemId}
          discountMode={discountMode}
          discountValue={discountValue}
            currency={currency}
          currencySymbol={currencySymbol}
        />
      ) : null}

      <div className="ml-auto flex items-center gap-1">
        {productHasImage ? (
          <Tooltip label={photoOn ? "Hide photo in the PDF" : "Show photo in the PDF"}>
            <button
              type="button"
              onClick={togglePhoto}
              disabled={photoPending}
              aria-pressed={photoOn}
              aria-label={photoOn ? "Hide photo in the PDF" : "Show photo in the PDF"}
              className={cn(iconButton, photoOn && "text-brand")}
            >
              {photoOn ? (
                <Eye className="size-4" aria-hidden="true" />
              ) : (
                <EyeOff className="size-4" aria-hidden="true" />
              )}
            </button>
          </Tooltip>
        ) : null}

        <Tooltip label="Duplicate this item">
          <button
            type="button"
            onClick={duplicate}
            disabled={copyPending}
            aria-label={`Duplicate ${itemName}`}
            className={iconButton}
          >
            <Copy className="size-4" aria-hidden="true" />
          </button>
        </Tooltip>

        <Tooltip label="Remove this item">
          <button
            type="button"
            onClick={remove}
            disabled={deletePending}
            aria-label={`Remove ${itemName}`}
            className={cn(iconButton, "md:hover:bg-rose-50 md:hover:text-rose-600")}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
