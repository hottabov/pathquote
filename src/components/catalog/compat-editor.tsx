"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";

export type SeriesOption = { id: string; code: string; name: string };

/**
 * Series-level compatibility checkboxes for an option. Calls the
 * `setOptionCompatibility` server action directly (not via a <form action>,
 * since it takes a plain string array rather than FormData) once the admin
 * hits Save, sending the full desired set — the action diffs it against
 * what's currently stored. Rendered as a list of full-width 44px checkbox
 * rows (rather than the compact pill layout used for read-only filters
 * elsewhere) since each row needs a comfortable touch target and room for
 * both the series code and its name. The selection is a set of series
 * *ids* (`initialSelected` too): the code is printed beside the checkbox
 * but is a label an admin can rename, so it never identifies anything here.
 */
export function CompatEditor({
  optionId,
  series,
  initialSelected,
  action,
  readOnly = false,
}: {
  optionId: string;
  series: SeriesOption[];
  /** Series ids currently compatible. */
  initialSelected: string[];
  action: (optionId: string, seriesIds: string[]) => Promise<{ error?: string }>;
  readOnly?: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelected));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  function toggle(id: string) {
    if (readOnly) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setError(null);
  }

  function save() {
    startTransition(async () => {
      const res = await action(optionId, Array.from(selected));
      if (res.error) {
        setError(res.error);
        return;
      }
      setError(null);
      toast.success("Compatibility saved");
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-slate-200">
        {series.map((s) => {
          const active = selected.has(s.id);
          return (
            <label
              key={s.id}
              htmlFor={`compat-${s.id}`}
              className={cn(
                "flex min-h-11 items-center gap-3 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0 transition-colors",
                readOnly ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:bg-slate-50"
              )}
            >
              <input
                id={`compat-${s.id}`}
                type="checkbox"
                checked={active}
                onChange={() => toggle(s.id)}
                disabled={readOnly}
                className="size-4 shrink-0 rounded border-slate-300 accent-brand disabled:cursor-not-allowed"
              />
              <span className="font-mono text-xs text-slate-500">{s.code}</span>
              <span className="min-w-0 truncate font-medium text-brand-dark">{s.name}</span>
            </label>
          );
        })}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {!readOnly && (
        <Button
          type="button"
          onClick={save}
          disabled={pending}
          className="h-11 w-full bg-brand text-white hover:bg-brand/90 sm:w-fit"
        >
          {pending ? "Saving…" : "Save compatibility"}
        </Button>
      )}
    </div>
  );
}
