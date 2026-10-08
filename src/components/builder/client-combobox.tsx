"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, Search, User } from "lucide-react";
import { fieldInputClass } from "@/components/ui-kit";
import { cn } from "@/lib/utils";
import { searchClients } from "@/lib/actions/client-search";
import {
  clientContactMatchText,
  clientLocation,
  clientSearchStatus,
  clientSearchTerm,
} from "@/lib/client-search";
import {
  defaultActiveOption,
  isListNavKey,
  moveActiveOption,
  revealScrollTop,
} from "@/lib/combobox-nav";
import type { ClientSearchCompany } from "@/lib/queries/client-search";

/** How long typing must pause before the search goes to the server. Short
 * enough to feel live, long enough that "noitex" is one request and not six --
 * which matters more than usual here, because Next.js runs Server Actions one
 * at a time per client, so every request sent also queues whatever the manager
 * does next (picking a company is another Server Action) behind it. */
const SEARCH_DEBOUNCE_MS = 200;

/** One finished search. `term` is the normalised term it answered
 * (`clientSearchTerm`), kept with the results so the list is labelled and the
 * "nothing matches" message worded for the search that produced them, not for
 * whatever has been typed since. */
type SearchOutcome = { term: string; companies: ClientSearchCompany[]; failed: boolean };

/**
 * The builder's company picker: ONE text box that is also the list. Focus it
 * and a list of the newest companies opens beneath it; type and the list
 * becomes the matches; arrow keys and Enter, or a tap, choose one.
 *
 * It replaced a search box with a separate native <select> of the results
 * under it. That was two controls where a person expects one, and the select
 * did the damage: it looks like the whole list, and typing into it runs the
 * browser's own type-ahead over the few rows it happens to hold. A manager who
 * typed "boats" into it saw nothing happen -- the search box, which would have
 * found "Ikon Boats", was the control above it. Opening the list on focus is
 * the other half of the fix: until something appears there is nothing to say
 * the box is live and searchable.
 *
 * THE SEARCH IS SERVER-SIDE, AND THAT IS NOT AN OPTIMISATION TO UNDO. The
 * builder used to be handed every company the viewer could see, each with all
 * its contacts, and filtered them in the browser ("companies are a small
 * list"). That held while the table had two rows. After the ACT! CRM import it
 * was 8,810 companies and 10,473 contacts: 2,158 kB of JSON serialised,
 * shipped and hydrated on every builder page open, against 29 ms of SQL
 * (measured on the rehearsal database, 2026-10-08). Vadym's call, for the
 * reason that a sluggish builder makes the product look amateur to the people
 * who use it all day. The page passes only the quote's own company; this asks
 * `searchClients` (src/lib/actions/client-search.ts) for up to
 * `CLIENT_SEARCH_PAGE_SIZE` companies, debounced. Do not put the full list
 * back, however convenient the instant filter was.
 *
 * It follows the ARIA combobox pattern: DOM focus stays in the input; the list
 * is a `role="listbox"` of `role="option"` rows; the input's
 * `aria-activedescendant` names the active row, which `aria-selected` marks.
 *   - ArrowDown/ArrowUp/PageDown/PageUp move the active row (and open a closed
 *     list), Enter chooses it, Escape closes, Tab leaves. The pure rules are in
 *     src/lib/combobox-nav.ts.
 *   - Once something has been typed the first match is active, so "type, Enter"
 *     picks the best match. With nothing typed no row is active, so Enter on
 *     the newest-companies list cannot choose one by accident. Enter is ignored
 *     while a newer search is in flight: the highlighted row then answers an
 *     older question than the one on screen.
 *   - Rows are not focusable and a press on the list does not move focus, so
 *     the input keeps focus (and, on a phone, the keyboard) while the list is
 *     scrolled or tapped. A press outside the combobox closes it; so does
 *     focus moving elsewhere.
 *   - The list is in the flow of the page, not floated over it. It cannot be
 *     clipped by the card it sits in or run off the screen, and on a phone it
 *     can be scrolled with the keyboard down: dismissing the keyboard does not
 *     close the list.
 *
 * Responses can arrive out of order. A slow answer for "no" must never replace
 * the answer for "noitex" typed after it. Each search effect carries a
 * `current` flag that its cleanup clears; a change of search term runs the
 * cleanup first, so a response only lands if nothing newer has superseded its
 * request. Not an AbortController: a Server Action takes no signal, so the
 * request would run to completion either way and only the answer can be
 * ignored.
 *
 * This is mounted only while the manager is choosing a company, so every
 * opening of the picker starts from nothing and fetches afresh: a company
 * created or synced since the last time is never missing from the list.
 */
