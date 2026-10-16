"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-reads the page a few times while a FINAL quote's newest revision has no
 * PDF yet.
 *
 * Since 2026-10-16 the revision PDF renders AFTER the finalize response
 * (`after()` in src/lib/actions/finalize.ts), so the page a manager lands on
 * was rendered before the file existed and nothing on the server can push
 * the link to it later. This polls -- 3 s, then 6, then 9, then 12 -- and
 * stops as soon as the server reports a path (the prop flips and the effect
 * cleans up) or after the fourth try: Gotenberg has 30 s, and a PDF that is
 * not there by then is one the next visit will show. Renders nothing.
 */
export function PdfPendingRefresh({ pending }: { pending: boolean }) {
  const router = useRouter();
  const attempts = useRef(0);

  useEffect(() => {
    if (!pending || attempts.current >= 4) return;
    attempts.current += 1;
    const timer = setTimeout(() => router.refresh(), 3_000 * attempts.current);
    return () => clearTimeout(timer);
  }, [pending, router]);

  return null;
}
