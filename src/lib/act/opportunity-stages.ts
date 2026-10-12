// Which ACT! sales process a quote's region belongs to, which stage a
// finalised quote and a won one put the opportunity at, and whether moving an
// existing opportunity to that stage is allowed.
//
// TRANSCRIBED, NOT READ. Every uuid below was copied by hand from ACT!'s own
// answer, captured on 2026-10-05 as RAW/ACT/meta/opp_stages.json (a local
// file, not committed; docs/act-integration-reference.md section 8 has the
// process ids and stage names, not the stage ids). Nothing in the app reads a
// process definition, and none of this is checked at runtime. If an
// administrator deletes or re-creates a stage or a process in ACT!, the ids go
// stale and the first sign is a queued write failing deep inside the drain; if
// one renames or reorders stages, the names and numbers here are quietly
// wrong instead, and the forward-only rule below orders by the old numbers.
// To re-read them:
// `GET /api/opportunities/processes` for the process ids, then
// `GET /api/opportunities/processes/{processId}/stages` for each one's stages.
// Change the table below to match, never the other way round.
//
// UK SHARES AU'S PROCESS BY DECISION, not by fallback. ACT! has no UK process;
// the user decided on 2026-10-12 that British quotes go into the Pathfinder
// Sales Cycle rather than having nowhere to go. It is written out as its own
// row so that it reads as a choice and can be changed as one.
//
// AN UNKNOWN REGION RETURNS NULL. There is no default process. A fourth region
// added to PathQuote should surface as a blocked write that names itself, not
// as its deals quietly joining the Australian pipeline. The caller turns null
// into that blocked reason (src/lib/act/outbox-plan.ts).
//
// STAGES ARE ORDERED BY `number`, NEVER BY `probability`. `number` is ACT!'s
// own position of a stage within its process. Probability looks like an order
// and usually agrees with it, but the third process in this installation,
// "Previous ACT! Sales Process" (inactive, unused), carries thirteen stages
// that are all at 0% -- probability ties there and orders nothing. Nothing
// stops an administrator giving a live process the same treatment.
//
// AND `number` ONLY ORDERS STAGES WITHIN ONE PROCESS. US stage 4 (Gain
// Commitment, 80%) and AU stage 4 (Proposal, 40%) are not the same place, and
// neither is ahead of the other. So an opportunity found in a process other
// than the target's -- moved there by hand in ACT!, or left behind if the
// processes are ever unified -- is not moved at all, and the answer says so
// ("different-process") so the caller can report it rather than guess.
//
// Pure: no I/O, no imports.

/** One stage of an ACT! sales process, as transcribed. */
export type StageDef = {
  /** ACT!'s stage uuid. */
  id: string;
  name: string;
  /** Percent, 0-100. Shown to people; never used to order anything. */
  probability: number;
  /** Position within its process -- the only thing stages are ordered by. */
  number: number;
  /** The process this stage belongs to. */
  processId: string;
};

/** A region's process and the two stages PathQuote writes into it. */
export type RegionProcess = {
  processId: string;
  processName: string;
  /** Where a finalised quote puts the opportunity. */
  sent: StageDef;
  /** Where an accepted quote closes it. */
  won: StageDef;
};

/**
 * Where an existing opportunity sits, as far as ordering is concerned.
 *
 * `processId` is required because a bare `number` is meaningless on its own
 * (see the header). The caller reads it off the opportunity's current
 * `stage.process.id`.
 */
export type StagePosition = { processId: string; number: number };

const SALES_CYCLE_ID = "2380e83d-cef4-4b6d-ad15-dc9a558431ab";
const US_PROCESS_ID = "26ab3a1e-ff20-406d-a0b4-3b351955da45";

const SALES_CYCLE: RegionProcess = {
  processId: SALES_CYCLE_ID,
  processName: "Pathfinder Sales Cycle",
  sent: {
    id: "5e3bb017-ab1a-468a-8d58-0f71d6df9cbf",
    name: "Proposal",
    probability: 40,
    number: 4,
    processId: SALES_CYCLE_ID,
  },
  won: {
    id: "2fc8fb09-24bb-4b24-a97c-f5ceedb7b39c",
    name: "Sales Fulfillment",
    probability: 100,
    number: 7,
    processId: SALES_CYCLE_ID,
  },
};

const US_SALES_PROCESS: RegionProcess = {
  processId: US_PROCESS_ID,
  processName: "Pathfinder US Sales Process",
  sent: {
    id: "ddf43a76-f167-4268-9cce-4be315903729",
    name: "Engage",
    probability: 40,
    number: 2,
    processId: US_PROCESS_ID,
  },
  won: {
    id: "6a03c159-b1fa-4fa9-9359-612c8e9e4369",
    name: "Execute Fulfilment",
    probability: 100,
    number: 5,
    processId: US_PROCESS_ID,
  },
};

/** Region.code -> process. Codes are exactly those in prisma/seed-lib.ts. */
const BY_REGION: Record<string, RegionProcess> = {
  AU: SALES_CYCLE,
  // By decision, 2026-10-12: ACT! has no UK process. See the header.
  UK: SALES_CYCLE,
  US: US_SALES_PROCESS,
};

/** The process a region's quotes go into, or null when nobody has mapped it. */
export function processForRegion(code: string): RegionProcess | null {
  // `Object.hasOwn`, not `BY_REGION[code] ?? null`: a code such as
  // "constructor" or "toString" would otherwise find Object.prototype.
  return Object.hasOwn(BY_REGION, code) ? BY_REGION[code] : null;
}

/** The stage a finalised quote puts its opportunity at, or null for an unmapped region. */
export function sentStage(code: string): StageDef | null {
  return processForRegion(code)?.sent ?? null;
}

/** The stage an accepted quote closes its opportunity at, or null for an unmapped region. */
export function wonStage(code: string): StageDef | null {
  return processForRegion(code)?.won ?? null;
}

/**
 * What to do about an opportunity's stage.
 *
 * - `move`: set it to the target. A new opportunity (`current` null), or one
 *   behind the target in the same process.
 * - `stay`: leave it. Already at the target or past it -- the stage only ever
 *   moves forward, because "this deal reached negotiation" stays true after a
 *   later quote, and pulling somebody else's opportunity backwards is what
 *   destroys confidence in the pipeline numbers.
 * - `different-process`: leave it, and say why. Its stage number cannot be
 *   compared with the target's at all (see the header).
 */
export type StageMove = "move" | "stay" | "different-process";

export function stageMove(current: StagePosition | null, target: StageDef): StageMove {
  if (!current) return "move";
  if (current.processId !== target.processId) return "different-process";
  return target.number > current.number ? "move" : "stay";
}

/** True only when `stageMove` says `move`. */
export function shouldMoveStage(current: StagePosition | null, target: StageDef): boolean {
  return stageMove(current, target) === "move";
}
