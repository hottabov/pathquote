// The decisions behind every write the ACT! client makes: which requests may be
// repeated after a failure, what record an update sends, and what an answer to
// a write is taken to mean. Pure, so the suite can test them under
// `isolate: false` (see vitest.config.ts); src/lib/act/client.ts does the I/O
// and nothing else.

/** The methods the client sends. No PUT: nothing here needs one. */
export type HttpMethod = "GET" | "POST" | "PATCH";

/**
 * Whether a request may be sent again after a timeout, a network failure or a
 * 5xx -- the failures that do not say whether the server acted on it.
 *
 * GET reads, so repeating it changes nothing. PATCH is only ever sent with the
 * whole record (see mergeForWrite), so a second copy writes the same values
 * the first did.
 *
 * POST is never repeated. Every POST this client sends creates a record -- a
 * History, an opportunity, a contact, an opportunity's product line -- and a
 * request that timed out or came back 5xx may still have been committed, with
 * only the answer lost. Sending it again would then put a second History on
 * the contact, a second opportunity in the pipeline, a duplicate person in
 * ACT!, or a second product line on the deal, doubling its amount.
 */
export function isRetried(method: HttpMethod): boolean {
  return method !== "POST";
}

/** A record as the API sends it: an object, with every field ACT! chose to include. */
export type ActRecordJson = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The whole record to PATCH back: `current` as ACT! returned it, with `patch`
 * laid over it.
 *
 * WHY THE WHOLE RECORD. The scripts that have written production ACT!
 * (scripts/act-fix-country-usa.py, scripts/act-fix-country-spellings.py) read
 * each record in full, changed one field and sent every field back, because a
 * partial write to a nested object blanks its siblings. That is the path that
 * is known to work; see ActClient.updateContact for what is not.
 *
 * THE RULES:
 *
 *   - A top-level field in `patch` replaces the record's.
 *   - `undefined` in `patch` is no change: the record's value is kept. The
 *     payload builders (src/lib/act/write-payloads.ts) leave optional fields
 *     out, and a key present with no value must not read as "blank it".
 *   - `null` in `patch` clears the field. Nothing sends one today; when
 *     something does, clearing is the only thing a null can sensibly mean, and
 *     a builder that wants to keep a value -- wonOpportunityBody keeping a
 *     loss `reason` -- does so by leaving the field out, not by sending null.
 *   - `customFields` is merged KEY BY KEY onto the record's. It is a bag of
 *     unrelated fields (Account Mgr, Industry, the equipment profile...), and
 *     replacing it with a patch that names one of them would blank every other
 *     one on the record: the sibling-blanking trap, one level down. A key set
 *     to null clears that one field; a key left out is kept. A patch whose
 *     `customFields` is itself null or not an object is refused rather than
 *     read as "blank them all".
 *   - Any other object in `patch` replaces the record's WHOLE. Today that is
 *     only an opportunity's `stage`, and a stage is a reference to another
 *     stage: merging the new one over the old would send the new stage's id
 *     beside the old stage's description. A future patch to a nested value
 *     that is NOT a reference -- an address -- must therefore carry the whole
 *     object, built from the record as read, which is exactly what the two
 *     scripts above do (`dict(record[field], country=...)`).
 *   - `id` is always the id the record is being written to, in the body as
 *     well as the path: ACT! answers a PATCH without it with a 400 and an
 *     empty body (docs/superpowers/specs/2026-09-08-act-integration-design.md,
 *     "What the API actually does, verified"). An `id` in `patch` cannot move
 *     the write to another record. A `current` carrying a different id throws
 *     -- that is a read that answered with the wrong record, and writing it
 *     back would overwrite one record with another's fields.
 */
export function mergeForWrite(
  id: string,
  current: ActRecordJson,
  patch: Record<string, unknown>,
): ActRecordJson & { id: string } {
  const currentId = current.id;
  if (typeof currentId === "string" && currentId.toLowerCase() !== id.toLowerCase()) {
    throw new Error(
      `refusing to write record ${id}: the record read back for it carries id ${currentId}`,
    );
  }

  const merged: ActRecordJson = { ...current };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined || field === "id") continue;
    if (field === "customFields") {
      merged.customFields = mergeCustomFields(current.customFields, value);
      continue;
    }
    merged[field] = value;
  }
  return { ...merged, id };
}

function mergeCustomFields(current: unknown, patch: unknown): Record<string, unknown> {
  if (!isPlainObject(patch)) {
    throw new Error(
      "a patch's customFields must be an object naming the fields to change; null or a non-object would blank every custom field on the record",
    );
  }
  const merged: Record<string, unknown> = isPlainObject(current) ? { ...current } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  return merged;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What the body of a successful write's answer is.
 *
 * - `record`: an object with a string `id` -- the record as ACT! now holds it.
 *   Swagger declares this for every POST and PATCH the client sends (201 or
 *   200 with the record), and the design doc records it for
 *   `POST /api/contacts` on the live system.
 * - `id`: a bare uuid string. Not what swagger declares; recognised so that a
 *   create answered this way is read back by id, rather than becoming an error
 *   after the record already exists -- which is how a create that succeeded
 *   turns into a duplicate on the next attempt.
 * - `nothing`: anything else, an empty body included. The scripts that PATCHed
 *   production never looked at the answer, so an empty one has not been ruled
 *   out.
 */
export type WriteAnswer =
  | { kind: "record"; record: ActRecordJson & { id: string } }
  | { kind: "id"; id: string }
  | { kind: "nothing" };

export function writeAnswer(payload: unknown): WriteAnswer {
  if (isPlainObject(payload) && typeof payload.id === "string" && payload.id !== "") {
    return { kind: "record", record: payload as ActRecordJson & { id: string } };
  }
  if (typeof payload === "string" && UUID.test(payload.trim())) {
    return { kind: "id", id: payload.trim() };
  }
  return { kind: "nothing" };
}
