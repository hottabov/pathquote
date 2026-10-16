import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool, type PoolConfig } from "pg";

// Prisma 7 dropped the schema-embedded `datasource.url`; the runtime client
// now requires an explicit driver adapter instead of reading DATABASE_URL on its own.
//
// Exported because the ACT! sync needs a second client, with a pool of its own
// for the advisory lock to sit on (`openLockConnection` in
// src/lib/act/sync.ts). It asks for that one here rather than constructing a
// client of its own, so anything this function grows -- ssl, schema, log --
// reaches both. `pool` says only what differs about the second client.
export function createPrismaClient(
  pool: PoolConfig = {},
  // The adapter's options rather than the pool's -- a separate argument because
  // PrismaPg takes them separately, and spreading them into the pool config
  // would silently drop them. Only `onPoolError` so far: the adapter attaches
  // its own `error` listener to the pool it creates (so a dying connection does
  // not end the process as an unhandled `error` event would) but reports it
  // through Prisma's `debug()`, which says nothing unless DEBUG is set. A
  // caller that cares which connection died has to ask for it.
  options: { onPoolError?: (error: Error) => void } = {},
) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, ...pool }, options),
  });
}

/** A query slower than this is written to the log (one line, with its
 * duration and the first 200 characters of SQL). Off when unset or 0. The
 * audit of 2026-10-16 found no way to see a slow statement in production
 * (no pg_stat_statements, no Prisma log), so this is the cheapest thing that
 * says WHICH query was slow when a save takes seconds. */
const SLOW_QUERY_MS = Number(process.env.PRISMA_SLOW_MS ?? 0);

/**
 * The web server's own pool. Built here rather than left to the adapter so
 * that its counters (`totalCount`, `idleCount`, `waitingCount`) can be read
 * by src/instrumentation.ts, and so that its limits are explicit:
 *
 * - `connectionTimeoutMillis`: node-postgres's default is 0, which means a
 *   checkout that finds every connection busy waits with NO timer at all
 *   (pg-pool/index.js, `_pendingQueue`). Under load that is a request that
 *   looks hung to the browser, succeeds minutes later, and is logged 200 by
 *   nginx -- the exact shape of the 2026-10-01 two-minute save. Five seconds
 *   turns that into a loud error instead.
 * - `idleTimeoutMillis`: the default 10 s reaps every idle connection after a
 *   quiet minute, so each burst starts by reconnecting and authenticating.
 *   30 s keeps a working set warm without holding connections all day.
 * - `options`: two server-side bounds that Postgres ships with 0 (off).
 *   `statement_timeout` cuts a single runaway statement; the web server has
 *   no statement that should run 30 s (the long jobs -- the ACT! sync and
 *   drain -- run on their own lock clients through `createPrismaClient`,
 *   which does not set this). `idle_in_transaction_session_timeout` frees a
 *   connection whose transaction is waiting on something that is not the
 *   database; Prisma's interactive transactions already time out at 5 s, so
 *   60 s only ever fires on a leak.
 * - `max` stays at the default 10: `openLockConnection`'s connection
 *   arithmetic in src/lib/act/sync.ts counts on it.
 */
function createWebPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return new Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    options: "-c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000",
  });
}

function createWebClient(pool: Pool): PrismaClient {
  const client = new PrismaClient({
    adapter: new PrismaPg(pool),
    log: SLOW_QUERY_MS > 0 ? [{ emit: "event", level: "query" }] : [],
  });
  if (SLOW_QUERY_MS > 0) {
    client.$on("query", (e) => {
      if (e.duration >= SLOW_QUERY_MS) {
        console.warn(`[slow-query] ${e.duration}ms ${e.query.replace(/\s+/g, " ").slice(0, 200)}`);
      }
    });
  }
  return client;
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient; prismaPool?: Pool };

// Only construct the adapter/client (and its connection pool) when there is
// no cached singleton — on dev hot-reload this avoids spinning up a fresh
// pg pool on every module re-evaluation. Caching in production is harmless
// (the module only evaluates once per process there) and keeps this simple.
export const dbPool = globalForPrisma.prismaPool ?? (globalForPrisma.prismaPool = createWebPool());
export const db = globalForPrisma.prisma ?? (globalForPrisma.prisma = createWebClient(dbPool));

/** The pool's counters, for the health check and the instrumentation line. */
export function dbPoolStats() {
  return { total: dbPool.totalCount, idle: dbPool.idleCount, waiting: dbPool.waitingCount };
}
