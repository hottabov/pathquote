"use client";

import { useState } from "react";
import { Check, GitMerge, Pencil, Plus, Tags, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldInputClass } from "@/components/ui-kit";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import {
  addIndustryAlias,
  createIndustry,
  deleteIndustry,
  deleteIndustryAlias,
  mergeIndustries,
  renameIndustry,
} from "@/lib/actions/industries";
import type { IndustryAdminListItem } from "@/lib/queries/industries";
import { cn } from "@/lib/utils";

/**
 * Shared classes for this list's row buttons. 44px on touch, 32px from md up.
 *
 * The single-size 44px button this replaced made every row ~76px tall, which
 * read as a form rather than as a list next to the app's other settings
 * tables (Regions, Users) whose rows are px-4 py-3 and about 48px. The
 * breakpoint is the honest split here: the 44px minimum exists for fingers,
 * and md+ is where the pointer is a mouse. A row of four icon buttons is the
 * one place in this app where holding 44px on desktop costs the whole
 * screen's density.
 */
const rowButtonClass =
  "focus-ring size-11 shrink-0 text-slate-400 hover:bg-slate-100 hover:text-brand-dark md:size-8";

/**
 * The whole industry list, with the things the inline picker on a client card
 * cannot do: see every row at once with how many companies use it, record the
 * other spellings that should find it, delete one nothing uses, and merge a
 * duplicate into the row that should have had it.
 *
 * Every row is shared across every manager, so nothing here is scoped and
 * nothing here is undoable — the page that mounts this is ADMIN-only, and the
 * two destructive actions confirm by name and by count first. Aliases are the
 * exception on both counts: they print nowhere and deleting one only narrows
 * what a future import matches, so they add and remove without a confirm.
 *
 * No local mirror of the list. Each action revalidates `/settings/industries`
 * server-side, so a successful call re-renders this component with fresh props,
 * the same way the client card's picker works. The only state here is which row
 * is currently being edited, merged or aliased, which is genuinely local.
 */
