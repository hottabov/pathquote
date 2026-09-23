"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { toCents, fromCents } from "@/lib/pricing";
import { AddCustomLineForm } from "@/components/builder/add-custom-line-form";
import { RemoveItemButton } from "@/components/builder/remove-item-button";
import { Tooltip } from "@/components/ui-kit/client";
import { removeLine } from "@/lib/actions/documents";
import type { BuilderLine } from "@/lib/queries/documents";

/**
 * One document-level extra line, and the form that edits it.
 *
 * The row swaps for the form in place rather than opening a dialog: the
 * form is five short fields and a photo, it belongs where the line is, and
 * the surrounding list stays put so it is obvious which line is being
 * changed.
 *
 * A client component only because of that one piece of state -- the section
 * around it stays a server component.
 */
export function ExtraLineRow({
  documentId,
  line,
  currency,
  currencySymbol,
  readOnly,
}: {
  documentId: string;
  line: BuilderLine;
  currency: string;
  currencySymbol: string | null;
  readOnly: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <AddCustomLineForm
        documentId={documentId}
        line={{
          id: line.id,
          name: line.name,
          description: line.description,
          qty: line.qty,
          unitPrice: line.unitPrice,
          imageUrl: line.imageUrl,
        }}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3">
      <div className="flex min-w-0 items-center gap-2">
        {line.showImage && line.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={line.imageUrl}
            alt={line.name}
            className="size-12 shrink-0 rounded-lg border border-slate-200 object-contain"
          />
        ) : null}
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-brand-dark">{line.name}</span>
          {line.description ? (
            <span className="truncate text-xs text-slate-500">{line.description}</span>
          ) : null}
          <span className="text-xs text-slate-500">
            {line.qty} × {formatMoney(line.unitPrice, currency, currencySymbol)}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <span className="text-sm font-medium tabular-nums text-brand-dark">
          {formatMoney(fromCents(line.qty * toCents(line.unitPrice)), currency, currencySymbol)}
        </span>
        {!readOnly && (
          <>
            <Tooltip label="Edit this line">
              <button
                type="button"
                onClick={() => setEditing(true)}
                aria-label={`Edit ${line.name}`}
                className="focus-ring flex size-11 items-center justify-center rounded-lg text-slate-400 transition-colors duration-(--duration-micro) ease-out-soft motion-reduce:transition-none md:hover:bg-slate-100 md:hover:text-brand-dark"
              >
                <Pencil className="size-4" aria-hidden="true" />
              </button>
            </Tooltip>
            <RemoveItemButton action={removeLine.bind(null, line.id)} itemName={line.name} />
          </>
        )}
      </div>
    </div>
  );
}
