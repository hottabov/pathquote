"use client";

import {
  startTransition,
  useActionState,
  useId,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { ImageIcon, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldRow, fieldInputClass } from "@/components/ui-kit";
import { addCustomLine, updateCustomLine, type ActionResult } from "@/lib/actions/documents";
import { pickDerivativeWidth } from "@/lib/image-derivative-width";

const initialState: ActionResult = {};

// Matches DOCUMENT_LINE_TYPES in src/lib/uploads.ts — the purpose-scoped
// allow-list `purpose=document-line` enforces server-side (SVG excluded,
// unlike the catalog uploader, since a salesperson's own upload shouldn't
// be able to smuggle in script-bearing XML). SVG being impossible here means
// the preview below never needs a vector special-case the way CatalogThumb
// does.
const ACCEPTED_TYPES = "image/jpeg,image/png,image/webp";

// The preview box is 48 CSS px (`size-12`) — the same "don't ship the
// print-resolution original just to shrink it with CSS" reasoning as
// CatalogThumb/ItemsList applies to this just-uploaded photo too.
const PREVIEW_BOX_PX = 48;

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
 * the next line without the manager clearing fields by hand. Submitted
 * through `onSubmit` rather than `<form action>` precisely because of that
 * hidden field -- see the note on `handleSubmit` below.
 *
 * The same form edits a line as well as adding one. An extra line could
 * previously only be deleted and typed again -- photo and all -- which is
 * both slow and how a line ends up further down the list than the one it
 * replaced. Editing has to offer exactly the fields creating it did, so it
 * is this component with `line` filled in rather than a second form that
 * would drift from it.
 */
export function AddCustomLineForm({
  documentId,
  line,
  onDone,
}: {
  documentId: string;
  /** The line being edited, or undefined to add a new one. */
  line?: {
    id: string;
    name: string;
    description: string | null;
    qty: number;
    unitPrice: string;
    imageUrl: string | null;
  };
  /** Called after a successful edit so the caller can close the form. Unused
   * when adding: that form stays open and empties itself, ready for the
   * next line. */
  onDone?: () => void;
}) {
  const editing = line !== undefined;
  // Declared above the action below, which clears them on a successful add.
  // Unique ids per instance: the add form and an open edit form are on the
  // page together, and duplicate ids would point every label at the first.
  const fieldId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(line?.imageUrl ?? null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // What happens after a successful save lives inside the action, not in an
  // effect watching `pending` fall. The effect version had to remember
  // whether it had been pending, could not tell one settle from the next,
  // and cleared state synchronously inside an effect body -- three
  // problems that all go away once the code that knows the save succeeded
  // is the code that did it.
  const [state, formAction, pending] = useActionState(
    async (_prevState: ActionResult, formData: FormData) => {
      const result =
        (line ? await updateCustomLine(line.id, formData) : await addCustomLine(documentId, formData)) ?? {};
      if (result.error) return result;
      if (line) {
        // The row behind this form re-renders from the server, so there is
        // nothing to reset here -- closing is the whole of "done".
        onDone?.();
      } else {
        formRef.current?.reset();
        setImageUrl(null);
        setUploadError(null);
      }
      return result;
    },
    initialState
  );

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
        // Inline only. The rule across the builder: `role="alert"` under the
        // control for something the user can fix here, a toast only for an
        // optimistic update that had to be rolled back, and never both for
        // one failure -- which is what this was, saying the same sentence
        // twice in two places for one bad upload.
        setUploadError(body?.error ?? "Upload failed.");
        return;
      }
      setImageUrl(body.url);
    } catch {
      setUploadError("Upload failed. Check your connection and try again.");
    } finally {
      setUploading(false);
    }
  }

  // Submitted through `onSubmit` rather than `<form action>` -- see
  // `CompanyForm` (src/components/clients/company-form.tsx). The hidden
  // `imageUrl` input below is controlled by `imageUrl` state, set once the
  // upload finishes -- the same shape `<form action>` breaks: on any settle
  // React 19 resets that hidden input's DOM value back to "" (its value at
  // mount) while `imageUrl` state -- and the preview still showing the photo
  // -- does not change, so a rejected line (a malformed unit price, say)
  // would silently drop the photo from the next submit even though the
  // preview still shows it. It also stops the settle-triggered reset from
  // wiping the plain name/qty/description inputs on an error, which
  // `formRef.current?.reset()` below now handles deliberately, only on
  // success. Browser validation still runs before this fires.
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4"
    >
      <input type="hidden" name="imageUrl" value={imageUrl ?? ""} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr_1fr]">
        <FieldRow label="Name" htmlFor={`${fieldId}-name`} required>
          <input
            id={`${fieldId}-name`}
            name="name"
            required
            maxLength={200}
            defaultValue={line?.name}
            placeholder="e.g. Delivery, or Trade-in K5 390"
            className={fieldInputClass}
          />
        </FieldRow>
        <FieldRow label="Qty" htmlFor={`${fieldId}-qty`} required>
          <input
            id={`${fieldId}-qty`}
            name="qty"
            type="number"
            inputMode="numeric"
            min={1}
            max={999}
            defaultValue={line?.qty ?? 1}
            required
            className={fieldInputClass}
          />
        </FieldRow>
        <FieldRow label="Unit price" htmlFor={`${fieldId}-unit-price`} required>
          <input
            id={`${fieldId}-unit-price`}
            name="unitPrice"
            type="text"
            inputMode="decimal"
            defaultValue={line?.unitPrice}
            placeholder="0.00, or -15000.00 for a trade-in"
            required
            className={fieldInputClass}
          />
        </FieldRow>
      </div>

      <FieldRow label="Description (optional)" htmlFor={`${fieldId}-description`}>
        <input
          id={`${fieldId}-description`}
          name="description"
          defaultValue={line?.description ?? undefined}
          maxLength={500}
          className={fieldInputClass}
        />
      </FieldRow>

      <FieldRow label="Photo (optional)" htmlFor={`${fieldId}-image`}>
        <div className="flex flex-wrap items-center gap-2">
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`${imageUrl}?w=${pickDerivativeWidth(PREVIEW_BOX_PX * 2)}`}
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
            size="touch"
            className="relative overflow-hidden"
          >
            <Upload className="size-4" data-icon="inline-start" aria-hidden="true" />
            {imageUrl ? "Replace photo" : "Upload photo"}
            <input
              id={`${fieldId}-image`}
              type="file"
              accept={ACCEPTED_TYPES}
              onChange={handleFileChange}
              disabled={uploading}
              aria-label="Upload photo"
              className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
            />
          </Button>
          {imageUrl ? (
            <Button type="button" variant="outline" onClick={() => setImageUrl(null)} size="touch">
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

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant={editing ? "brand" : "outline"}
          disabled={pending || uploading}
          size="touch"
          className="w-fit"
        >
          {pending ? (editing ? "Saving…" : "Adding…") : editing ? "Save changes" : "Add line"}
        </Button>
        {editing ? (
          <Button type="button" variant="ghost" size="touch" onClick={onDone} disabled={pending}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
