"use client";

import { useMemo, useState, useTransition } from "react";
import { AutosaveIndicator } from "@/components/builder/autosave-indicator";
import { fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import { useAutosave } from "@/lib/use-autosave";
import { cn } from "@/lib/utils";
import { setDocumentExclusions, setQuoteTerms } from "@/lib/actions/documents";
import { quoteTermsSchema } from "@/lib/validation/quote-documents";
import type { QuoteTermValues } from "@/lib/quote-terms";

/** One legal document as the panel offers it — the resolved
 * `QuoteDocument` for this quote's region (see `resolveQuoteDocuments` in
 * src/lib/quotation-data.ts), reduced to what a tickbox needs. */
export type PanelDocument = {
  key: string;
  title: string;
  includedByDefault: boolean;
};

type TermKey = keyof QuoteTermValues;

/** The four figures, in the order the printed sentence reads them: what
 * happens to the order, then what happens on site, then what covers it
 * afterwards. Each carries the unit it is quoted in, since a bare "2" beside
 * "Installation" tells a salesperson nothing. */
const TERM_FIELDS: { key: TermKey; label: string; unit: string }[] = [
  { key: "deliveryWeeks", label: "Delivery", unit: "weeks" },
  { key: "installationDays", label: "Installation", unit: "days" },
  { key: "trainingDays", label: "Training", unit: "days" },
  { key: "warrantyMonths", label: "Warranty", unit: "months" },
];

type TermDrafts = Record<TermKey, string>;

function toDrafts(terms: Partial<Record<TermKey, number | null>>): TermDrafts {
  return {
    deliveryWeeks: terms.deliveryWeeks !== null && terms.deliveryWeeks !== undefined ? String(terms.deliveryWeeks) : "",
    installationDays:
      terms.installationDays !== null && terms.installationDays !== undefined ? String(terms.installationDays) : "",
    trainingDays: terms.trainingDays !== null && terms.trainingDays !== undefined ? String(terms.trainingDays) : "",
    warrantyMonths:
      terms.warrantyMonths !== null && terms.warrantyMonths !== undefined ? String(terms.warrantyMonths) : "",
  };
}

/**
 * The message `quoteTermsSchema`'s own rule produces for one raw field value,
 * or `null` when it accepts it.
 *
 * Reached through the schema's `shape` rather than reimplemented here so
 * there is exactly one definition of "is this a usable figure" — the same
 * object the server action parses. A duplicated client-side rule is how a
 * field starts accepting something the save then rejects with a message that
 * names no field.
 */
function termFieldError(raw: string): string | null {
  const result = quoteTermsSchema.shape.deliveryWeeks.safeParse(raw);
  return result.success ? null : (result.error.issues[0]?.message ?? "Invalid value");
}

/**
 * The quote's standard-terms figures and the legal documents it prints.
 *
 * Two halves, one card, because they answer the same question: what is this
 * particular customer being promised, as against the region's standard? The
 * figures are the promise's numbers, the tickboxes are which agreements carry
 * it.
 *
 * **Blank is not zero.** A blank field inherits its region's figure and shows
 * it as a placeholder; a field holding `0` is a deliberate promise of none
 * ("self-install, no installation days"), stored as `0` and marked overridden
 * like any other typed value. `resolveQuoteTerms` (src/lib/quote-terms.ts)
 * uses `??` for exactly this, and `termFigureSchema` tests for blankness on
 * the raw string before coercion, so the distinction survives the round trip.
 * The panel never renders an inherited value *into* a field — a filled input
 * always means "this quote decided", which is what makes the overridden
 * marking trustworthy at a glance.
 *
 * The figures autosave on a pause (`useAutosave`, as `ValidityDaysField`
 * next door does — a server action per keystroke is not a typing
 * experience); the tickboxes commit optimistically per click and revert with
 * a toast on failure, as `PriceDisplayToggles` does. Both go read-only
 * together on a FINAL quote.
 */
export function TermsDocumentsPanel({
  documentId,
  region,
  terms,
  documents,
  excludedKeys,
  readOnly = false,
}: {
  documentId: string;
  /** The region's four figures — what a blank field inherits. */
  region: QuoteTermValues;
  /** This quote's own overrides; `null` means inherit. */
  terms: Record<TermKey, number | null>;
  /** Every document resolved for this quote's region, in print order. */
  documents: PanelDocument[];
  /** The keys this quote currently excludes (`DocumentExclusion` rows). */
  excludedKeys: string[];
  readOnly?: boolean;
}) {
  const [drafts, setDrafts] = useState<TermDrafts>(() => toDrafts(terms));

  // `useAutosave` compares with `===`, so the four fields travel as one
  // serialized string rather than as an object literal that would be a new
  // reference — and so a new save — on every render.
  const serialized = JSON.stringify(drafts);
  const errors = useMemo(
    () =>
      TERM_FIELDS.reduce<Partial<Record<TermKey, string>>>((acc, field) => {
        const message = termFieldError(drafts[field.key]);
        if (message) acc[field.key] = message;
        return acc;
      }, {}),
    [drafts]
  );
  const hasError = Object.keys(errors).length > 0;

  // A field mid-typo ("1", about to become "12") is not something to send;
  // the inline message under it is the feedback, and the save fires once the
  // group parses. `enabled` gating means an invalid value never advances the
  // hook's last-saved marker either, so fixing it saves rather than settling.
  const { status, error } = useAutosave({
    value: serialized,
    enabled: !readOnly && !hasError,
    onSave: async (next) => setQuoteTerms(documentId, JSON.parse(next) as TermDrafts),
  });

  const toast = useToast();
  const [excluded, setExcluded] = useState<string[]>(excludedKeys);
  const [pending, startTransition] = useTransition();

  // A document nobody opted into is not something a quote can turn on: the
  // only per-quote channel is exclusion, so the renderer drops it whatever
  // this panel does (see `buildQuotationData`'s selection comment). It is
  // listed, unticked and disabled rather than hidden, so an author can see
  // the region has such a document and who to ask about it — and it is never
  // written into an exclusion set, since it was never included to exclude.
  const optional = documents.filter((doc) => !doc.includedByDefault);
  const offered = documents.filter((doc) => doc.includedByDefault);

  function toggleDocument(key: string, include: boolean) {
    const previous = excluded;
    const next = include ? excluded.filter((k) => k !== key) : [...excluded.filter((k) => k !== key), key];
    setExcluded(next);
    startTransition(async () => {
      const result = await setDocumentExclusions(documentId, next);
      if (result?.error) {
        setExcluded(previous);
        toast.error(result.error);
      }
    });
  }

  const excludedSet = new Set(excluded);

  if (readOnly) {
    const printed = offered.filter((doc) => !excludedSet.has(doc.key));
    return (
      <div className="flex flex-col gap-4">
        <dl className="flex flex-col gap-1.5">
          {TERM_FIELDS.map((field) => {
            const override = terms[field.key];
            const value = override ?? region[field.key];
            return (
              <div key={field.key} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <dt className="text-slate-500">{field.label}</dt>
                <dd className="font-medium text-brand-dark">
                  {value} {field.unit}
                </dd>
                {override !== null ? <OverriddenBadge /> : null}
              </div>
            );
          })}
        </dl>
        <div>
          <p className="text-sm font-medium text-brand-dark">Documents included</p>
          {printed.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-0.5 text-sm text-slate-700">
              {printed.map((doc) => (
                <li key={doc.key}>{doc.title}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-slate-500">None — this quote prints no legal documents.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-slate-500">
            Leave a field blank to promise the region&rsquo;s standard.
          </p>
          <AutosaveIndicator status={status} error={error} />
        </div>

        {TERM_FIELDS.map((field) => {
          const inputId = `quote-term-${field.key}`;
          const hintId = `${inputId}-hint`;
          const raw = drafts[field.key];
          const fieldError = errors[field.key];
          // Overridden means "this quote typed something", not "typed
          // something different": pinning the region's own figure is still a
          // decision this quote made, and it stops tracking the region if an
          // admin changes it later. Marking only a differing value would hide
          // that.
          const overridden = raw.trim() !== "" && !fieldError;

          return (
            <div
              key={field.key}
              className="grid gap-1.5 sm:grid-cols-[8rem_1fr] sm:items-start sm:gap-x-3"
            >
              <label htmlFor={inputId} className="pt-2.5 text-sm font-medium text-brand-dark">
                {field.label}
              </label>
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id={inputId}
                    type="text"
                    inputMode="numeric"
                    value={raw}
                    placeholder={String(region[field.key])}
                    aria-describedby={hintId}
                    aria-invalid={fieldError ? true : undefined}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                    className={cn(
                      fieldInputClass,
                      "w-20",
                      overridden && "border-amber-400 bg-amber-50/40 font-medium",
                      fieldError && "border-destructive"
                    )}
                  />
                  <span className="text-sm text-slate-500">{field.unit}</span>
                  {overridden ? <OverriddenBadge /> : null}
                </div>
                <p
                  id={hintId}
                  role={fieldError ? "alert" : undefined}
                  className={cn("text-xs", fieldError ? "text-destructive" : "text-slate-500")}
                >
                  {fieldError ??
                    (overridden
                      ? `Region standard is ${region[field.key]} ${field.unit}.`
                      : `Inherits ${region[field.key]} ${field.unit} from the region.`)}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-1 border-t border-slate-100 pt-4">
        <p className="text-sm font-medium text-brand-dark">Documents included in this quote</p>
        {documents.length === 0 ? (
          <p className="text-sm text-slate-500">
            This region has no legal documents set up yet — nothing will print.
          </p>
        ) : null}

        {offered.map((doc) => (
          <label key={doc.key} className="flex h-11 items-center justify-between gap-3">
            <span className="text-sm text-brand-dark">{doc.title}</span>
            <input
              type="checkbox"
              checked={!excludedSet.has(doc.key)}
              disabled={pending}
              onChange={(event) => toggleDocument(doc.key, event.target.checked)}
              className="size-4 rounded border-slate-300 accent-brand disabled:cursor-not-allowed"
            />
          </label>
        ))}

        {optional.map((doc) => (
          <div key={doc.key} className="flex flex-col gap-0.5 py-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-slate-500">{doc.title}</span>
              <input
                type="checkbox"
                checked={false}
                disabled
                readOnly
                className="size-4 rounded border-slate-300 accent-brand disabled:cursor-not-allowed"
              />
            </div>
            <p className="text-xs text-slate-500">
              Not offered by default — an admin turns it on for the region in Documents.
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The at-a-glance mark that this quote promises something other than the
 * region's standard. Amber rather than the brand colour on purpose: it is
 * the same "flagging it, not blocking it" tone `ValidityDaysField` uses for
 * a longer-than-usual validity window. */
function OverriddenBadge() {
  return (
    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
      Overridden
    </span>
  );
}
