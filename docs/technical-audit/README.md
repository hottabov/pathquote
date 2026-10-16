# Technical audit — performance, correctness, architecture (2026-10-16)

## Purpose

PathQuote became slow: simple actions and page loads sometimes take an
unacceptable time. This audit finds the real causes with evidence, fixes them,
and verifies the result. Primary priority: speed of real user scenarios. Then
correctness, reliability, architecture, unnecessary complexity.

## Scope

- Whole repository (`src/`, `prisma/`, `scripts/`, Dockerfile, compose, CI).
- Runtime path: browser → nginx → Next.js 16 (proxy.ts auth) → server
  components / server actions → Prisma 7 (pg driver adapter) → PostgreSQL 16;
  Gotenberg for PDFs; ACT! sync (external, VPS-only).
- Out of scope unless it affects speed/correctness: visual design, copy.

## Environment

| | Local (this audit) | Production |
|---|---|---|
| App | `next build` + `next start` on port 3200 (dev server on 3100 left untouched) | Docker `app` (standalone), `127.0.0.1:3010`, nginx in front |
| DB | postgres:16-alpine in Docker (`pfinvoice-postgres-1`, port 55432), 11 MB, 2 documents | postgres:16-alpine in Docker, same compose, real data |
| Node | local Node 22 | node:22-alpine |
| Hardware | Apple Silicon Mac | VPS (specs to be confirmed over SSH) |

Local data volume is tiny (2 documents, 1 company, 59 products, 105 options).
Anything that is slow locally is a code-path problem, not a data-volume one.
Data-volume effects need production counts (see AUDIT_WORKLOG.md, blockers).

## How to reproduce the measurements

See PERFORMANCE.md. Scripts live in `docs/technical-audit/scripts/`.
Postgres statement logging is enabled locally with
`ALTER SYSTEM SET log_min_duration_statement = 0` (docker logs of the
postgres container then carry every statement with its duration).

## Documents

- `AUDIT_WORKLOG.md` — state, decisions, active agents, next step (checkpoint).
- `FINDINGS.md` — single register of problems.
- `PERFORMANCE.md` — method, baseline, targets, before/after.
- `FIX_PLAN.md` — order, dependencies, acceptance criteria.
- `ARCHITECTURE.md` — actual architecture, problem couplings, justified changes.
- `VERIFICATION.md` — checks run and their results.
