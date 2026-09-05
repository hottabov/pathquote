"use client";

import { useState, useTransition, type ChangeEvent } from "react";
import { ImageIcon, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/actions/catalog";

const RASTER_TYPES = "image/jpeg,image/png,image/webp";

/** What the file picker offers, per purpose. This only filters the dialog —
 * `/api/uploads` re-checks the real bytes against its own allow-list either
 * way — but the two must agree, or a picker either hides a file the server
 * would have taken or offers one it will reject after the upload.
 *
 * SVG appears only where an ADMIN uploads: catalogue art (the default) and
 * spec diagrams. See `SPEC_IMAGE_TYPES` in src/lib/uploads.ts for why the
 * vector question is answered differently there than for the purposes any
 * signed-in user can reach. */
const ACCEPT_BY_PURPOSE: Record<string, string> = {
  "spec-image": `${RASTER_TYPES},image/svg+xml`,
};
const DEFAULT_ACCEPT = `${RASTER_TYPES},image/svg+xml`;

/**
 * Image preview + upload/remove controls for a product or option. Uploading
 * is a two-step flow: the file is first POSTed to /api/uploads (which
 * validates type/size and writes it under UPLOADS_DIR, returning a
 * `/api/files/<name>` URL), then the bound `onSave` server action
 * (`updateProductImage`/`updateOptionImage`) persists that URL onto the
 * product/option row. "Remove image" calls the same action with `null`.
 * The dashed border reads as a dropzone even though the only interaction
 * is the file picker button below it (no drag-and-drop wiring — presentation
 * only, per phase 5b scope).
 */
export function ImageUpload({
  currentUrl,
  alt,
  onSave,
  readOnly = false,
  previewHeightPx,
  removeLabel = "Remove image",
  purpose,
}: {
  currentUrl: string | null;
  alt: string;
  onSave: (url: string | null) => Promise<ActionResult>;
  /** MANAGER view: show the image (if any) with no upload/remove controls. */
  readOnly?: boolean;
  /** Fixed preview height in pixels, e.g. 120 for a region logo. Defaults to
   * the catalog product/option preview size (~112px via `h-28`) when
   * omitted. */
  previewHeightPx?: number;
  /** Label for the button that calls `onSave(null)`. Defaults to "Remove
   * image"; the series editor overrides this to "Reset to product image"
   * since a series' `null` isn't "no image" -- it falls back to a product
   * photo (see updateSeriesImage in src/lib/actions/catalog.ts). */
  removeLabel?: string;
  /** Sent as the `purpose` field alongside the file to /api/uploads (see
   * that route's purpose-scoped allow-list) — omitted (the default) means
   * "catalog" there, which is what every existing product/option/region
   * caller of this component wants. Pass `"avatar"` for the account/user
   * avatar editors, `"document-hero"` for the builder's quotation setup
   * image (src/components/builder/hero-image-section.tsx, non-ADMIN), or
   * `"spec-image"` for the Settings → Catalogue spec-diagram editor
   * (src/app/(app)/settings/spec-images/page.tsx, ADMIN-only like
   * `"catalog"` but a narrower raster-only allow-list). */
  purpose?: "avatar" | "document-hero" | "spec-image";
}) {
  const [url, setUrl] = useState(currentUrl);
  const [uploading, setUploading] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const busy = uploading || pending;

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset so selecting the same file again still fires onChange.
    event.target.value = "";
    if (!file) return;

    setError(null);
    setUploading(true);
    let uploadedUrl: string;
    try {
      const formData = new FormData();
      formData.set("file", file);
      if (purpose) formData.set("purpose", purpose);
      const response = await fetch("/api/uploads", { method: "POST", body: formData });
      const body = (await response.json().catch(() => null)) as
        | { url?: string; error?: string }
        | null;
      if (!response.ok || !body?.url) {
        const message = body?.error ?? "Upload failed.";
        setError(message);
        toast.error(message);
        return;
      }
      uploadedUrl = body.url;
    } catch {
      const message = "Upload failed. Check your connection and try again.";
      setError(message);
      toast.error(message);
      return;
    } finally {
      setUploading(false);
    }

    startTransition(async () => {
      const result = await onSave(uploadedUrl);
      if (result.error) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      setUrl(uploadedUrl);
      toast.success("Image saved");
    });
  }

  function handleRemove() {
    setError(null);
    startTransition(async () => {
      const result = await onSave(null);
      if (result.error) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      setUrl(null);
      toast.success("Image removed");
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className={cn(
          "flex min-h-32 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-200 bg-slate-50 p-4 text-center",
          url ? "py-3" : "py-6"
        )}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={alt}
            style={previewHeightPx ? { height: previewHeightPx } : undefined}
            className={cn(
              "w-auto max-w-full rounded-lg border border-slate-200 bg-white object-contain",
              previewHeightPx ? undefined : "h-28"
            )}
          />
        ) : (
          <>
            <div className="flex size-10 items-center justify-center rounded-full bg-slate-100">
              <ImageIcon className="size-5 text-slate-400" aria-hidden="true" />
            </div>
            <p className="text-sm text-slate-500">No image yet.</p>
          </>
        )}
      </div>

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" disabled={busy} className="relative h-11 overflow-hidden">
            <Upload className="size-4" data-icon="inline-start" aria-hidden="true" />
            {url ? "Replace image" : "Upload image"}
            <input
              type="file"
              accept={purpose ? (ACCEPT_BY_PURPOSE[purpose] ?? RASTER_TYPES) : DEFAULT_ACCEPT}
              onChange={handleFileChange}
              disabled={busy}
              aria-label="Upload image"
              className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
            />
          </Button>
          {url ? (
            <Button type="button" variant="outline" onClick={handleRemove} disabled={busy} className="h-11">
              {removeLabel}
            </Button>
          ) : null}
          {busy ? <span className="text-sm text-slate-500">Saving…</span> : null}
        </div>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
