import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { enqueueStatement } from "../src/lib/act/outbox-sql";

const now = new Date("2026-10-12T01:30:00.000Z");
const statement = enqueueStatement({
  id: "6f1c2a9e-3b7d-4e2a-9c41-0d5e8f7a1b23",
  documentId: "cdocument0000000000000000",
  quoteRevisionId: "crevision0000000000000000",
  now,
});
// Whitespace collapsed, so the assertions read the statement rather than its layout.
const collapse = (sql: string) => sql.replace(/\s+/g, " ").trim();
const text = collapse(statement.text);
const set = text.slice(text.indexOf("DO UPDATE SET") + "DO UPDATE SET".length);
const assignments = Object.fromEntries(
  set.split(",").map((part) => part.split("=").map((side) => side.trim()) as [string, string]),
);

describe("enqueueStatement", () => {
  it("inserts every column without a usable default, each as a parameter, and generation 0", () => {
    expect(text).toContain(
      'INSERT INTO "ActOutbox" ("id", "documentId", "quoteRevisionId", "generation", "nextAttemptAt", "createdAt", "updatedAt") VALUES ($1, $2, $3, 0, $4, $5, $6)',
    );
    expect(statement.values).toEqual([
      "6f1c2a9e-3b7d-4e2a-9c41-0d5e8f7a1b23",
      "cdocument0000000000000000",
      "crevision0000000000000000",
      now,
      now,
      now,
    ]);
  });

  it("stamps every time with the Date it is given, never the database clock", () => {
    expect(text).not.toMatch(/now\(\)|CURRENT_TIMESTAMP|LOCALTIMESTAMP/i);
    expect(statement.values.filter((value) => value === now)).toHaveLength(3);
  });

  it("targets the partial unique index, predicate included", () => {
    expect(text).toContain('ON CONFLICT ("documentId") WHERE "completedAt" IS NULL DO UPDATE SET');
  });

  it("on a take-over, repoints the revision, adds 1 to generation and resets the row's own progress", () => {
    expect(assignments).toEqual({
      '"quoteRevisionId"': 'EXCLUDED."quoteRevisionId"',
      '"generation"': '"ActOutbox"."generation" + 1',
      '"opportunityActId"': "NULL",
      '"productLineSkippedAt"': "NULL",
      '"blockedReason"': "NULL",
      '"lastError"': "NULL",
      '"attempts"': "0",
      '"nextAttemptAt"': 'EXCLUDED."nextAttemptAt"',
      '"updatedAt"': 'EXCLUDED."updatedAt"',
    });
  });

  it("on a take-over, keeps createInFlight, completedAt, createdAt and the id", () => {
    for (const kept of ['"createInFlight"', '"completedAt"', '"createdAt"', '"id"']) {
      expect(Object.keys(assignments)).not.toContain(kept);
    }
  });

  it("is the statement z65_act_outbox's comment quotes", () => {
    const migration = readFileSync(
      path.join(__dirname, "../prisma/migrations/z65_act_outbox/migration.sql"),
      "utf8",
    ).split("\n");
    // The quoted statement: the indented comment lines from its INSERT on.
    const start = migration.findIndex((line) => line.startsWith('--   INSERT INTO "ActOutbox"'));
    expect(start).toBeGreaterThan(-1);
    const quoted: string[] = [];
    for (const line of migration.slice(start)) {
      if (!line.startsWith("--   ")) break;
      quoted.push(line.slice("--".length));
    }
    expect(collapse(quoted.join("\n"))).toBe(text);
  });
});
