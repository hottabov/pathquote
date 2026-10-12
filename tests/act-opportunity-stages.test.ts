import { describe, it, expect } from "vitest";
import {
  processForRegion,
  sentStage,
  wonStage,
  shouldMoveStage,
  stageMove,
} from "../src/lib/act/opportunity-stages";

const SALES_CYCLE = "2380e83d-cef4-4b6d-ad15-dc9a558431ab";
const US_PROCESS = "26ab3a1e-ff20-406d-a0b4-3b351955da45";

describe("processForRegion", () => {
  it("puts AU and UK on the Pathfinder Sales Cycle", () => {
    expect(processForRegion("AU")?.processId).toBe("2380e83d-cef4-4b6d-ad15-dc9a558431ab");
    // UK has no sales process of its own; decided 2026-10-12 rather than
    // leaving British quotes with nowhere to go.
    expect(processForRegion("UK")?.processId).toBe("2380e83d-cef4-4b6d-ad15-dc9a558431ab");
  });

  it("puts US on its own process", () => {
    expect(processForRegion("US")?.processId).toBe("26ab3a1e-ff20-406d-a0b4-3b351955da45");
  });

  it("returns null for a region nobody has mapped", () => {
    // A fourth region would otherwise land in AU's pipeline silently.
    expect(processForRegion("NZ")).toBeNull();
  });
});

describe("sentStage and wonStage", () => {
  it("sends AU to Proposal and wins at Sales Fulfillment", () => {
    expect(sentStage("AU")).toMatchObject({ id: "5e3bb017-ab1a-468a-8d58-0f71d6df9cbf", probability: 40, number: 4 });
    expect(wonStage("AU")).toMatchObject({ id: "2fc8fb09-24bb-4b24-a97c-f5ceedb7b39c", probability: 100, number: 7 });
  });

  it("sends US to Engage and wins at Execute Fulfilment", () => {
    expect(sentStage("US")).toMatchObject({ id: "ddf43a76-f167-4268-9cce-4be315903729", probability: 40, number: 2 });
    expect(wonStage("US")).toMatchObject({ id: "6a03c159-b1fa-4fa9-9359-612c8e9e4369", probability: 100, number: 5 });
  });
});

describe("shouldMoveStage", () => {
  it("moves a new opportunity to the target", () => {
    expect(shouldMoveStage(null, sentStage("AU")!)).toBe(true);
  });

  it("moves forward", () => {
    expect(shouldMoveStage({ processId: SALES_CYCLE, number: 3 }, sentStage("AU")!)).toBe(true);
  });

  it("refuses to move backwards", () => {
    // Already at Negotiation (5). A later quote must not pull the deal back to
    // Proposal (4): "this deal reached negotiation" stays true, and moving
    // somebody else's opportunity backwards is what destroys confidence in
    // the pipeline numbers.
    expect(shouldMoveStage({ processId: SALES_CYCLE, number: 5 }, sentStage("AU")!)).toBe(false);
  });

  it("does nothing when already there", () => {
    expect(shouldMoveStage({ processId: SALES_CYCLE, number: 4 }, sentStage("AU")!)).toBe(false);
  });

  it("compares by number, never by probability", () => {
    // The legacy process has thirteen stages all at 0%, so probability ties
    // and cannot order anything. (Held in a variable so the extra
    // `probability` the comparison must ignore can ride along without an
    // excess-property error.)
    const atTwelveZeroPercent = { processId: SALES_CYCLE, number: 12, probability: 0 };
    expect(shouldMoveStage(atTwelveZeroPercent, { ...sentStage("AU")!, probability: 0 })).toBe(false);
  });

  it("moves forward even when the earlier stage carries the higher probability", () => {
    // The case where the two orderings disagree, which the tie above cannot
    // tell apart: a comparison by probability would refuse this move.
    const earlierButLikelier = { processId: SALES_CYCLE, number: 3, probability: 90 };
    expect(shouldMoveStage(earlierButLikelier, sentStage("AU")!)).toBe(true);
  });

  it("does not move an opportunity that sits in a different process", () => {
    // Stage numbers only order stages within one process. US number 4 (Gain
    // Commitment) and AU number 4 (Proposal) are not the same place, and US
    // number 1 is not "behind" AU Proposal. An AU quote whose opportunity
    // somebody moved to the US process by hand is left where they put it.
    expect(shouldMoveStage({ processId: US_PROCESS, number: 1 }, sentStage("AU")!)).toBe(false);
    expect(stageMove({ processId: US_PROCESS, number: 1 }, sentStage("AU")!)).toBe("different-process");
  });

  it("says which of the three outcomes it reached", () => {
    expect(stageMove(null, sentStage("AU")!)).toBe("move");
    expect(stageMove({ processId: SALES_CYCLE, number: 3 }, sentStage("AU")!)).toBe("move");
    expect(stageMove({ processId: SALES_CYCLE, number: 5 }, sentStage("AU")!)).toBe("stay");
  });
});
