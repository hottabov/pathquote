"use client";

import { useActionState, useEffect, useRef, useState, type ChangeEvent } from "react";
import { ImageIcon, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldRow, fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import { addCustomLine, type ActionResult } from "@/lib/actions/documents";

const initialState: ActionResult = {};

// Matches DOCUMENT_LINE_TYPES in src/lib/uploads.ts — the purpose-scoped
// allow-list `purpose=document-line` enforces server-side (SVG excluded,
// unlike the catalog uploader, since a salesperson's own upload shouldn't
// be able to smuggle in script-bearing XML).
const ACCEPTED_TYPES = "image/jpeg,image/png,image/webp";

/**
 * The "Extra lines" add form: name, qty, unit price, an optional
 * description, and an optional photo, submitted to `addCustomLine`. The
 * photo is uploaded to `/api/uploads` (purpose `document-line`) as soon as
 * it's picked — same two-step flow as the catalog's `ImageUpload` — but the
 * returned URL is only *held* in local state and carried by a hidden field
 * until the whole line is submitted, since (unlike a product/option) a
 * custom line doesn't exist yet to attach the image to. Resets itself
 * (fields and photo both) after a successful add (mirrors ContactForm's
 * onDone pattern in components/clients/contact-form.tsx) so it's ready for
 * the next line without the manager clearing fields by hand.
 */
export function AddCustomLineForm({ documentId }: { documentId: string }) {
  const [state, formAction, pending] = useActionState(
    (_prevState: ActionResult, formData: FormData) => addCustomLine(documentId, formData),
    initialState
  );
  const formRef = useRef<HTMLFormElement>(null);
  const wasPending = useRef(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (wasPending.current && !pending && !state.error) {
      formRef.current?.reset();
      setImageUrl(null);
      setUploadError(null);
    }
    wasPending.current = pending;
  }, [pending, state]);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset so selecting the same file again still fires onChange.
    event.target.value = "";
    if (!file) return;

    setUploadError(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.set("file", file);
      formData.set("purpose", "document-line");
      const response = await fetch("/api/uploads", { method: "POST", body: formData });
      const body = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!response.ok || !body?.url) {
        const message = body?.error ?? "Upload failed.";
        setUploadError(message);
        toast.error(message);
        return;
      }
      setImageUrl(body.url);
    } catch {
      const message = "Upload failed. Check your connection and try again.";
      setUploadError(message);
      toast.error(message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <form
      ref={formRef}
      action={formAction}
      className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4"
    >
      <input type="hidden" name="imageUrl" value={imageUrl ?? ""} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr_1fr]">
        <FieldRow label="Name" htmlFor="custom-line-name" required>
          <input
            id="custom-line-name"
            name="name"
            required
            maxLength={200}
            placeholder="e.g. Delivery, or Trade-in K5 390"
            className={fieldInputClass}
          />
        </FieldRow>
        <FieldRow label="Qty" htmlFor="custom-line-qty" required>
          <input
            id="custom-line-qty"
            name="qty"
            type="number"
            inputMode="numeric"
            min={1}
            max={999}
            defaultValue={1}
            required
            className={fieldInputClass}
          />
        </FieldRow>
        <FieldRow label="Unit price" htmlFor="custom-line-unit-price" required>
          <input
            id="custom-line-unit-price"
            name="unitPrice"
            type="text"
            inputMode="decimal"
            placeholder="0.00, or -15000.00 for a trade-in"
            required
            className={fieldInputClass}
          />
        </FieldRow>
      </div>

      <FieldRow label="Description (optional)" htmlFor="custom-line-description">
        <input id="custom-line-description" name="description" maxLength={500} className={fieldInputClass} />
      </FieldRow>

      <FieldRow label="Photo (optional)" htmlFor="custom-line-image">
        <div className="flex flex-wrap items-center gap-2">
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt=""
              className="size-12 shrink-0 rounded-lg border border-slate-200 bg-white object-contain"
            />
          ) : (
            <div className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-white">
              <ImageIcon className="size-4 text-slate-400" aria-hidden="true" />
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={uploading}
            className="relative h-11 overflow-hidden"
          >
            <Upload className="size-4" data-icon="inline-start" aria-hidden="true" />
            {imageUrl ? "Replace photo" : "Upload photo"}
            <input
              id="custom-line-image"
              type="file"
              accept={ACCEPTED_TYPES}
              onChange={handleFileChange}
              disabled={uploading}
              aria-label="Upload photo"
              className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
            />
          </Button>
          {imageUrl ? (
            <Button type="button" variant="outline" onClick={() => setImageUrl(null)} className="h-11">
              Remove photo
            </Button>
          ) : null}
          {uploading ? <span className="text-sm text-slate-500">Uploading…</span> : null}
        </div>
      </FieldRow>

      {uploadError ? (
        <p role="alert" className="text-sm text-destructive">
          {uploadError}
        </p>
      ) : null}

      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" variant="outline" disabled={pending || uploading} className="h-11 w-fit">
        {pending ? "Adding…" : "Add line"}
      </Button>
    </form>
  );
}
