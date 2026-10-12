import { describe, it, expect } from "vitest";
import { enqueueStatement } from "../src/lib/act/outbox-sql";

const now = new Date("2026-10-12T01:30:00.000Z");
const statement = enqueueStatement({
  id: "cnewrow000000000000000000",
  documentId: "cdocument0000000000000000",
  quoteRevisionId: "crevision0000000000000000",
  now,
});
// Whitespace collapsed, so the assertions read the statement rather than its layout.
const text = statement.text.replace(/\s+/g, " ").trim();

describe("enqueueStatement", () => {
  it("inserts every column without a usable default, each as a parameter", () => {
    expect(text).toContain(
      'INSERT INTO "ActOutbox" ("id", "documentId", "quoteRevisionId", "nextAttemptAt", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6)',
    );
    expect(statement.values).toEqual([
      "cnewrow000000000000000000",
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

  it("on a take-over, repoints the revision and resets the row's own progress", () => {
    const set = text.slice(text.indexOf("DO UPDATE SET") + "DO UPDATE SET".length);
    const assignments = Object.fromEntries(
      set.split(",").map((part) => part.split("=").map((side) => side.trim()) as [string, string]),
    );
    expect(assignments).toEqual({
      '"quoteRevisionId"': 'EXCLUDED."quoteRevisionId"',
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
    const set = text.slice(text.indexOf("DO UPDATE SET"));
    for (const kept of ['"createInFlight"', '"completedAt" =', '"createdAt"', '"id"']) {
      expect(set).not.toContain(kept);
    }
  });
});
