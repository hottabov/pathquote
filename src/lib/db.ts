import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { PoolConfig } from "pg";

// Prisma 7 dropped the schema-embedded `datasource.url`; the runtime client
// now requires an explicit driver adapter instead of reading DATABASE_URL on its own.
//
// Exported because the ACT! sync needs a second client, with a pool of its own
// for the advisory lock to sit on (`openLockConnection` in
// src/lib/act/sync.ts). It asks for that one here rather than constructing a
// client of its own, so anything this function grows -- ssl, schema, log --
// reaches both. `pool` says only what differs about the second client.
export function createPrismaClient(pool: PoolConfig = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url, ...pool }) });
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Only construct the adapter/client (and its connection pool) when there is
// no cached singleton — on dev hot-reload this avoids spinning up a fresh
// pg pool on every module re-evaluation. Caching in production is harmless
// (the module only evaluates once per process there) and keeps this simple.
export const db = globalForPrisma.prisma ?? (globalForPrisma.prisma = createPrismaClient());
