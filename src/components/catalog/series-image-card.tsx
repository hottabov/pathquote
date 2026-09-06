"use client";

import { useState } from "react";
import { ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImageUpload } from "@/components/catalog/image-upload";
import { StatusBadge } from "@/components/ui-kit";
import { pickDerivativeWidth } from "@/lib/image-derivative-width";
import type { ActionResult } from "@/lib/actions/catalog";

// Matches CatalogThumb: the box is 64 CSS px, so 2× (retina) needs 128
// device px, which `pickDerivativeWidth` maps to the 128 derivative.
const PREVIEW_BOX_PX = 64;

export function SeriesImageCard({
  currentUrl,
  fallbackImageUrl,
  alt,
  onSave,
}: {
  currentUrl: string | null;
  fallbackImageUrl: string | null;
  alt: string;
  onSave: (url: string | null) => Promise<ActionResult>;
}) {
  const [expanded, setExpanded] = useState(false);
  const isOverride = !!currentUrl;
  const displayUrl = currentUrl || fallbackImageUrl;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Catalog card image</h3>
      </div>

      {!expanded && (
        <div className="flex items-center gap-3">
          {displayUrl ? (
            // This card previews the exact same product/series photo
            // CatalogThumb draws elsewhere — full-resolution originals, but
            // shown here in a 64px box, so it asks for the same `?w=`
            // thumbnail derivative rather than the print-resolution
            // original. SVG catalogue art (already vector, no derivative)
            // is linked as-is.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={
                displayUrl.endsWith(".svg")
                  ? displayUrl
                  : `${displayUrl}?w=${pickDerivativeWidth(PREVIEW_BOX_PX * 2)}`
              }
              alt={alt}
              className="size-16 shrink-0 rounded border border-slate-200 bg-white object-contain"
            />
          ) : (
            <div className="flex size-16 items-center justify-center rounded border border-slate-200 bg-slate-50">
              <ImageIcon className="size-6 text-slate-400" aria-hidden="true" />
            </div>
          )}

          <StatusBadge tone={isOverride ? "brand" : "slate"}>
            {isOverride ? "Custom" : "Inherited"}
          </StatusBadge>

          <Button
            type="button"
            variant="secondary"
            onClick={() => setExpanded(true)}
            className="min-h-11"
          >
            Edit
          </Button>
        </div>
      )}

      {expanded && (
        <div className="flex flex-col gap-3">
          <ImageUpload
            currentUrl={currentUrl}
            alt={alt}
            onSave={onSave}
            removeLabel="Reset to product image"
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => setExpanded(false)}
            className="min-h-11 self-start"
          >
            Done
          </Button>
        </div>
      )}
    </div>
  );
}
