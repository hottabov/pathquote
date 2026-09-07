"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui-kit/client";
import { SignatureDialog } from "@/components/signing/signature-dialog";
import type { ActionResult } from "@/lib/actions/users";

/**
 * The signed-in user's own saved signature, shown on a signature rule the
 * same way it will appear on a quote once Task 8 renders it there. Unlike
 * `AvatarEditor`, there is no upload-then-attach step: `SignatureDialog`
 * hands back a data URL directly, and `onSave` (bound to `saveMySignature`)
 * takes that data URL itself — the byte validation happens server-side in
 * `parseSignatureDataUrl` (src/lib/signing/data-url.ts), which is the actual
 * trust boundary, so nothing here re-checks the image before sending it.
 */
export function SignatureEditor({
  signatureUrl,
  onSave,
  onClear,
}: {
  signatureUrl: string | null;
  onSave: (dataUrl: string) => Promise<ActionResult>;
  onClear: () => Promise<ActionResult>;
}) {
  const [url, setUrl] = useState(signatureUrl);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  function handleConfirm(dataUrl: string) {
    setDialogOpen(false);
    startTransition(async () => {
      const result = await onSave(dataUrl);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setUrl(dataUrl);
      toast.success("Signature saved");
    });
  }

  function handleRemove() {
    startTransition(async () => {
      const result = await onClear();
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setUrl(null);
      toast.success("Signature removed");
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-20 w-56 items-end border-b border-slate-300">
        {url ? (
          // Plain <img>, not next/image: a locally stored signature file,
          // same reasoning as the avatar and catalogue thumbnails (see
          // src/components/ui-kit/avatar.tsx).
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="Your signature" className="max-h-16 max-w-full object-contain" />
        ) : (
          <span className="pb-1 text-xs text-slate-400">No signature saved</span>
        )}
      </div>
      <div className="flex gap-3">
        <Button type="button" variant="outline" disabled={pending} onClick={() => setDialogOpen(true)}>
          Draw signature
        </Button>
        {url ? (
          <Button type="button" variant="ghost" disabled={pending} onClick={handleRemove}>
            Remove
          </Button>
        ) : null}
      </div>
      {dialogOpen ? (
        <SignatureDialog
          title="Your signature"
          confirmLabel="Save"
          onConfirm={handleConfirm}
          onCancel={() => setDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}
