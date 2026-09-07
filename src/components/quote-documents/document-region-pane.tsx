"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard } from "@/components/ui-kit";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import {
  createRegionVersion,
  deleteRegionVersion,
  updateQuoteDocument,
} from "@/lib/actions/quote-documents";
import type { QuoteToken } from "@/lib/quote-variables";
import { QuoteDocumentForm } from "./quote-document-form";

export type RegionVersionValues = { title: string; body: string; includedByDefault: boolean };

/**
 * One region tab's content for an ADMIN: either an empty state offering to
 * create this region's own version of the document, or that version's editor
 * plus a danger-zone delete.
 *
 * `createRegionVersion` copies the default wholesale server-side, so the new
 * version starts as an exact copy and diverges from there; where there is no
 * default at all (a region-only document — D5) it starts blank instead of
 * refusing. `router.refresh()` after either write re-runs the server page so
 * `version` reflects the new state — the parent `QuoteDocumentEditor` is a
 * client component, so the reader stays on the tab they were on even though
 * its props change underneath.
 *
 * Same shape as `RegionPane` in src/components/content/region-pane.tsx, the
 * component this succeeds, with one difference in wording: deleting here does
 * not always mean "falls back to the default", because a region-only document
 * has no default to fall back to and simply stops printing in that region.
 * The confirm text says whichever is true.
 */
export function DocumentRegionPane({
  documentKey,
  regionCode,
  regionName,
  version,
  hasDefault,
  tokens,
}: {
  documentKey: string;
  regionCode: string;
  regionName: string;
  version: RegionVersionValues | null;
  /** Whether a `regionId: null` default exists for this key. Decides both
   * what "create" copies from and what "delete" falls back to. */
  hasDefault: boolean;
  tokens: QuoteToken[];
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();

  function handleCreate() {
    startTransition(async () => {
      const result = await createRegionVersion(documentKey, regionCode);
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      toast.success(`${regionCode} version created`);
      router.refresh();
    });
  }

  async function handleDelete() {
    const confirmed = await confirm({
      title: `Delete the ${regionCode} version?`,
      description: hasDefault
        ? `${regionName} will print the default document instead. This can't be undone.`
        : `This document has no default, so ${regionName} will stop printing it altogether. This can't be undone.`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!confirmed) return;

    startTransition(async () => {
      const result = await deleteRegionVersion(documentKey, regionCode);
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      toast.success(`${regionCode} version deleted`);
      router.refresh();
    });
  }

  if (!version) {
    return (
      <EmptyState
        icon={FileText}
        title={`No ${regionCode} version`}
        description={
          hasDefault
            ? `${regionName} prints the default document shown on the Default tab. Creating a version copies that text, and ${regionCode} then keeps its own copy.`
            : `This document has no default, so ${regionName} prints nothing for it today. Creating a version starts a blank document only ${regionCode} will print.`
        }
        action={
          <Button
            type="button"
            onClick={handleCreate}
            disabled={pending}
            className="h-11 bg-brand text-white hover:bg-brand/90"
          >
            {pending ? "Creating…" : hasDefault ? "Create version from default" : "Create a blank version"}
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <QuoteDocumentForm
        action={updateQuoteDocument.bind(null, documentKey, regionCode)}
        idPrefix={`quote-document-${regionCode.toLowerCase()}`}
        bodyLabel={`${regionName} version`}
        defaultValues={version}
        tokens={tokens}
      />
      <SectionCard
        tone="danger"
        title="Danger zone"
        description={
          hasDefault
            ? `Removes the ${regionCode} version — ${regionName} goes back to printing the default.`
            : `Removes the ${regionCode} version — nothing else prints this document, so it disappears from ${regionName}'s quotes.`
        }
      >
        <Button
          type="button"
          variant="destructive"
          onClick={handleDelete}
          disabled={pending}
          className="h-11 w-full sm:w-fit"
        >
          {pending ? "Deleting…" : "Delete version"}
        </Button>
      </SectionCard>
    </div>
  );
}
