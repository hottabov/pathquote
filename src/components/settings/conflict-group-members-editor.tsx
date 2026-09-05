"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";

export type ConflictGroupOptionRow = { id: string; code: string; name: string };

/**
 * Membership checkboxes for one `OptionConflictGroup` — every option in the
 * catalogue, checked for the ones currently in this group. Same
 * "send the full desired set, let the action diff it" shape as
 * `CompatEditor`/`CatalogVisibilityEditor`: the admin toggles freely
 * client-side, then one Save call reconciles the whole set against
 * `OptionConflictGroupMember` at once.
 *
 * Replaces the old per-option `ConflictEditor`, which listed every *other*
 * option (a pairwise conflict was "this option vs every other"). Nothing is
 * excluded here — a group's own members ARE the "every option" list, since
 * this editor edits membership directly rather than one option's
 * relationship outward to every other option.
 */
export function ConflictGroupMembersEditor({
  groupId,
  options,
  initialSelected,
  action,
}: {
  groupId: string;
  options: ConflictGroupOptionRow[];
  initialSelected: string[];
  action: (groupId: string, optionIds: string[]) => Promise<{ error?: string }>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelected));
  const [search, setSearch] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const query = search.trim().toLowerCase();
  const filteredOptions = query
    ? options.filter(
        (option) =>
          option.code.toLowerCase().includes(query) || option.name.toLowerCase().includes(query)
      )
    : options;

  function toggle(id: string) {
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
      const res = await action(groupId, Array.from(selected));
      if (res.error) {
        setError(res.error);
        return;
      }
      setError(null);
      toast.success("Members saved");
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {options.length === 0 ? (
        <p className="text-sm text-slate-500">No options in the catalogue yet.</p>
      ) : (
        <>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search options…"
            aria-label="Search options"
            className={cn(fieldInputClass, "h-11 sm:h-9")}
          />
          {filteredOptions.length === 0 ? (
            <p className="text-sm text-slate-500">No options match &ldquo;{search}&rdquo;.</p>
          ) : (
            <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200">
              {filteredOptions.map((o) => {
                const active = selected.has(o.id);
                return (
                  <label
                    key={o.id}
                    htmlFor={`conflict-group-member-${o.id}`}
                    className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0 transition-colors hover:bg-slate-50"
                  >
                    <input
                      id={`conflict-group-member-${o.id}`}
                      type="checkbox"
                      checked={active}
                      onChange={() => toggle(o.id)}
                      className="size-4 shrink-0 rounded border-slate-300 accent-brand"
                    />
                    <span className="font-mono text-xs text-slate-500">{o.code}</span>
                    <span className="min-w-0 truncate font-medium text-brand-dark">{o.name}</span>
                  </label>
                );
              })}
            </div>
          )}
        </>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {options.length > 0 && (
        <Button
          type="button"
          onClick={save}
          disabled={pending}
          className="h-11 w-full bg-brand text-white hover:bg-brand/90 sm:w-fit"
        >
          {pending ? "Saving…" : "Save members"}
        </Button>
      )}
    </div>
  );
}
