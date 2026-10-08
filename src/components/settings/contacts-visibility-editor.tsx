"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
import { describeContactsAccess } from "@/lib/contacts-visibility";
import type { ContactsVisibility } from "@/lib/queries/contacts-visibility-admin";

/** Below this the whole list is on screen and a search box is just noise. */
const SEARCH_THRESHOLD = 12;

const count = new Intl.NumberFormat("en-US");

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((code) => b.has(code));
}

/**
 * Country checkboxes for one user's `visibleCountries`. Ticking SHOWS.
 *
 * This agrees with `CatalogVisibilityEditor`, which sits directly above it on
 * the same page: in both a tick grants, and both share an interaction (toggle
 * freely in local state, one Save sends the whole desired set and the action
 * reconciles it). Every label here says "show", the list is headed "Tick a
 * country to show its clients", a ticked row is tagged "Clients shown", and a
 * sentence under the "all countries" switch restates the effect of the current
 * selection in plain words as it changes -- see `describeContactsAccess`. Unlike
 * the catalogue, though, nothing ticked is the dangerous state here (the user
 * sees almost no clients), so the summary warns about it.
 *
 * "All countries" is a separate switch rather than a row, because it is a
 * different kind of thing (`["*"]`, not a country). While it is on the list is
 * inert and dimmed, and whatever was ticked is kept, so switching it back off
 * restores the admin's work instead of making them redo it.
 */
