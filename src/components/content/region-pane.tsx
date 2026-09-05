"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard } from "@/components/ui-kit";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import { updateContentBlock, createRegionOverride, deleteRegionOverride } from "@/lib/actions/content";
import { ContentBlockForm } from "./content-block-form";

export type RegionOverrideValues = { title: string | null; body: string; sortOrder: number };

/**
 * One region tab's content: either an empty state offering to create an
 * override (copied server-side from the current default), or the override's
 * edit form plus a danger-zone delete. `router.refresh()` after a
 * create/delete re-runs the server page so `override` reflects the new
 * state — the parent `ContentBlockEditor` is a client component, so its
 * `activeTab` selection survives the refresh even though its props change.
 */
export function RegionPane({
  blockKey,
  regionCode,
  regionName,
  override,
  placeholders,
}: {
  blockKey: string;
  regionCode: string;
  regionName: string;
  override: RegionOverrideValues | null;
  placeholders: Record<string, string>;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();

  function handleCreate() {
    startTransition(async () => {
      const result = await createRegionOverride(blockKey, regionCode);
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      toast.success(`${regionCode} override created`);
      router.refresh();
    });
  }

  async function handleDelete() {
    const confirmed = await confirm({
      title: `Delete the ${regionCode} override?`,
      description: `${regionName} will fall back to the default block. This can't be undone.`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!confirmed) return;

    startTransition(async () => {
      const result = await deleteRegionOverride(blockKey, regionCode);
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      toast.success(`${regionCode} override deleted`);
      router.refresh();
    });
  }

  if (!override) {
    return (
      <EmptyState
        icon={FileText}
        title={`No ${regionCode} override`}
        description={`${regionName} currently uses the default block shown on the Default tab.`}
        action={
          <Button
            type="button"
            onClick={handleCreate}
            disabled={pending}
            className="h-11 bg-brand text-white hover:bg-brand/90"
          >
            {pending ? "Creating…" : "Create override from default"}
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <ContentBlockForm
        action={updateContentBlock.bind(null, blockKey, regionCode)}
        idPrefix={`content-${regionCode.toLowerCase()}`}
        defaultValues={{ title: override.title ?? "", body: override.body, sortOrder: override.sortOrder }}
        placeholders={placeholders}
      />
      <SectionCard
        tone="danger"
        title="Danger zone"
        description={`Removes the ${regionCode} override — this key falls back to the default.`}
      >
        <Button
          type="button"
          variant="destructive"
          onClick={handleDelete}
          disabled={pending}
          className="h-11 w-full sm:w-fit"
        >
          {pending ? "Deleting…" : "Delete override"}
        </Button>
      </SectionCard>
    </div>
  );
}
