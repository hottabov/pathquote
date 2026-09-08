import { Button } from "@/components/ui/button";

/**
 * Placeholder for the sticky Sign / Print / Send bar under the client's
 * quote. A later task (Task 14 — "Client signs and completes") replaces this
 * with the real signing flow: `SignatureDialog`, the confirm/decline actions
 * in `src/lib/actions/signing-client.ts`, and whatever state those need.
 *
 * Rendered disabled rather than omitted so Task 13's page has something to
 * anchor at the foot of the quote and reviewers can see where the real bar
 * will sit — the button does nothing yet on purpose.
 */
export function ClientActionBar({
  completed,
  hasClientSignature,
}: {
  token: string;
  completed: boolean;
  hasClientSignature: boolean;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-neutral-200 bg-white/95 px-4 py-3 backdrop-blur">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
        <p className="text-sm text-neutral-500">
          {completed
            ? "This quote has been signed."
            : hasClientSignature
              ? "Signature drawn — not yet confirmed."
              : "Review the quote above, then sign below."}
        </p>
        <Button type="button" disabled>
          {completed ? "Signed" : "Sign"}
        </Button>
      </div>
    </div>
  );
}
