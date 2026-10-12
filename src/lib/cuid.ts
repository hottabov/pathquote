// Ids in the shape Prisma's `@default(cuid())` gives them, for a row written
// with raw SQL.
//
// Every model with a generated id takes it from `@default(cuid())`, and Prisma
// fills that in its client, not the database: the column has no default. So a
// raw INSERT
// -- enqueueActWrite in src/lib/act/outbox.ts, which cannot use Prisma's
// `upsert` because the conflict it handles is on a partial index -- has to
// supply the id itself. Prisma 7.10 does not export its generator (it is
// bundled inside @prisma/client/runtime/client.js), and no cuid package is
// installed, so this is that generator's algorithm, cuid v1: "c", the time in
// milliseconds in base 36, a 4-character counter, a 4-character fingerprint
// of the process and host, and 8 random characters -- 25 lowercase base-36
// characters, the same shape as the ids Prisma makes.
//
// One difference from Prisma's copy: the random block comes from node:crypto
// rather than Math.random. The shape is the same; only the randomness is
// harder to guess.

import { randomInt } from "node:crypto";
import { hostname } from "node:os";

const BASE = 36;
const BLOCK = 4;
const BLOCK_SIZE = BASE ** BLOCK;

function pad(value: string, size: number): string {
  return value.padStart(size, "0").slice(-size);
}

function hostName(): string {
  try {
    return hostname();
  } catch {
    return "hostname";
  }
}

// Prisma's fingerprint: two characters of the process id, two of a sum over
// the host name's characters.
const FINGERPRINT = (() => {
  const host = hostName();
  const hostSum = host.split("").reduce((sum, char) => sum + char.charCodeAt(0), host.length + BASE);
  return pad(process.pid.toString(BASE), 2) + pad(hostSum.toString(BASE), 2);
})();

let counter = 0;

function nextCount(): string {
  counter = counter < BLOCK_SIZE ? counter : 0;
  return pad((counter++).toString(BASE), BLOCK);
}

function randomBlock(): string {
  return pad(randomInt(BLOCK_SIZE).toString(BASE), BLOCK);
}

/** A new id in Prisma's `cuid()` format: 25 lowercase base-36 characters starting with "c". */
export function cuid(): string {
  return "c" + Date.now().toString(BASE) + nextCount() + FINGERPRINT + randomBlock() + randomBlock();
}
