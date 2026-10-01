import { auth } from "@/auth";

/**
 * Where the browser reports a slow autosave (see `reportSlowSave` in
 * src/lib/use-autosave.ts). Nothing is stored: the line goes to the app's
 * stdout, i.e. `docker compose logs app`, where it sits next to nginx's
 * `rt=` request time for the same minute.
 *
 * Why it exists (2026-10-01): a 6% quote discount sat on "Saving…" for
 * about two minutes in production while every request nginx logged had
 * succeeded, and nothing on either side recorded how long anything took. The
 * browser is the only place that sees the whole wait — including time spent
 * queued behind an earlier save, since Next sends server actions one at a
 * time — so it is the browser that reports it.
 *
 * Signed-in users only (proxy.ts does not list this path as public, and the
 * session is checked again here). Input is clamped so a crafted request
 * cannot write anything but a short, single-line record.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return new Response(null, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(null, { status: 400 });
  }
  const { label, ms, path } = (body ?? {}) as Record<string, unknown>;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return new Response(null, { status: 400 });

  const clean = (value: unknown) =>
    typeof value === "string" ? value.replace(/[^\w\-/.]/g, "").slice(0, 120) : "";

  console.warn(
    `[slow-save] ${JSON.stringify({
      label: clean(label),
      ms: Math.round(ms),
      path: clean(path),
      user: session.user.email ?? session.user.id,
    })}`
  );
  return new Response(null, { status: 204 });
}
