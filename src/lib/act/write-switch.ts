// The off switch for writing quotes into ACT!.
//
// ACT! is the production CRM, so writing into it needs a way to stop. The
// switch is the `Setting` row `act.write.enabled`, beside the sync's
// `act.sync.cursor` and `act.sync.lastRun`: a row rather than an environment
// variable, so it can be turned off the moment a write goes wrong, without a
// redeploy or a restart. OFF unless the row holds the JSON value `true`: no
// row, `false`, the string "true" or anything else reads as off. There is no
// screen for it yet; until there is, it is turned on with
//
//   INSERT INTO "Setting" ("key", "value") VALUES ('act.write.enabled', 'true')
//   ON CONFLICT ("key") DO UPDATE SET "value" = 'true';
//
// and off again with the same statement and 'false'.
//
// QUEUED REGARDLESS, SENT ONLY WHEN ON. Finalise, the client's signature and
// acceptQuote queue their ActOutbox row whatever this switch says
// (enqueueActWrite in src/lib/act/outbox.ts). A REQUIREMENT ON THE DRAIN
// (Task 7, not written yet): it reads the switch before each call it makes
// to ACT!, and sends nothing while it is off (requirement 2 in
// src/lib/act/outbox.ts). So a quote finalised while the switch is off still
// reaches ACT! once it is turned on, instead of being lost.
//
// THE CONSEQUENCE, to know before turning it on: the first drain after that
// sends EVERY quote finalised, signed or accepted since the enqueue was
// deployed, test quotes included -- every row not yet finished. Before the
// switch goes on, list them (from /opt/pathquote, as in docs/runbook.md):
//
//   docker compose exec -T postgres psql -U pathquote -d pathquote -c \
//     "SELECT o.id, d.number, o.\"createdAt\", o.\"blockedReason\" FROM \"ActOutbox\" o JOIN \"Document\" d ON d.id = o.\"documentId\" WHERE o.\"completedAt\" IS NULL ORDER BY o.\"createdAt\";"
//
// and close each one that must not reach ACT! by its id, replacing <id>:
//
//   docker compose exec -T postgres psql -U pathquote -d pathquote -c \
//     "UPDATE \"ActOutbox\" SET \"completedAt\" = now() AT TIME ZONE 'UTC', \"updatedAt\" = now() AT TIME ZONE 'UTC' WHERE id = '<id>' AND \"completedAt\" IS NULL;"
//
// `now() AT TIME ZONE 'UTC'`, not now(): the columns hold UTC without a time
// zone (enqueueStatement in src/lib/act/outbox-sql.ts says why that matters).
// A closed row is out of the drain's reach -- its query, in z65_act_outbox,
// takes unfinished rows only -- but closing it ends that write, not the
// quote's: a later finalise, signature or acceptance of the same quote
// queues a new row, which the drain sends.
//
// Pure: the drain is to read the row and hand it to actWriteEnabled.

/** The `Setting` key the switch lives under. */
export const ACT_WRITE_SWITCH_KEY = "act.write.enabled";

/**
 * Whether the drain may write to ACT!, from the `Setting` row under
 * ACT_WRITE_SWITCH_KEY -- or null when there is no row. True only for a
 * stored JSON `true`; everything else is off.
 */
export function actWriteEnabled(row: { value: unknown } | null): boolean {
  return row?.value === true;
}
