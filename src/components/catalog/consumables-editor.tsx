"use client";

import { useState, useTransition } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldInputClass } from "@/components/ui-kit/field-row";
import { useToast } from "@/components/ui-kit/toast";
import { cn } from "@/lib/utils";

export type ConsumableCandidate = { id: string; code: string; name: string };
type Row = { consumableId: string; code: string; name: string; qty: number };

/**
 * The consumables a tool goes on a quote with (see OptionConsumable): the
 * blades a drag knife can take, the drills a punch can take. A quote picks
 * exactly one of them with the tool, and gets `qty` of it at no charge; a
 * tool with a single consumable gets it without asking.
 *
 * Same "edit freely, save the whole list once" shape as
 * `ConflictGroupMembersEditor`. The order here is the order the options
 * editor lists them in.
 */
export function ConsumablesEditor({
  toolId,
  candidates,
  initial,
  action,
  readOnly = false,
}: {
  toolId: string;
  /** Every option that could be listed -- the tool itself excluded. */
  candidates: ConsumableCandidate[];
  initial: Row[];
  action: (toolId: string, items: { consumableId: string; qty: number }[]) => Promise<{ error?: string }>;
  readOnly?: boolean;
}) {
  const [rows, setRows] = useState<Row[]>(initial);
  const [search, setSearch] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const listed = new Set(rows.map((row) => row.consumableId));
  const query = search.trim().toLowerCase();
  const matches = query
    ? candidates
        .filter((option) => !listed.has(option.id))
        .filter(
          (option) => option.code.toLowerCase().includes(query) || option.name.toLowerCase().includes(query)
        )
        .slice(0, 8)
    : [];

  function add(option: ConsumableCandidate) {
    setRows((prev) => [...prev, { consumableId: option.id, code: option.code, name: option.name, qty: 1 }]);
    setSearch("");
    setError(null);
  }

  function remove(consumableId: string) {
    setRows((prev) => prev.filter((row) => row.consumableId !== consumableId));
    setError(null);
  }

  function setQty(consumableId: string, qty: number) {
    setRows((prev) => prev.map((row) => (row.consumableId === consumableId ? { ...row, qty } : row)));
  }

  function save() {
    startTransition(async () => {
      const result = await action(
        toolId,
        rows.map((row) => ({ consumableId: row.consumableId, qty: row.qty }))
      );
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      toast.success("Consumables saved");
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">No consumables — this option is sold on its own.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-slate-100 rounded-lg border border-slate-200">
          {rows.map((row) => (
            <li key={row.consumableId} className="flex min-h-11 items-center gap-3 px-3 py-2 text-sm">
              <span className="font-mono text-xs text-slate-500">{row.code}</span>
              <span className="min-w-0 flex-1 truncate font-medium text-brand-dark">{row.name}</span>
              <label className="flex items-center gap-1.5 text-xs text-slate-500">
                Qty
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={999}
                  value={row.qty}
                  disabled={readOnly}
                  onChange={(event) => setQty(row.consumableId, Math.max(1, Number(event.target.value) || 1))}
                  className={cn(fieldInputClass, "h-9 w-16 text-center")}
                />
              </label>
              {readOnly ? null : (
                <button
                  type="button"
                  onClick={() => remove(row.consumableId)}
                  aria-label={`Remove ${row.code}`}
                  className="focus-ring flex size-9 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-destructive"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {readOnly ? null : (
        <>
          <div className="relative">
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Add a consumable — search by code or name…"
              aria-label="Add a consumable"
              autoComplete="off"
              className={cn(fieldInputClass, "h-11 sm:h-9")}
            />
            {matches.length > 0 ? (
              <ul className="mt-1 flex flex-col rounded-lg border border-slate-200 bg-white shadow-sm">
                {matches.map((option) => (
                  <li key={option.id}>
                    <button
                      type="button"
                      onClick={() => add(option)}
                      className="focus-ring flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50"
                    >
                      <span className="font-mono text-xs text-slate-500">{option.code}</span>
                      <span className="min-w-0 truncate text-brand-dark">{option.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <Button variant="brand" type="button" onClick={save} disabled={pending} className="h-11 w-full sm:w-fit">
            {pending ? "Saving…" : "Save consumables"}
          </Button>
        </>
      )}
    </div>
  );
}
