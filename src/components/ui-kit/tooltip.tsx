"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "@/lib/utils";

/**
 * A label for a control that carries no visible text.
 *
 * The builder's per-item action row is three icon buttons, and before this the
 * app's only answer for an unlabelled control was the native `title`
 * attribute (send-to-client-button.tsx, and app-nav.tsx's icon rail at the
 * `md` breakpoint). `title` has no styling, never appears on touch, and opens
 * on a delay the page cannot influence.
 *
 * 500ms is deliberate: long enough that dragging the pointer across a row of
 * icons does not trail a string of tooltips behind it, short enough that
 * someone who has stopped to look is not left waiting. The trigger keeps its
 * own `aria-label`, which is what a screen reader announces; this is for
 * sighted users, so the popup is not also announced.
 */
export function Tooltip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side="top" sideOffset={6}>
          <TooltipPrimitive.Popup
            className={cn(
              "rounded-(--radius-control) bg-brand-dark px-2.5 py-1.5 text-xs font-medium text-white shadow-lg",
              "transition-[opacity,transform] duration-(--duration-micro) ease-out-soft motion-reduce:transition-none",
              "data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
              "data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0"
            )}
          >
            {label}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/**
 * Wrap a screen once so its tooltips share a delay group: after the first one
 * has opened, moving to the next opens immediately instead of re-waiting the
 * full 500ms, which is what makes a row of icon buttons feel like one control
 * rather than five separate waits.
 */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <TooltipPrimitive.Provider delay={500} closeDelay={0}>
      {children}
    </TooltipPrimitive.Provider>
  );
}
