/**
 * The centred card the client sees whenever their link opens nothing usable.
 *
 * `not-found` never says whether a token existed: a missing token and
 * someone else's token render the identical screen, matching how a foreign
 * and a nonexistent document both 404 in the builder's own read
 * (src/lib/queries/documents-builder.ts) — telling the two apart here would
 * hand a guesser a bit exists/doesn't-exist oracle for free.
 */
export type LinkProblemKind = "not-found" | "expired" | "revoked" | "declined";

type Author = { authorName: string; authorEmail: string };

const COPY: Record<LinkProblemKind, string> = {
  "not-found": "This link isn't valid. It may have been mistyped, or replaced by a newer one.",
  expired: "This link has expired.",
  revoked: "This quote is no longer current. {author} will be in touch.",
  declined: "You declined this quote. {author} will be in touch.",
};

export function LinkProblem({ kind, authorName, authorEmail }: { kind: LinkProblemKind } & Partial<Author>) {
  const author = authorName ? `${authorName}${authorEmail ? ` (${authorEmail})` : ""}` : null;
  const message = COPY[kind].replace("{author}", author ?? "The sender");

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-8 text-center shadow-sm">
        <p className="text-base text-neutral-700">{message}</p>
        {kind === "expired" && author ? (
          <p className="mt-3 text-sm text-neutral-500">Contact {author} for a new link.</p>
        ) : null}
      </div>
    </main>
  );
}
