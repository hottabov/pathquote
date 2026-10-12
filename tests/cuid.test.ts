import { describe, it, expect } from "vitest";
import { cuid } from "../src/lib/cuid";
import { idSchema } from "../src/lib/validation/documents";

describe("cuid", () => {
  it("has the shape of Prisma's cuid(): 25 lowercase base-36 characters starting with c", () => {
    for (let i = 0; i < 100; i++) {
      expect(cuid()).toMatch(/^c[0-9a-z]{24}$/);
    }
  });

  it("passes the app's id validation", () => {
    expect(idSchema.safeParse(cuid()).success).toBe(true);
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => cuid()));
    expect(ids.size).toBe(10_000);
  });

  it("starts with the current time, so ids sort roughly by creation", () => {
    const before = Date.now();
    const id = cuid();
    const after = Date.now();
    const time = parseInt(id.slice(1, 9), 36);
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(after);
  });
});
