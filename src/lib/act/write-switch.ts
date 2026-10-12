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
// (enqueueActWrite in src/lib/act/outbox.ts); the drain (Task 7) reads the
// switch and sends nothing while it is off. So a quote finalised while the
// switch is off still reaches ACT! once it is turned on, instead of being
// lost. THE CONSEQUENCE, to know before turning it on: the first drain after
// that sends EVERY quote finalised, signed or accepted since the enqueue was
// deployed -- test quotes included. Anything that should not reach ACT! has
// to be dealt with before the switch goes on.
//
// Pure: the drain reads the row and hands it to actWriteEnabled.

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
