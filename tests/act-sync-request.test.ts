import { describe, expect, it } from "vitest";
import { parseSyncRequest, SYNC_REQUEST_PICKUP_MINUTES } from "@/lib/act/sync-request";
import { parseStoredActLinkLists } from "@/lib/act/user-link-read";

describe("parseSyncRequest", () => {
  it("reads a stored request", () => {
    expect(parseSyncRequest({ at: "2026-10-16T10:00:00.000Z", byUserId: "u1" })).toEqual({
      at: "2026-10-16T10:00:00.000Z",
      byUserId: "u1",
    });
  });
  it("treats a row that does not parse as a request with no author", () => {
    expect(parseSyncRequest(null)).toEqual({ at: new Date(0).toISOString(), byUserId: "" });
    expect(parseSyncRequest("junk")).toEqual({ at: new Date(0).toISOString(), byUserId: "" });
  });
  it("names the drain timer's cadence", () => {
    expect(SYNC_REQUEST_PICKUP_MINUTES).toBe(5);
  });
});

describe("parseStoredActLinkLists", () => {
  it("accepts a snapshot and rejects anything else", () => {
    const snapshot = { readAt: "2026-10-16T10:00:00.000Z", actUsers: [], repItems: [] };
    expect(parseStoredActLinkLists(snapshot)).toEqual(snapshot);
    expect(parseStoredActLinkLists(null)).toBeNull();
    expect(parseStoredActLinkLists({ readAt: 1, actUsers: [], repItems: [] })).toBeNull();
    expect(parseStoredActLinkLists({ readAt: "x", actUsers: {}, repItems: [] })).toBeNull();
  });
});
