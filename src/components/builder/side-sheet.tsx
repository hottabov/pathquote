"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A right-hand side sheet built on the native `<dialog>` element.
 *
 * This is the second attempt. The first used Base UI's `Dialog`, and its
 * popup would not take the viewport as its containing block in this tree:
 * the sheet landed a few hundred pixels to the right of where it belonged,
 * with part of it past the edge of the screen. A dialog opened with
 * `showModal()` is painted in the top layer, outside every ancestor's
 * stacking context, so `fixed inset-y-0 right-0` means what it says no
 * matter what the builder's wrappers do with `overflow` or `transform`.
 *
 * Going native also hands back, for free, the three things a dialog library
 * is usually imported for: Escape closes it, focus is trapped inside it and
 * restored on close, and everything behind it goes inert. What is left here
 * is a click-outside handler and one piece of state -- see `lingering`.
 *
 * The open and close transitions are pure CSS (`.side-sheet` in globals.css,
 * `@starting-style` plus `allow-discrete`), so there is no animation state
 * to keep in sync with `open`.
 */
export function SideSheet({
  open,
  onClose,
  title,
  description,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** A second line under the title -- the item's code, usually. */
  description?: string;
  /** Pinned to the bottom of the sheet. A sibling of the scrolling region
   * rather than a `sticky` child of it, so no amount of content can push it
   * out of reach. */
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // `open` goes false the instant the user closes the sheet, but the sheet
  // is still on screen sliding out for another --duration-overlay. Unmount
  // the children with it and what slides out is an empty white box, which
  // is worse than no animation at all. `lingering` keeps them until the
  // transition says it is done.
  //
  // Set during render (React's own escape hatch for state derived from
  // props) rather than in an effect, so the children are in the DOM in the
  // same commit that calls `showModal()` and the entry transition has
  // something to animate.
  const [lingering, setLingering] = useState(open);
  if (open && !lingering) setLingering(true);

  // `<dialog>` is opened imperatively; there is no `open` prop that puts it
  // in the top layer. (The `open` *attribute* shows it as a non-modal inline
  // box instead -- not what is wanted, and React would happily set it.)
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-label={title}
      // Fires for Escape and for the close button alike. Guarded because
      // the effect above also calls `close()` once the parent has already
      // set `open` false, and that would call back a second time.
      onClose={() => {
        if (open) onClose();
      }}
      // A click that lands on the dialog element itself is a click on the
      // backdrop: the box is only as big as the sheet, so anything inside
      // it reports one of the sheet's own children as the target.
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      onTransitionEnd={(event) => {
        if (event.target === dialogRef.current && !open) setLingering(false);
      }}
      className={cn(
        "side-sheet fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-dvh w-full max-w-[34rem]",
        "border-0 bg-white p-0 text-inherit shadow-2xl",
        // Not a plain `flex`: a closed dialog is `display: none`, and an
        // unconditional display utility would override that and leave the
        // sheet on screen forever.
        "open:flex open:flex-col"
      )}
    >
      {lingering ? (
        <>
          <div className="flex items-start gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-base font-semibold text-slate-900">{title}</h2>
              {description ? (
                <p className="truncate font-mono text-xs text-slate-500">{description}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="focus-ring -mr-1 flex size-9 shrink-0 items-center justify-center rounded-(--radius-control) text-slate-500 transition-colors duration-(--duration-micro) ease-out-soft hover:bg-slate-100 hover:text-slate-700 motion-reduce:transition-none"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">{children}</div>

          {footer ? <div className="border-t border-line bg-white px-4 py-3">{footer}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}
