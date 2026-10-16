// Next.js instrumentation hook (node_modules/next/dist/docs/01-app/03-api-reference/
// 03-file-conventions/instrumentation.md): `register` runs once per server
// process, before it serves requests.
//
// What it does here, and why it exists at all (audit 2026-10-16): production
// had no number for "is the Node process itself stalling" or "is every
// database connection busy". A two-minute save on 2026-10-01 left nothing
// behind but nginx 200s. So once a minute, when -- and only when -- something
// is wrong, one line goes to stdout (`docker compose logs app`):
//
//   [runtime] event-loop p99=412ms max=1350ms pool total=10 idle=0 waiting=3
//
// Quiet otherwise. Thresholds are deliberately high: this is a smoke alarm,
// not a metric pipeline. Node only -- the proxy (middleware) runs in the same
// Node runtime in Next 16, but `register` is also evaluated for the edge
// bundle at build time, hence the runtime guard and the dynamic import.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // `process.getBuiltinModule` (Node 22.3+) rather than an `import`: the
  // edge bundle also evaluates this file, and a bundler-visible import of a
  // Node module warns there even though the guard above means it never runs.
  const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (!getBuiltin) return;
  const { monitorEventLoopDelay } = getBuiltin("node:perf_hooks") as typeof import("node:perf_hooks");
  // The import builds the pool; a box without DATABASE_URL must still boot
  // so /api/health can answer 503 rather than the process dying in register.
  let dbPoolStats: () => { total: number; idle: number; waiting: number };
  try {
    ({ dbPoolStats } = await import("@/lib/db"));
  } catch (error) {
    console.error("[runtime] database pool not available; event-loop lag only", error);
    dbPoolStats = () => ({ total: 0, idle: 0, waiting: 0 });
  }

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  const INTERVAL_MS = 60_000;
  const LAG_P99_WARN_MS = 200;

  const timer = setInterval(() => {
    const p99 = Math.round(histogram.percentile(99) / 1e6);
    const max = Math.round(histogram.max / 1e6);
    histogram.reset();
    const pool = dbPoolStats();
    if (p99 >= LAG_P99_WARN_MS || pool.waiting > 0) {
      console.warn(
        `[runtime] event-loop p99=${p99}ms max=${max}ms pool total=${pool.total} idle=${pool.idle} waiting=${pool.waiting}`,
      );
    }
  }, INTERVAL_MS);
  // Never keep the process alive for this alone.
  timer.unref();
}
