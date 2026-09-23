"use client";

import { useState, useTransition, type ChangeEvent, type DragEvent } from "react";
import { ImageIcon, Trash2, Upload } from "lucide-react";
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
 * The dashed border is a real dropzone: a file dragged onto it takes the
 * same path as one chosen through the picker below. It looked like one long
 * before it was one, which is its own kind of lie -- a salesperson with the
 * SketchUp render already in a folder had to open a file dialog to find a
 * file they were holding.
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
  const [dragging, setDragging] = useState(false);
  const toast = useToast();

  const busy = uploading || pending;

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset so selecting the same file again still fires onChange.
    event.target.value = "";
    if (file) await upload(file);
  }

  /** What the dropzone and the picker both end in. A dropped file and a
   * chosen one are the same file; only the way it arrived differs. */
  async function upload(file: File) {
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

  /** Whether the drag is carrying something this control can take. A drag of
   * selected text or a link reports no files, and highlighting the zone for
   * it promises an upload that would never happen. */
  function carriesFile(event: DragEvent<HTMLDivElement>): boolean {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (readOnly || busy || !carriesFile(event)) return;
    // Both of these are load-bearing: without preventDefault the browser
    // navigates away to the dropped file, which loses whatever the quote
    // had unsaved.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!dragging) setDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    // `relatedTarget` inside the zone means the pointer only crossed from
    // the zone onto one of its own children, which is not a leave. Without
    // this the highlight flickers as the pointer passes over the preview.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragging(false);
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (readOnly || busy) return;
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    // Type and size are the server's call either way (/api/uploads re-checks
    // the real bytes), so a wrong file dropped here fails with the same
    // message a wrong file picked here would.
    if (file) await upload(file);
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
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "flex min-h-32 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-4 text-center transition-colors duration-(--duration-micro) ease-out-soft motion-reduce:transition-none",
          dragging ? "border-brand bg-brand/5" : "border-slate-200 bg-slate-50",
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
            <p className="text-sm text-slate-500">
              {readOnly ? "No image yet." : "Drop an image here, or choose one below."}
            </p>
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
              <Trash2 className="size-4" data-icon="inline-start" aria-hidden="true" />
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