export function ClientCombobox({
  disabled,
  autoFocus = false,
  onSelect,
}: {
  disabled: boolean;
  /** Focus the input when mounted, which opens the list. For when the manager
   * has just pressed "Change"; not for a page that loads with no client yet,
   * where taking focus would be rude. */
  autoFocus?: boolean;
  /** Called with the chosen company, whole: the next search replaces the
   * results, so the caller must keep what it is given. */
  onSelect: (company: ClientSearchCompany) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  // The latest finished search; null until its first answer. One slot, not a
  // cache: a company or contact created since an older answer would be missing
  // from it.
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  // The active row a person has moved to, and the results it was chosen in.
  // Keyed to them so a fresh list starts from its own default instead of
  // inheriting an index into the old one (no effect needed to reset it).
  const [moved, setMoved] = useState<{ outcome: SearchOutcome | null; index: number } | null>(null);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();
  const listboxId = `${id}-listbox`;

  const term = clientSearchTerm(query);
  // Derived rather than stored, so there is no flag to forget to clear: the
  // picker is searching exactly when what it shows answers a different term
  // from the one typed.
  const searching = outcome?.term !== term;
  // Something typed, but under the minimum: the list is the newest companies,
  // and the manager should be told why nothing narrowed.
  const tooShort = query.trim() !== "" && term === "";

  const results = outcome?.companies ?? [];
  const status = clientSearchStatus({
    tooShort,
    searching,
    outcome: outcome && {
      term: outcome.term,
      count: outcome.companies.length,
      failed: outcome.failed,
    },
  });

  const active =
    moved !== null && moved.outcome === outcome
      ? moved.index
      : defaultActiveOption(outcome?.term ?? "", results.length);
  const activeCompany = active >= 0 ? results[active] : undefined;

  // Runs a search whenever the term the list should be showing differs from
  // the one it is showing (`searching`). `current` is the out-of-order guard
  // described above: cleanup clears it, so any response whose request has been
  // superseded (by a different term, or unmount) is dropped. A failed search is
  // recorded under its term too, so it is not retried in a loop; "Try again"
  // clears the outcome to ask again.
  useEffect(() => {
    if (!searching) return;
    let current = true;
    const timer = setTimeout(
      () => {
        searchClients(term).then(
          (result) => {
            if (!current) return;
            setOutcome(
              "error" in result
                ? { term, companies: [], failed: true }
                : { term, companies: result.companies, failed: false }
            );
          },
          () => {
            if (current) setOutcome({ term, companies: [], failed: true });
          }
        );
      },
      // The newest page needs no waiting for: mounting, or clearing the box.
      term === "" ? 0 : SEARCH_DEBOUNCE_MS
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [searching, term]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // Closes on a press outside. `pointerdown` rather than relying on blur,
  // because tapping blank page on iOS does not blur an input, and a blur that
  // fired on a tap of the list itself would close it before the tap landed.
  // Registered only while open.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // A new list starts at its top...
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [outcome]);

  // ...and the active row is kept in view. The list is scrolled directly (see
  // `revealScrollTop`) so the page behind it stays where it is.
  useEffect(() => {
    const list = listRef.current;
    const option = list?.children[active];
    if (!open || !list || !(option instanceof HTMLElement)) return;
    list.scrollTop = revealScrollTop(
      option.offsetTop,
      option.offsetHeight,
      list.scrollTop,
      list.clientHeight
    );
  }, [open, active]);

  function openList() {
    setOpen(true);
    // Reopening after a failure asks again, so a keyboard user, who cannot
    // reach "Try again" without leaving the box, is not stuck with it.
    if (outcome?.failed && !searching) setOutcome(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Keys pressed to compose text (an IME candidate list) are not ours.
    if (event.nativeEvent.isComposing) return;

    if (isListNavKey(event.key)) {
      event.preventDefault();
      openList();
      setMoved({ outcome, index: moveActiveOption(active, results.length, event.key) });
    } else if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      // Not while a newer search is in flight: the active row would answer an
      // older question than the one on screen.
      if (activeCompany && !searching) onSelect(activeCompany);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div
      ref={wrapperRef}
      className="flex flex-col gap-2"
      onBlur={(event) => {
        // Focus went somewhere else in the page (Tab, say): close. Focus going
        // nowhere (relatedTarget null) is a tap on blank space, a dismissed
        // phone keyboard or a switch of window -- none of which should close
        // it; the pointerdown listener above handles the real outside press.
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) setOpen(false);
      }}
    >
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Search companies or contacts"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-activedescendant={open && activeCompany ? `${id}-option-${activeCompany.id}` : undefined}
          value={query}
          placeholder="Search companies or contacts…"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          disabled={disabled}
          onFocus={openList}
          // Also on click: after Escape the box keeps focus, so a second press
          // on it is the only thing a mouse or finger can do to bring the list
          // back.
          onClick={openList}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className={cn(fieldInputClass, "min-h-11 pr-9 pl-9")}
        />
        <ChevronDown
          className={cn(
            "pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-slate-400 transition-transform motion-reduce:transition-none",
            open && "rotate-180"
          )}
          aria-hidden="true"
        />
      </div>

      {/* The announcement. Always rendered, and empty while closed, so it is a
          live region that already exists when its text appears -- one inserted
          together with its text is often not read. The visible copy of the
          same words is hidden from assistive technology below, so it is
          not read twice. */}
      <p role="status" aria-live="polite" className="sr-only">
        {open ? status.text : ""}
      </p>

      {open ? (
        <div
          // A press on the list must not move focus off the input.
          onMouseDown={(event) => event.preventDefault()}
          className="overflow-hidden rounded-xl border border-slate-200 bg-white"
        >
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 text-xs text-slate-500">
            <p aria-hidden="true">{status.text}</p>
            {status.kind === "failed" ? (
              <button
                type="button"
                onClick={() => setOutcome(null)}
                className="focus-ring -my-2 inline-flex min-h-11 shrink-0 items-center rounded-md px-2 font-medium text-brand hover:underline"
              >
                Try again
              </button>
            ) : null}
          </div>

          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label="Companies"
            aria-busy={searching}
            className={cn(
              // Positioned, so each row's offsetTop is measured from the list.
              "relative max-h-72 overflow-y-auto overscroll-contain empty:hidden sm:max-h-96",
              searching && "opacity-60"
            )}
          >
            {results.map((company, index) => {
              const location = clientLocation(company);
              const viaContact = clientContactMatchText(company, outcome?.term ?? "");
              return (
                <li
                  key={company.id}
                  id={`${id}-option-${company.id}`}
                  role="option"
                  aria-selected={index === active}
                  onClick={() => onSelect(company)}
                  className="flex min-h-11 cursor-pointer flex-col justify-center gap-0.5 border-b border-l-2 border-slate-100 border-l-transparent px-3 py-2 last:border-b-0 hover:bg-slate-50 aria-selected:border-l-brand aria-selected:bg-slate-100 aria-selected:hover:bg-slate-100"
                >
                  <span className="truncate text-sm font-medium text-brand-dark">{company.name}</span>
                  {location ? <span className="truncate text-xs text-slate-500">{location}</span> : null}
                  {viaContact ? (
                    <span className="flex items-center gap-1 text-xs text-slate-500">
                      <User className="size-3 shrink-0" aria-hidden="true" />
                      <span className="truncate">{viaContact}</span>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