export function ContactsVisibilityEditor({
  userId,
  visibility,
  regional,
  action,
}: {
  userId: string;
  visibility: ContactsVisibility;
  /** The user is a REGIONAL_MANAGER, who also keeps the clients their region owns. */
  regional: boolean;
  action: (userId: string, allCountries: boolean, codes: string[]) => Promise<{ error?: string }>;
}) {
  const { countries, companiesWithoutCountry } = visibility;

  // What was last saved, to tell the admin whether the summary they are
  // reading is already in force. Moves forward on a successful save.
  const [saved, setSaved] = useState(() => ({
    all: visibility.allCountries,
    codes: new Set(countries.filter((c) => c.selected).map((c) => c.code)),
  }));
  const [allCountries, setAllCountries] = useState(visibility.allCountries);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(saved.codes));
  const [search, setSearch] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const needle = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      needle === ""
        ? countries
        : countries.filter(
            (c) => c.name.toLowerCase().includes(needle) || c.code.toLowerCase().includes(needle)
          ),
    [countries, needle]
  );

  const selectedCompanies = countries.reduce((sum, c) => sum + (selected.has(c.code) ? c.companies : 0), 0);
  const access = describeContactsAccess({
    allCountries,
    selectedCountries: selected.size,
    selectedCompanies,
    regional,
  });
  const dirty = allCountries !== saved.all || !sameSet(selected, saved.codes);
  const filteredAllTicked = filtered.length > 0 && filtered.every((c) => selected.has(c.code));
  const filteredNoneTicked = filtered.every((c) => !selected.has(c.code));

  function toggle(code: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
    setError(null);
  }

  function setFiltered(on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of filtered) {
        if (on) next.add(c.code);
        else next.delete(c.code);
      }
      return next;
    });
    setError(null);
  }

  function save() {
    startTransition(async () => {
      const codes = Array.from(selected);
      const res = await action(userId, allCountries, codes);
      if (res.error) {
        setError(res.error);
        return;
      }
      setError(null);
      setSaved({ all: allCountries, codes: new Set(selected) });
      toast.success("Contacts visibility saved");
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <label
        htmlFor="visibility-all-countries"
        className={cn(
          "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-slate-50",
          allCountries ? "border-brand bg-brand/5" : "border-slate-200"
        )}
      >
        <input
          id="visibility-all-countries"
          type="checkbox"
          checked={allCountries}
          onChange={(e) => {
            setAllCountries(e.target.checked);
            setError(null);
          }}
          className="mt-0.5 size-4 shrink-0 rounded border-slate-300 accent-brand"
        />
        <span className="flex min-w-0 flex-col">
          <span className="font-medium text-brand-dark">Show clients from all countries</span>
          <span className="text-xs text-slate-500">
            Removes the country limit. Leave it off to choose the countries below.
          </span>
        </span>
      </label>

      {/* The effect of the selection as it stands now, in words. */}
      <div
        aria-live="polite"
        className={cn(
          "rounded-lg border px-3 py-2 text-sm",
          access.tone === "none"
            ? "border-amber-300 bg-amber-50 text-amber-800"
            : "border-slate-200 bg-slate-50 text-slate-700"
        )}
      >
        <p className="flex items-start gap-2">
          {access.tone === "none" ? (
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          ) : null}
          <span className="font-medium">{access.summary}</span>
        </p>
        {access.warning ? <p className="mt-1">{access.warning}</p> : null}
        {dirty ? <p className="mt-1 text-xs opacity-80">Not saved yet.</p> : null}
      </div>

      {countries.length === 0 ? (
        <p className="text-sm text-slate-500">
          No client has a country yet, so there is nothing to choose. Turn on &ldquo;Show clients from all
          countries&rdquo; to give this user every client.
        </p>
      ) : (
        <div className={cn("flex flex-col gap-3", allCountries && "opacity-60")}>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <p id="visibility-countries-heading" className="text-sm font-medium text-brand-dark">
              Tick a country to <span className="underline underline-offset-2">show</span> its clients
            </p>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                type="button"
                onClick={() => setFiltered(true)}
                disabled={allCountries || filtered.length === 0 || filteredAllTicked}
                className="h-9 px-2 text-brand-dark"
              >
                {needle ? `Tick ${count.format(filtered.length)} matching` : "Tick all"}
              </Button>
              <Button
                variant="ghost"
                type="button"
                onClick={() => setFiltered(false)}
                disabled={allCountries || filtered.length === 0 || filteredNoneTicked}
                className="h-9 px-2 text-brand-dark"
              >
                {needle ? "Untick matching" : "Untick all"}
              </Button>
            </div>
          </div>

          {countries.length > SEARCH_THRESHOLD ? (
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search countries…"
              aria-label="Search countries"
              disabled={allCountries}
              className={cn(fieldInputClass, "h-11 sm:h-9")}
            />
          ) : null}

          {filtered.length === 0 ? (
            <p className="rounded-lg border border-slate-200 px-3 py-3 text-sm text-slate-500">
              No country matches &ldquo;{search.trim()}&rdquo;. Try the country&rsquo;s name or its two-letter
              code, such as &ldquo;Germany&rdquo; or &ldquo;DE&rdquo;. Only countries that already have clients
              are listed.{" "}
              <button
                type="button"
                onClick={() => setSearch("")}
                className="font-medium text-brand-dark underline underline-offset-2"
              >
                Clear search
              </button>
            </p>
          ) : (
            <div
              role="group"
              aria-labelledby="visibility-countries-heading"
              className="max-h-80 overflow-y-auto rounded-lg border border-slate-200"
            >
              {filtered.map((c) => {
                const ticked = selected.has(c.code);
                return (
                  <label
                    key={c.code}
                    htmlFor={`visibility-country-${c.code}`}
                    className={cn(
                      "flex min-h-11 items-center gap-3 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0 transition-colors",
                      allCountries ? "cursor-not-allowed" : "cursor-pointer hover:bg-slate-50",
                      ticked && "bg-brand/5"
                    )}
                  >
                    <input
                      id={`visibility-country-${c.code}`}
                      type="checkbox"
                      checked={ticked}
                      disabled={allCountries}
                      onChange={() => toggle(c.code)}
                      className="size-4 shrink-0 rounded border-slate-300 accent-brand"
                    />
                    <span className="font-mono text-xs text-slate-500">{c.code}</span>
                    <span className="min-w-0 truncate font-medium text-brand-dark">{c.name}</span>
                    {ticked ? (
                      <span className="shrink-0 text-xs font-medium text-emerald-700">
                        <span className="sm:hidden">Shown</span>
                        <span className="hidden sm:inline">Clients shown</span>
                      </span>
                    ) : null}
                    <span
                      className={cn(
                        "ml-auto shrink-0 text-xs tabular-nums",
                        c.companies === 0 ? "text-slate-400" : "text-slate-600"
                      )}
                    >
                      {c.companies === 0
                        ? "No clients yet"
                        : `${count.format(c.companies)} ${c.companies === 1 ? "client" : "clients"}`}
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          <p className="text-xs text-slate-500">
            Only countries that have clients are listed, plus any this user was already given.
          </p>
        </div>
      )}

      {companiesWithoutCountry > 0 ? (
        <p className="text-xs text-slate-500">
          {count.format(companiesWithoutCountry)} {companiesWithoutCountry === 1 ? "client has" : "clients have"}{" "}
          no country (blank, or text that is not a country code). No selection here reveals{" "}
          {companiesWithoutCountry === 1 ? "it" : "them"}; only the owner and admins see{" "}
          {companiesWithoutCountry === 1 ? "it" : "them"}.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button
          variant="brand"
          type="button"
          onClick={save}
          disabled={pending}
          className="h-11 w-full sm:w-fit"
        >
          {pending ? "Saving…" : "Save contacts visibility"}
        </Button>
        <p className="text-xs text-slate-500">
          Reaches a signed-in user within a few minutes, or at their next sign-in.
        </p>
      </div>
    </div>
  );
}
