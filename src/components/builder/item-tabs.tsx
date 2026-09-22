"use client";

import { useId, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The sub-tabs inside an expanded item card: Options, Spec, Price, one panel
 * visible at a time.
 *
 * What this replaces is two sibling disclosures whose trigger buttons shared
 * a byte-identical class string and were told apart only by their label,
 * stacked above a breakdown that was always open. Opening a machine meant
 * deciding which of two identical-looking buttons to press, and any machine
 * whose panels were both open was taller than the screen.
 *
 * Which sub-tab of which machine is open is local state, not URL state. It
 * is not worth a history entry, and three machines open at once would need
 * three parameters to describe.
 *
 * A tab holds what its label names and nothing else. Anything global to the
 * machine -- its discount, whether its photo prints, duplicating it,
 * deleting it -- belongs under the strip, not inside Price where an earlier
 * draft put it: delete does not belong a mis-click away from a number field.
 */
export type ItemTab = {
  key: string;
  label: string;
  /** A count or a warning beside the label -- the option count, the number
   * of missing spec answers. Rendered inside the tab, so keep it to a word
   * or a number. */
  badge?: React.ReactNode;
  content: React.ReactNode;
};

export function ItemTabs({ tabs, defaultTab }: { tabs: ItemTab[]; defaultTab?: string }) {
  const baseId = useId();
  const [active, setActive] = useState(
    () => tabs.find((tab) => tab.key === defaultTab)?.key ?? tabs[0]?.key ?? ""
  );

  if (tabs.length === 0) return null;
  // One tab is not a choice. A strip of exactly one button would read as a
  // filter someone had left applied.
  if (tabs.length === 1) return <div>{tabs[0]!.content}</div>;

  // Guards against a tab disappearing under the selection -- an EasyLoader
  // whose last compatible option is removed, say.
  const current = tabs.some((tab) => tab.key === active) ? active : tabs[0]!.key;

  /** Roving focus, as the tablist pattern requires: the strip is one tab
   * stop and the arrow keys move between tabs inside it. */
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const delta =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "Home" ? 0 : event.key === "End" ? 0 : null;
    if (delta === null) return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.key === current);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
        ? tabs.length - 1
        : (index + delta + tabs.length) % tabs.length;
    const key = tabs[next]!.key;
    setActive(key);
    document.getElementById(`${baseId}-tab-${key}`)?.focus();
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Item details"
        onKeyDown={onKeyDown}
        className="flex items-center gap-1 border-b border-divider"
      >
        {tabs.map((tab) => {
          const selected = tab.key === current;
          return (
            <button
              key={tab.key}
              id={`${baseId}-tab-${tab.key}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${tab.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(tab.key)}
              className={cn(
                "focus-ring relative -mb-px flex h-9 items-center gap-1.5 rounded-t-(--radius-control) border-b-2 px-3 text-sm transition-colors duration-(--duration-micro) ease-out-soft motion-reduce:transition-none",
                selected
                  ? "border-brand font-semibold text-brand"
                  : "border-transparent text-slate-500 md:hover:bg-slate-50 md:hover:text-brand-dark"
              )}
            >
              {tab.label}
              {tab.badge}
            </button>
          );
        })}
      </div>

      {tabs.map((tab) => (
        <div
          key={tab.key}
          id={`${baseId}-panel-${tab.key}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${tab.key}`}
          tabIndex={0}
          hidden={tab.key !== current}
          className="focus-ring pt-3"
        >
          {tab.key === current ? tab.content : null}
        </div>
      ))}
    </div>
  );
}
