"use client";

import { useRef, useState, useTransition, type ChangeEvent } from "react";
import { Pencil } from "lucide-react";
import { Avatar } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/actions/documents";

const ACCEPTED_TYPES = "image/jpeg,image/png,image/webp";

/**
 * The signed-in user's own avatar, editable in place: hovering (or focusing)
 * it reveals a pencil overlay that opens the file picker.
 *
 * This lives on the dashboard rather than in Settings because a MANAGER
 * never goes to Settings — that section is the admin's. An ADMIN changes
 * *other* people's photos from the users list; everyone changes their own
 * here, next to their own name.
 *
 * Upload is the same two-step flow `ImageUpload` uses — POST the file to
 * /api/uploads with `purpose=avatar` (raster only, no SVG: this picture is
 * shown to other users), then hand the returned `/api/files/<name>` URL to
 * `setUserAvatar`, which re-checks server-side that the caller may write
 * this user's row. The permission is enforced there, never here.
 */
export function AvatarEditor({
  name,
  email,
  image,
  size = 40,
  onSave,
}: {
  name: string | null;
  email: string;
  image: string | null;
  size?: number;
  onSave: (url: string | null) => Promise<ActionResult>;
}) {
  const [url, setUrl] = useState(image);
  const [uploading, setUploading] = useState(false);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const busy = uploading || pending;

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset so picking the same file again still fires onChange.
    event.target.value = "";
    if (!file) return;

    setUploading(true);
    let uploadedUrl: string;
    try {
      const formData = new FormData();
      formData.set("file", file);
      formData.set("purpose", "avatar");
      const response = await fetch("/api/uploads", { method: "POST", body: formData });
      const body = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!response.ok || !body?.url) {
        toast.error(body?.error ?? "Upload failed.");
        return;
      }
      uploadedUrl = body.url;
    } catch {
      toast.error("Upload failed. Check your connection and try again.");
      return;
    } finally {
      setUploading(false);
    }

    startTransition(async () => {
      const result = await onSave(uploadedUrl);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setUrl(uploadedUrl);
      toast.success("Photo updated");
    });
  }

  return (
    <span className="group relative inline-flex shrink-0">
      <Avatar name={name} email={email} image={url} size={size} />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        aria-label="Change your photo"
        className={cn(
          "focus-ring absolute inset-0 flex items-center justify-center rounded-full bg-slate-900/55 text-white",
          // Hidden until wanted, but never hidden from the keyboard: the
          // overlay appears on hover and on focus alike, so this is not a
          // pointer-only affordance.
          "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
          busy && "opacity-100"
        )}
      >
        <Pencil style={{ width: size * 0.35, height: size * 0.35 }} aria-hidden="true" />
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        onChange={handleFileChange}
        disabled={busy}
        className="hidden"
        tabIndex={-1}
      />
    </span>
  );
}