export function IndustryAdminList({ industries }: { industries: IndustryAdminListItem[] }) {
  const confirm = useConfirm();
  const toast = useToast();

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState("");

  // Exactly one row is ever open, in exactly one mode: a rename box, a merge
  // picker and an alias editor on the same row would be three answers to
  // "what is this row about to become". Opening any one closes the others.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [aliasingId, setAliasingId] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");

  /** Runs one action, surfacing its error inline and its success as a toast. */
  async function run(action: () => Promise<{ error?: string }>, success: string): Promise<boolean> {
    setPending(true);
    setError(null);
    const result = await action();
    setPending(false);
    if (result.error) {
      setError(result.error);
      return false;
    }
    toast.success(success);
    return true;
  }

  async function add() {
    const name = newName.trim();
    if (!name) return;
    // `createIndustry` returns the existing row's id for a case-insensitive
    // match — or for a match against an alias — rather than failing, so
    // "added" would be a lie for those cases. It does not tell us which
    // happened, and the list below is the honest answer either way: after the
    // revalidate the name is in it, once.
    if (await run(() => createIndustry(name), `"${name}" is in the list.`)) {
      setNewName("");
    }
  }

  function closeRowModes() {
    setEditingId(null);
    setMergingId(null);
    setAliasingId(null);
    setError(null);
  }

  function startEdit(industry: IndustryAdminListItem) {
    closeRowModes();
    setEditingId(industry.id);
    setEditName(industry.name);
  }

  function startMerge(industry: IndustryAdminListItem) {
    closeRowModes();
    setMergingId(industry.id);
    setMergeTargetId("");
  }

  function startAliases(industry: IndustryAdminListItem) {
    closeRowModes();
    setAliasingId(industry.id);
    setAliasDraft("");
  }

  async function saveEdit(industry: IndustryAdminListItem) {
    const name = editName.trim();
    if (!name || name === industry.name) {
      setEditingId(null);
      return;
    }
    const reach =
      industry.companyCount === 0
        ? "No companies use it yet."
        : `${industry.companyCount} ${industry.companyCount === 1 ? "company uses" : "companies use"} it, and all of them will show the new name.`;
    const ok = await confirm({
      title: `Rename "${industry.name}" to "${name}"?`,
      description: `${reach} Production forms print this name too.`,
      confirmLabel: "Rename",
    });
    if (!ok) return;
    if (await run(() => renameIndustry(industry.id, name), `Renamed to "${name}".`)) {
      setEditingId(null);
    }
  }

  async function remove(industry: IndustryAdminListItem) {
    const ok = await confirm({
      title: `Delete "${industry.name}"?`,
      description:
        industry.aliases.length > 0
          ? `Nothing uses it. Its ${industry.aliases.length === 1 ? "alias goes" : `${industry.aliases.length} aliases go`} with it. This can't be undone.`
          : "Nothing uses it. This can't be undone.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    await run(() => deleteIndustry(industry.id), `Deleted "${industry.name}".`);
  }

  async function merge(source: IndustryAdminListItem) {
    const target = industries.find((i) => i.id === mergeTargetId);
    if (!target) return;
    const moving =
      source.companyCount === 0
        ? "It has no companies to move."
        : `${source.companyCount} ${source.companyCount === 1 ? "company moves" : "companies move"} to "${target.name}".`;
    const ok = await confirm({
      title: `Merge "${source.name}" into "${target.name}"?`,
      description: `${moving} "${source.name}" is then deleted, and kept as an alias of "${target.name}" so an import using the old name still lands there. This can't be undone.`,
      confirmLabel: "Merge",
      tone: "danger",
    });
    if (!ok) return;
    if (await run(() => mergeIndustries(source.id, target.id), `Merged into "${target.name}".`)) {
      setMergingId(null);
    }
  }

  async function addAlias(industry: IndustryAdminListItem) {
    const name = aliasDraft.trim();
    if (!name) return;
    if (await run(() => addIndustryAlias(industry.id, name), `"${name}" now finds "${industry.name}".`)) {
      setAliasDraft("");
    }
  }

  async function removeAlias(alias: { id: string; name: string }) {
    await run(() => deleteIndustryAlias(alias.id), `Removed "${alias.name}".`);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
          maxLength={80}
          placeholder="Add an industry"
          aria-label="New industry name"
          disabled={pending}
          className={fieldInputClass}
        />
        <Button
          type="button"
          onClick={() => void add()}
          disabled={pending || !newName.trim()}
          className="h-11 shrink-0 bg-brand text-white hover:bg-brand/90 sm:w-auto"
        >
          <Plus className="size-4" data-icon="inline-start" aria-hidden="true" />
          Add
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {/* Nothing rather than an empty bordered box — the page above says why
          the list is empty. */}
      <ul
        className={cn(
          "flex flex-col divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white",
          industries.length === 0 && "hidden"
        )}
      >
        {industries.map((industry) => {
          const editing = editingId === industry.id;
          const merging = mergingId === industry.id;
          const aliasing = aliasingId === industry.id;
          // Merging into itself would delete the row every company was just
          // moved onto — the action refuses it, and so does this list.
          const mergeTargets = industries.filter((i) => i.id !== industry.id);

          return (
            <li key={industry.id} className="flex flex-col gap-2 px-3 py-2 sm:px-4">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {editing ? (
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void saveEdit(industry);
                      }
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    maxLength={80}
                    aria-label={`Rename ${industry.name}`}
                    autoFocus
                    disabled={pending}
                    className={cn(fieldInputClass, "min-w-0 flex-1")}
                  />
                ) : (
                  /* The industry name alone. The aliases live in the editor
                     below, as chips — after the ACT seed most rows carry
                     several, and spelling them out here turned the list into a
                     wall of grey text with the names lost inside it. The tag
                     button says which rows have them. */
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-brand-dark">
                    {industry.name}
                  </span>
                )}

                <span className="shrink-0 text-sm text-slate-500 tabular-nums">
                  {industry.companyCount}{" "}
                  {industry.companyCount === 1 ? "company" : "companies"}
                </span>

                {editing ? (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => void saveEdit(industry)}
                      disabled={pending}
                      aria-label={`Save name for ${industry.name}`}
                      className={rowButtonClass}
                    >
                      <Check className="size-4" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setEditingId(null)}
                      disabled={pending}
                      aria-label="Cancel rename"
                      className={rowButtonClass}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => startEdit(industry)}
                      disabled={pending}
                      aria-label={`Rename ${industry.name}`}
                      className={rowButtonClass}
                    >
                      <Pencil className="size-4" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => (aliasing ? setAliasingId(null) : startAliases(industry))}
                      disabled={pending}
                      aria-label={
                        industry.aliases.length > 0
                          ? `Edit ${industry.aliases.length} ${industry.aliases.length === 1 ? "alias" : "aliases"} for ${industry.name}`
                          : `Add an alias for ${industry.name}`
                      }
                      aria-expanded={aliasing}
                      // Tinted when the row has aliases. The only thing left
                      // distinguishing those rows now that the names are gone
                      // from the line, and it costs no width — a count or a
                      // list here would put back the clutter this removed.
                      className={cn(
                        rowButtonClass,
                        industry.aliases.length > 0 && "text-brand",
                        aliasing && "bg-slate-100 text-brand-dark"
                      )}
                    >
                      <Tags className="size-4" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => (merging ? setMergingId(null) : startMerge(industry))}
                      disabled={pending || mergeTargets.length === 0}
                      aria-label={`Merge ${industry.name} into another industry`}
                      aria-expanded={merging}
                      className={cn(rowButtonClass, merging && "bg-slate-100 text-brand-dark")}
                    >
                      <GitMerge className="size-4" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => void remove(industry)}
                      // Deleting a row in use would blank the industry on every
                      // company that has it. The action refuses too — this only
                      // stops the click that was never going to work, and says
                      // what to do instead.
                      disabled={pending || industry.companyCount > 0}
                      title={
                        industry.companyCount > 0
                          ? "In use — merge it into another industry instead"
                          : undefined
                      }
                      aria-label={`Delete ${industry.name}`}
                      className={cn(rowButtonClass, "hover:text-destructive")}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </>
                )}
              </div>

              {aliasing ? (
                <div className="flex flex-col gap-2 rounded-lg bg-slate-50 p-3">
                  {industry.aliases.length > 0 ? (
                    <ul className="flex flex-wrap gap-1.5">
                      {industry.aliases.map((alias) => (
                        <li
                          key={alias.id}
                          className="flex min-h-11 items-center gap-1 rounded-full border border-slate-200 bg-white pl-3 text-sm text-brand-dark md:min-h-8"
                        >
                          <span className="truncate">{alias.name}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => void removeAlias(alias)}
                            disabled={pending}
                            aria-label={`Remove alias ${alias.name}`}
                            className="focus-ring size-11 shrink-0 rounded-full text-slate-400 hover:bg-slate-100 hover:text-destructive md:size-7"
                          >
                            <X className="size-3.5" aria-hidden="true" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      value={aliasDraft}
                      onChange={(e) => setAliasDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void addAlias(industry);
                        }
                        if (e.key === "Escape") setAliasingId(null);
                      }}
                      maxLength={80}
                      placeholder="Another spelling for this industry"
                      aria-label={`New alias for ${industry.name}`}
                      autoFocus
                      disabled={pending}
                      className={cn(fieldInputClass, "min-w-0 flex-1")}
                    />
                    <Button
                      type="button"
                      onClick={() => void addAlias(industry)}
                      disabled={pending || !aliasDraft.trim()}
                      className="h-11 shrink-0 bg-brand text-white hover:bg-brand/90"
                    >
                      Add alias
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setAliasingId(null)}
                      disabled={pending}
                      className="h-11 shrink-0"
                    >
                      Done
                    </Button>
                  </div>

                  {/* Said here rather than on the page header because this is
                      the one moment an admin is deciding whether a spelling is
                      worth recording. */}
                  <p className="text-xs text-slate-500">
                    Aliases never print on a quote or an order form. They only make this row the
                    answer when someone — or an import from ACT! — uses that spelling.
                  </p>
                </div>
              ) : null}

              {merging ? (
                <div className="flex flex-col gap-2 rounded-lg bg-slate-50 p-3 sm:flex-row sm:items-center">
                  <label
                    htmlFor={`merge-target-${industry.id}`}
                    className="shrink-0 text-sm text-slate-600"
                  >
                    Merge into
                  </label>
                  <select
                    id={`merge-target-${industry.id}`}
                    value={mergeTargetId}
                    onChange={(e) => setMergeTargetId(e.target.value)}
                    disabled={pending}
                    className={cn(fieldInputClass, "min-w-0 flex-1")}
                  >
                    <option value="">Select an industry…</option>
                    {mergeTargets.map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    onClick={() => void merge(industry)}
                    disabled={pending || !mergeTargetId}
                    className="h-11 shrink-0 bg-brand text-white hover:bg-brand/90"
                  >
                    Merge
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setMergingId(null)}
                    disabled={pending}
                    className="h-11 shrink-0"
                  >
                    Cancel
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
