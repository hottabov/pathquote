import { describe, it, expect } from "vitest";
import { supportSubjectSchema, supportBodySchema, supportMessageSchema } from "@/lib/validation/support";
import { accepts, rejects } from "./helpers/schema";

describe("supportSubjectSchema", () => {
  accepts(supportSubjectSchema, [
    ["a subject with surrounding whitespace, trimmed", "  Prices are wrong  ", "Prices are wrong"],
    ["a subject at exactly 150 characters", "a".repeat(150)],
  ]);

  rejects(supportSubjectSchema, [
    ["a blank subject", ""],
    ["a whitespace-only subject", "   "],
    ["a subject over 150 characters", "a".repeat(151)],
  ]);
});

describe("supportBodySchema", () => {
  accepts(supportBodySchema, [["a message at exactly 5000 characters", "a".repeat(5000)]]);

  rejects(supportBodySchema, [
    ["a blank message", ""],
    ["a whitespace-only message", "   "],
    ["a message over 5000 characters", "a".repeat(5001)],
  ]);
});

describe("supportMessageSchema", () => {
  it("accepts a fully populated valid submission", () => {
    const result = supportMessageSchema.safeParse({
      subject: "Prices are wrong",
      body: "The X-Calibre series shows AUD for a US company.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a submission missing either field", () => {
    expect(supportMessageSchema.safeParse({ subject: "Only a subject" }).success).toBe(false);
    expect(supportMessageSchema.safeParse({ body: "Only a body" }).success).toBe(false);
    expect(supportMessageSchema.safeParse({}).success).toBe(false);
  });
});
