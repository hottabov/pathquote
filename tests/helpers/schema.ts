// Table-driven assertions for the zod schemas in src/lib/validation/**.
//
// Most of what those schemas need proving is mechanical: this input is
// accepted, that one is not, and a normalizing schema turns this into that.
// Written out longhand, each such case costs a four-line `it()` whose body is
// a single `safeParse(...).success` assertion, and a file of forty of them
// hides the two or three cases that actually encode a business rule.
// `accepts`/`rejects` below collapse the mechanical ones into one row each so
// the surviving hand-written `it()` blocks are the interesting ones.
//
// Deliberately NOT a replacement for a narrative test: anything that states a
// rule a reader would otherwise have to infer (why a `javascript:` URL is
// refused, why the last admin cannot be demoted, how a checkbox's
// "on"/absent encoding is coerced) stays a prose-titled `it()` with its
// comment intact. A table row's title is one clause; a rule needs a sentence.
import { expect, it } from "vitest";
import type { ZodType } from "zod";

/** `[what the input is, the input, what it should parse to]`. The third
 * element is optional and only worth giving for a schema that normalizes
 * (trims, uppercases, coerces); omit it when acceptance is the whole point. */
export type ValidRow = [description: string, input: unknown, parsed?: unknown];

/** `[what the input is, the input, a substring of the expected message]`. The
 * third element is optional — give it where the wording is the thing being
 * checked (a message the user reads on a form), omit it where rejection
 * itself is the assertion. */
export type InvalidRow = [description: string, input: unknown, messageContains?: string];

/** Asserts a single input parses, returning the parsed value so a caller can
 * make further assertions on it. */
export function expectValid<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  expect(result.success, `expected the schema to accept ${JSON.stringify(input)}`).toBe(true);
  // Safe after the assertion above; narrows the union for callers.
  return (result as { success: true; data: T }).data;
}

/** Asserts a single input is rejected, and (when `messageContains` is given)
 * that some issue's message carries that text. Returns the messages so a
 * caller can assert something more specific. */
export function expectInvalid(
  schema: ZodType,
  input: unknown,
  messageContains?: string
): string[] {
  const result = schema.safeParse(input);
  expect(result.success, `expected the schema to reject ${JSON.stringify(input)}`).toBe(false);
  const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);
  if (messageContains !== undefined) {
    expect(messages.join(" | ")).toContain(messageContains);
  }
  return messages;
}

/** One `it("accepts <description>")` per row. Call it inside a `describe` for
 * the schema under test. */
export function accepts<T>(schema: ZodType<T>, rows: ValidRow[]): void {
  it.each(rows)("accepts %s", (_description, input, parsed) => {
    const data = expectValid(schema, input);
    if (parsed !== undefined) expect(data).toEqual(parsed);
  });
}

/** One `it("rejects <description>")` per row. */
export function rejects(schema: ZodType, rows: InvalidRow[]): void {
  it.each(rows)("rejects %s", (_description, input, messageContains) => {
    expectInvalid(schema, input, messageContains);
  });
}
