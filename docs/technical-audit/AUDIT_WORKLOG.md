# Audit worklog

## Checkpoint (update after every significant step)

- Date: 2026-10-16
- Branch: `main` @ af1d83f, clean at start. Audit work is committed in small
  packages on `main` (owner runs solo; no other pending changes found).
- Phase: 1 — environment check, docs skeleton, baseline.
- Dev server owned by the user running on :3100 (pid 48397, 4h) — not touched.
- Production SSH: blocked by the session's permission classifier. Key +
  command for the owner are in the final report.

## Decisions

- Measure production build (`next start` on :3200) against the local DB; dev
  mode only for diagnostics.
- Statement logging on local Postgres for SQL counts per request.

## Active agents

(none yet)

## Next step

Baseline measurements, then launch read-only diagnosis agents.

## 2026-10-16 — Phase 1 results (local, production build, tiny DB)

- Baseline A recorded (PERFORMANCE.md). Server renders every page in 25–40 ms;
  builder = 64 SQL statements / 2 ms DB; HTML 230–290 KB (45 KB gzipped).
- One discount autosave = 1 server-action POST = 84 SQL statements (20 for the
  action + 64 to re-render the whole builder page in the POST response,
  132 KB RSC payload decoded), ~185 ms locally, plus 4 `/quotes?_rsc`
  prefetch GETs re-fired by the nav link after revalidation.
- Dashboard fires 14 RSC prefetches (7 routes × 2) that get aborted on
  the first navigation.
- Each builder page load requests ~12–15 `/api/files/*.png?w=64|128` images.
- Agents running: BE/DB diagnosis, FE diagnosis, ARCH+ponytail, INFRA, and a
  seeder agent (docs/technical-audit/scripts/seed-volume.ts, 600 docs / 400
  companies) for the volume run.
- Blocker: production SSH denied by the permission classifier. Key generated at
  ~/.ssh/pathquote_audit_ed25519 (public half goes in the final report).
