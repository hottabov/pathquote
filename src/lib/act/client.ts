import {
  classifyWriteFailure,
  isRetried,
  mergeForWrite,
  patchToSend,
  sameRecordId,
  writableOpportunity,
  writeAnswer,
  type ActRecordJson,
  type HttpMethod,
} from "@/lib/act/record-write";
import type {
  ActContact,
  ActContactPatch,
  ActHistory,
  ActHistoryRecord,
  ActOpportunity,
  ActPicklistItem,
  ActProductLine,
  ActUser,
} from "@/lib/act/types";
import type {
  HistoryBody,
  NewContactBody,
  NewOpportunityBody,
  OpportunityPatch,
  SummaryProductBody,
  SummaryProductPatch,
} from "@/lib/act/write-payloads";

// HTTP against the Act! Web API. Every judgement this integration makes lives
// in the pure modules beside this one; what is left here is transport, and it
// is deliberately dull.
//
// Three details of this API that cost time to discover, all verified against
// the live system (docs/act-integration-reference.md):
//
//   - The username is the Act! display name as shown in Manage Users --
//     "John Hollo", not "john". A wrong username and an unregistered database
//     name both return a bare 401 with no body, so they are indistinguishable
//     from the response alone.
//   - Response envelopes are not consistent. /api/contacts returns
//     { value: [...], Count: n }; /api/users and the metadata endpoints return
//     a bare array. Reading .value off a bare array yields nothing and looks
//     exactly like a permissions failure. The /api/users half of that is in
//     doubt: swagger describes a bare array, but the response captured from the
//     live system into RAW/ACT/meta/users.json carries the { value, Count }
//     envelope. Nothing here depends on which it is -- every list goes through
//     unwrapRows, which takes either and throws on anything else.
//   - Count is the size of the page, not a total.

export type ActClientConfig = {
  /** e.g. https://actapi.pathfindercut.com/act.web.api */
  baseUrl: string;
  database: string;
  username: string;
  password: string;
};

/** Tokens last 65 minutes; renew early rather than racing the boundary. */
const TOKEN_TTL_MS = 55 * 60 * 1000;

const PAGE_SIZE = 200;

/** A week of the whole office's history in one request, normally. */
const HISTORY_PAGE_SIZE = 1000;

/**
 * The picklist behind Account Mgr (`customFields/rep`), named `Rep` in Act!.
 *
 * Pinned because it is an identifier, not data: the id came off the production
 * box in the field metadata, `GET /api/metadata/contact/fields`, captured into
 * RAW/ACT/meta/fields_contact.json, where the `customFields/rep` entry carries
 * `picklist: { id: "65898243-...", name: "Rep", isLimitToList: true }`. It is
 * stable for the life of the picklist.
 *
 * The id is pinned; the items are not. Nothing in this repo may hardcode the
 * items -- an administrator edits them in Act!, and distributor names are being
 * added, so a copied list would be stale almost immediately. Read them with
 * ActClient.picklistItems.
 */
export const REP_PICKLIST_ID = "65898243-e8ef-4c0f-84d6-bbc93144eac0";

export class ActApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "ActApiError";
  }
}

/** A full run is ~88 sequential requests to an IIS box behind a NAT rule -- the
 * 17,529 contacts measured on 2026-10-08, in pages of PAGE_SIZE. One hung
 * connection or a single 502 must not end it. */
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
/** Wait before attempt n+1 is n times this: 1s, then 2s. */
const RETRY_DELAY_MS = 1_000;

type Reply = { status: number; ok: boolean; body: string };

/**
 * What a read-modify-write did. `written` is false when the decision was to
 * send nothing, and `record` is then the record as read; when true, `record`
 * is the record read again after the PATCH. Either way it is ACT!'s, `edited`
 * included -- what the drain stores as the snapshot.
 */
export type Updated<T> = { written: boolean; record: T };

/** What goes out besides the URL and headers. A body is sent as JSON. */
type Outgoing = { method: HttpMethod; body?: unknown };

/**
 * A create that may have left a record in ACT! which PathQuote has not got:
 * classifyWriteFailure's `untracked` (src/lib/act/record-write.ts).
 *
 * Thrown for a POST that timed out, lost its connection or was answered 5xx
 * -- the server may have committed it before the failure -- and for a POST
 * that succeeded but whose record could not be had from the answer: not
 * JSON, no id in it, or an id whose read-back failed. In that last case the
 * id IS known, and `createdId` carries it: ACT! said it made that record, so
 * the drain stores it as the step's result and moves on, exactly as if the
 * record had come back. Only when `createdId` is null is there a record PathQuote
 * may have and cannot name.
 *
 * Not retried here (see `send`), and not an ordinary failure for the caller
 * either: running the same create again is what turns this into a duplicate
 * History, opportunity, contact or product line. A plain ActApiError, by
 * contrast, is a create ACT! refused, which made nothing.
 */
export class ActUntrackedCreateError extends Error {
  constructor(
    message: string,
    /** Method and path, e.g. "POST /api/History". */
    readonly request: string,
    /**
     * The HTTP status when it is the reason: a 5xx, or a success whose body
     * was not JSON. Null when no answer arrived, or when the failure came after
     * a readable success -- no id in it, or the read-back by id failing.
     */
    readonly status: number | null,
    readonly body: string,
    /**
     * The id ACT! answered the create with, when it answered with one and
     * only the read-back by it failed. Null when no id came back at all.
     */
    readonly createdId: string | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ActUntrackedCreateError";
  }
}

/**
 * One HTTP exchange. Whether a failure is repeated depends on the method --
 * isRetried in src/lib/act/record-write.ts, which this follows exactly:
 *
 *   GET, PATCH  sent again when the network fails, the request times out or
 *               the server answers 5xx, up to MAX_ATTEMPTS attempts in all.
 *               A GET changes nothing, and every PATCH this client sends
 *               carries the whole record, so a second copy writes what the
 *               first did.
 *   POST        sent ONCE. Not repeated on a timeout, a network failure
 *               or a 5xx: every POST here creates a record, and none of those
 *               failures says the record was not created -- the server may
 *               have committed it and only the answer been lost. Sending it
 *               again would create a second History, a second opportunity for
 *               the deal, a duplicate contact, or a second product line --
 *               which doubles the deal's amount. A timeout or network failure
 *               throws ActUntrackedCreateError; a 5xx comes back as a reply,
 *               which `parse` turns into the same error.
 *
 * 4xx is never repeated, whatever the method: it is a real answer, and
 * repeating a rejected request only repeats the rejection. The single 401
 * re-authorisation in `request` is a different mechanism and sits above this;
 * a 401 comes straight back out of here as an ordinary reply.
 *
 * NOTHING IS SENT UNTIL IT CAN BE. Everything that can fail before a request
 * leaves -- serialising the body, parsing the URL, checking the headers -- is
 * done ahead of the first attempt, and its failure says the request was NOT
 * sent. Inside `fetch` the same faults would surface as the same TypeError a
 * dropped connection does, and a POST that never left would be reported as
 * "ACT! may have created the record". What fails inside the attempt is then
 * only what can fail once the request may be on its way, and
 * classifyWriteFailure (src/lib/act/record-write.ts) says what that means.
 *
 * Content-Type is set only when there is a body to describe.
 *
 * The timeout covers reading the body as well as receiving the headers, which
 * is why the body is read here and not by the caller.
 */
async function send(
  label: string,
  url: string,
  headers: Record<string, string>,
  outgoing: Outgoing = { method: "GET" },
): Promise<Reply> {
  const attempts = isRetried(outgoing.method) ? MAX_ATTEMPTS : 1;

  let target: URL;
  let sentHeaders: Headers;
  let body: string | undefined;
  try {
    body = outgoing.body === undefined ? undefined : JSON.stringify(outgoing.body);
    target = new URL(url);
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new Error(`${target.protocol} is not http or https`);
    }
    sentHeaders = new Headers(
      body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} was not sent, so nothing reached ACT!: ${reason}`, { cause: error });
  }

  for (let attempt = 1; ; attempt++) {
    let failure: string;
    try {
      const response = await fetch(target, {
        method: outgoing.method,
        headers: sentHeaders,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      if (response.status < 500 || attempt === attempts) {
        return { status: response.status, ok: response.ok, body: text };
      }
      failure = `HTTP ${response.status}`;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (classifyWriteFailure(outgoing.method, "no-answer") === "untracked") {
        throw new ActUntrackedCreateError(
          `${label} failed and was not retried: ${reason}. ACT! may have created the record anyway -- check before creating it again.`,
          label,
          null,
          "",
          null,
          { cause: error },
        );
      }
      if (attempt === attempts) {
        throw new Error(`${label} failed after ${attempts} attempts: ${reason}`, {
          cause: error,
        });
      }
      failure = reason;
    }
    console.warn(
      `act: ${label}: ${failure}; retrying (attempt ${attempt + 1} of ${attempts})`,
    );
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
  }
}

/** What a payload looked like, without any of its values: they are contact
 * records, and an error message is not the place for them. */
function describeShape(payload: unknown): string {
  if (payload === null) return "null";
  if (typeof payload !== "object") return typeof payload;
  const entries = Object.entries(payload as Record<string, unknown>);
  if (entries.length === 0) return "an empty object";
  const fields = entries
    .slice(0, 10)
    .map(([key, value]) => `${key.slice(0, 40)}: ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}`);
  const more = entries.length > 10 ? `, ... ${entries.length - 10} more` : "";
  return `an object { ${fields.join(", ")}${more} }`;
}

/**
 * Unwrap whichever envelope this endpoint happens to use: a bare array, or an
 * object whose `value` is the array.
 *
 * Anything else throws. Returning an empty list here would turn a changed
 * envelope into a run that finishes "0 scanned" and exits 0, which is
 * indistinguishable from a quiet day.
 */
export function unwrapRows<T>(payload: unknown, path: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const value = (payload as { value?: unknown }).value;
    if (Array.isArray(value)) return value as T[];
  }
  throw new ActApiError(
    `GET ${path} returned a payload that is neither an array nor an object with an array \`value\`: it was ${describeShape(payload)}`,
    200,
    "",
  );
}

function opportunityPath(id: string): string {
  return `/api/opportunities/${encodeURIComponent(id)}`;
}

function contactPath(id: string): string {
  return `/api/contacts/${encodeURIComponent(id)}`;
}

function productLinesPath(opportunityId: string): string {
  return `${opportunityPath(opportunityId)}/products`;
}

function productLinePath(opportunityId: string, productId: string): string {
  return `${productLinesPath(opportunityId)}/${encodeURIComponent(productId)}`;
}

export class ActClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly config: ActClientConfig) {}

  private async authorize(): Promise<string> {
    const credentials = Buffer.from(
      `${this.config.username}:${this.config.password}`,
    ).toString("base64");

    const { ok, status, body } = await send("authorize", `${this.config.baseUrl}/authorize`, {
      Authorization: `Basic ${credentials}`,
      "Act-Database-Name": this.config.database,
    });
    if (!ok) {
      throw new ActApiError(
        `authorize failed (${status}). Check the username is the Act! display name, the database name, and that the account has the "Web API Access" permission -- a missing permission is 4032.`,
        status,
        body,
      );
    }

    this.token = body.replace(/^"|"$/g, "");
    this.tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    return this.token;
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    return this.authorize();
  }

  /** One request, with whatever token is current, result uninterpreted. */
  private async fetchOnce(path: string, outgoing: Outgoing): Promise<Reply> {
    const token = await this.getToken();
    return send(
      `${outgoing.method} ${path}`,
      `${this.config.baseUrl}${path}`,
      {
        Authorization: `Bearer ${token}`,
        "Act-Database-Name": this.config.database,
      },
      outgoing,
    );
  }

  /**
   * A reply's body as JSON, or the error classifyWriteFailure says its status
   * is: `untracked` as ActUntrackedCreateError, `refused` and `failed` as
   * ActApiError with the status. A 2xx whose body is not JSON is the table's
   * `unreadable`. A PATCH's body is not read at all (see `update`).
   */
  private parse(path: string, method: HttpMethod, reply: Reply): unknown {
    const request = `${method} ${path}`;
    const failure = classifyWriteFailure(method, reply.status);
    if (failure === "untracked") {
      throw new ActUntrackedCreateError(
        `${request} failed (${reply.status}) and was not retried. ACT! may have created the record before failing -- check before creating it again.`,
        request,
        reply.status,
        reply.body,
        null,
      );
    }
    if (failure) {
      throw new ActApiError(`${request} failed (${reply.status})`, reply.status, reply.body);
    }
    if (method === "PATCH") return null;
    if (!reply.body) return null;
    try {
      return JSON.parse(reply.body);
    } catch (error) {
      if (classifyWriteFailure(method, "unreadable") === "untracked") {
        throw new ActUntrackedCreateError(
          `${request} succeeded (${reply.status}) but its answer is not JSON, so the record it created cannot be identified.`,
          request,
          reply.status,
          reply.body,
          null,
          { cause: error },
        );
      }
      throw new ActApiError(
        `${request} answered ${reply.status} with a body that is not JSON`,
        reply.status,
        reply.body,
      );
    }
  }

  /**
   * Send a request, re-authorising once if the token was rejected.
   *
   * The re-send after a 401 is safe for a POST too: a 401 is the request
   * refused at authentication, before anything was written.
   *
   * Two explicit attempts rather than a loop. A `for` loop here needs a throw
   * after it to satisfy the compiler, that throw is unreachable, and its
   * message can therefore never print -- so the second 401 would surface as a
   * bare "failed (401)" while the useful sentence sat in dead code. This shape
   * has no unreachable branch and the diagnostic actually fires.
   */
  private async request(path: string, outgoing: Outgoing): Promise<unknown> {
    const first = await this.fetchOnce(path, outgoing);
    if (first.status !== 401) return this.parse(path, outgoing.method, first);

    // Expired or revoked mid-run. Drop the cached token so the retry fetches a
    // fresh one.
    this.token = null;
    const second = await this.fetchOnce(path, outgoing);
    if (second.status === 401) {
      throw new ActApiError(
        `${outgoing.method} ${path} failed: still 401 after re-authorising. The account may have lost its "Web API Access" permission, or the password was rotated.`,
        401,
        second.body,
      );
    }
    return this.parse(path, outgoing.method, second);
  }

  private get(path: string): Promise<unknown> {
    return this.request(path, { method: "GET" });
  }

  /**
   * GET one record by its path, refusing an answer that is not a record, or
   * is a record with an id other than `id`: an answer about another record
   * stored as this one's snapshot, or laid under a PATCH to this one, would
   * put one record's fields on another.
   */
  private async getRecord(path: string, id: string): Promise<ActRecordJson & { id: string }> {
    const payload = await this.get(path);
    const answer = writeAnswer(payload);
    if (answer.kind !== "record") {
      throw new ActApiError(
        `GET ${path} returned something other than a record with an id: it was ${describeShape(payload)}`,
        200,
        "",
      );
    }
    if (!sameRecordId(answer.record.id, id)) {
      throw new ActApiError(
        `GET ${path} answered with record ${answer.record.id}, not ${id}`,
        200,
        "",
      );
    }
    return answer.record;
  }

  /**
   * POST a new record and return it as ACT! holds it.
   *
   * Swagger declares a 201 with the created record for all three creates, and
   * the design doc records the whole contact coming back from the live
   * `POST /api/contacts`. Should an answer be only the new id, the record is
   * read back by it (`readPath`), because throwing at that point would leave a
   * created record PathQuote has no id for. An answer with neither is
   * ActUntrackedCreateError, for the same reason.
   */
  private async create(
    path: string,
    body: unknown,
    readPath: (id: string) => string,
  ): Promise<ActRecordJson & { id: string }> {
    const payload = await this.request(path, { method: "POST", body });
    const answer = writeAnswer(payload);
    if (answer.kind === "record") return answer.record;
    // Either way below, the answer is classifyWriteFailure's POST
    // `unreadable`: untracked.
    if (answer.kind === "id") {
      try {
        return await this.getRecord(readPath(answer.id), answer.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new ActUntrackedCreateError(
          `POST ${path} created ${answer.id}, but reading it back failed: ${reason}. The id is known: store it rather than creating the record again.`,
          `POST ${path}`,
          null,
          "",
          answer.id,
          { cause: error },
        );
      }
    }
    throw new ActUntrackedCreateError(
      `POST ${path} succeeded but answered with ${describeShape(payload)}, not the record or its id, so the record it created cannot be identified.`,
      `POST ${path}`,
      null,
      "",
      null,
    );
  }

  /**
   * Read a record, decide on that read, and PATCH the whole record back -- or
   * send nothing at all.
   *
   * ONE READ, AND THE DECISION IS MADE ON IT. `decide` is handed the record
   * exactly as this GET returned it and answers with what to change, or null
   * for nothing; its answer is laid over that same record and written. The
   * decisions are pure and live elsewhere -- revisedOpportunityBody,
   * wonOpportunityBody, contactPromotion, summaryProductPatch in
   * src/lib/act/write-payloads.ts -- and the drain hands them in. Were the
   * drain to read the record to decide and this method to read it again to
   * write, an edit made in ACT! between the two reads would be overwritten by
   * a patch decided without it: a stage somebody advanced in between would be
   * moved back. Deciding on the read that is about to be overwritten is the
   * design spec's optimistic-concurrency guardrail in the one form that
   * matters here. What is left is the window between this GET's answer and
   * the PATCH's arrival: an edit made in ACT! inside it is overwritten with
   * what was read. The two scripts below ran with the same window.
   *
   * NOTHING MEANS NO REQUEST. When the decision is null, or a patch with
   * nothing in it (patchToSend), no PATCH is sent: writing a record back
   * unchanged still moves its `edited`, and on a closed deal is a rewrite of
   * a record PathQuote decided to leave alone. The result then says
   * `written: false` and carries the record as read.
   *
   * READ-MODIFY-WRITE, ON PURPOSE. Swagger says PATCH takes a partial record
   * ("Update (partially) an already existing ..."), and a partial PATCH may
   * well work. Nothing in this repo records one being tried against this
   * server. What has been is the whole record:
   * scripts/act-fix-country-usa.py and scripts/act-fix-country-spellings.py
   * wrote production contacts and companies that way, because a partial write
   * to a nested object blanks its siblings. So this is the proven path. Once a
   * partial PATCH has been tried live -- a partial `customFields` included --
   * switching to it is a small change: send `{ ...patch, id }` instead of the
   * merged record, keeping the read, which the decision needs anyway.
   * What is merged how, `customFields` key by key above all, is mergeForWrite
   * in src/lib/act/record-write.ts; `writable` then drops what must not go
   * back (writableOpportunity, for an opportunity).
   *
   * WHAT COMES BACK is the record as ACT! holds it after the write, because
   * the drain stores it as the ActSnapshot and its `edited` as the sync's
   * baseline -- echo suppression needs ACT!'s `edited`, not ours. So it is
   * ALWAYS READ AGAIN after the PATCH, and the PATCH's own answer is not read
   * at all. Swagger declares a 200 with the record, but an answer that merely
   * echoed the body sent would carry the `edited` from before the write, and
   * nothing in a single answer tells the two apart; the next inbound sync
   * would then take PathQuote's own write for a change made in ACT!. At a few
   * writes a day the second GET costs nothing, and it is certain. Should that
   * GET fail, the PATCH has still landed and the error says only that the
   * record could not be read; the drain runs the step again, which decides
   * again on a fresh read -- sending nothing for a promotion or win already
   * made, or the same whole record again for a revision.
   */
  private async update<T, P extends object>(
    path: string,
    id: string,
    decide: (current: T) => P | null,
    writable: (merged: ActRecordJson & { id: string }) => ActRecordJson = (merged) => merged,
  ): Promise<Updated<T>> {
    const current = await this.getRecord(path, id);
    const patch = patchToSend(decide(current as unknown as T));
    if (!patch) return { written: false, record: current as unknown as T };
    await this.request(path, {
      method: "PATCH",
      body: writable(mergeForWrite(id, current, patch as Record<string, unknown>)),
    });
    return { written: true, record: (await this.getRecord(path, id)) as unknown as T };
  }

  /**
   * Create one History record: `POST /api/History` (`History_PostOrFormat` in
   * swagger.json), capital H as in the endpoint table of
   * docs/act-integration-reference.md section 3 and as historiesBetween reads
   * it.
   */
  async createHistory(body: HistoryBody): Promise<ActHistoryRecord> {
    return (await this.create("/api/History", body, (id) =>
      `/api/History/${encodeURIComponent(id)}`,
    )) as unknown as ActHistoryRecord;
  }

  /** Create one opportunity: `POST /api/opportunities` (`Opportunities_PostOpportunity`). */
  async createOpportunity(body: NewOpportunityBody): Promise<ActOpportunity> {
    return (await this.create("/api/opportunities", body, (id) =>
      opportunityPath(id),
    )) as unknown as ActOpportunity;
  }

  /** One opportunity: `GET /api/opportunities/{opportunityId}`. */
  async getOpportunity(id: string): Promise<ActOpportunity> {
    return (await this.getRecord(opportunityPath(id), id)) as unknown as ActOpportunity;
  }

  /**
   * Change an opportunity: read it, ask `decide` what to change on that very
   * read -- null for nothing -- and `PATCH /api/opportunities/{opportunityId}`
   * the whole record back without the fields ACT! computes
   * (writableOpportunity). See `update` for why one read, why the whole
   * record and what is returned.
   */
  async updateOpportunity(
    id: string,
    decide: (current: ActOpportunity) => OpportunityPatch | null,
  ): Promise<Updated<ActOpportunity>> {
    return this.update(opportunityPath(id), id, decide, writableOpportunity);
  }

  /**
   * Create the deal's product line: `POST /api/opportunities/{opportunityId}/products`
   * (`Opportunities_PostOpportunityProductAndOpportunityId`). Sent once, like
   * every create; an answer of only the new line's id is read back from
   * `/api/opportunities/{opportunityId}/products/{productId}`.
   */
  async createProductLine(opportunityId: string, body: SummaryProductBody): Promise<ActProductLine> {
    return (await this.create(productLinesPath(opportunityId), body, (id) =>
      productLinePath(opportunityId, id),
    )) as unknown as ActProductLine;
  }

  /**
   * Change the deal's product line: read it, ask `decide` on that read, and
   * `PATCH /api/opportunities/{opportunityId}/products/{productId}`
   * (`Opportunities_PatchOpportunityProductAndOpportunityIdAndProductId`) the
   * whole line back. See `update`. Never a DELETE and a new line: see THE DEAL
   * AMOUNT IS ONE PRODUCT LINE in src/lib/act/write-payloads.ts.
   */
  async updateProductLine(
    opportunityId: string,
    productId: string,
    decide: (current: ActProductLine) => SummaryProductPatch | null,
  ): Promise<Updated<ActProductLine>> {
    return this.update(productLinePath(opportunityId, productId), productId, decide);
  }

  /**
   * Create one contact: `POST /api/contacts` (`Contacts_PostContact`). The
   * answer is the whole contact (design doc, verified 2026-10-07), every
   * field ACT! filled in included -- the drain's first ActSnapshot of it.
   */
  async createContact(body: NewContactBody): Promise<ActContact> {
    return (await this.create("/api/contacts", body, (id) =>
      contactPath(id),
    )) as unknown as ActContact;
  }

  /** One contact: `GET /api/contacts/{contactId}`. */
  async getContact(id: string): Promise<ActContact> {
    return (await this.getRecord(contactPath(id), id)) as unknown as ActContact;
  }

  /**
   * Change a contact: read it, ask `decide` on that read -- contactPromotion,
   * today -- and `PATCH /api/contacts/{contactId}` the whole record back,
   * exactly as read apart from the patch. See `update`.
   */
  async updateContact(
    id: string,
    decide: (current: ActContact) => ActContactPatch | null,
  ): Promise<Updated<ActContact>> {
    return this.update(contactPath(id), id, decide);
  }

  /** The API version, and the Act! version behind it. Logged on every run so a
   * surprise upgrade shows up in our logs before it shows up as a bug. */
  async system(): Promise<{ apiVersion: string; sdkVersion: string }> {
    const payload = (await this.get("/api/system")) as {
      apiVersion?: string;
      sdkVersion?: string;
    };
    return {
      apiVersion: payload?.apiVersion ?? "unknown",
      sdkVersion: payload?.sdkVersion ?? "unknown",
    };
  }

  /**
   * Every Act! user, inactive ones and the integration account included.
   *
   * `GET /api/users` -- the path is in the reference's endpoint table
   * (docs/act-integration-reference.md section 3) and in swagger.json as
   * `Users_Get`, returning `act.web.api.models.Users.UserInfo`. A GET: the
   * client writes only Histories, opportunities, their product lines and
   * contacts, and the users
   * endpoint's POST is not reachable from here.
   *
   * Not paged, because the endpoint takes no parameters at all -- swagger lists
   * `"parameters": []` for it, so there is no $top or $skip to send -- and the
   * database has 20 users.
   *
   * The envelope is the reason this goes through unwrapRows rather than a cast.
   * Swagger describes the response as a bare array, and the reference says the
   * same; the copy captured from the live system
   * (RAW/ACT/meta/users.json) is `{ "value": [...], "Count": 20 }` instead.
   * Whichever is right today, unwrapRows accepts both and throws on anything
   * else rather than quietly reporting no users, which is what a cast would do.
   */
  async users(): Promise<ActUser[]> {
    const path = "/api/users";
    return unwrapRows<ActUser>(await this.get(path), path);
  }

  /**
   * Every item of one Act! picklist: `[{ id, value, description }]`.
   *
   * Read rather than hardcoded on purpose. The `Rep` picklist behind Account
   * Mgr is a list an administrator edits in Act!, and distributor names are
   * about to be added to it, so a constant in this repo would be wrong within
   * the week. See REP_PICKLIST_ID for the one id that is pinned.
   *
   * TWO PATHS, and this is the honest reason. The items read off the production
   * box on 2026-10-12 came back from
   * `/api/metadata/picklists/{id}/items`. That path is in no version of
   * swagger.json we hold: swagger offers
   * `/api/metadata/drop-down/lists/{list}/items`
   * (`MetadataInfo_GetDropDownPickListItemsAndList`), whose response schema is
   * exactly the `{ id, value, description }` that came back, and
   * `/api/metadata/{recordType}/picklists/{id}`, which needs a record type in
   * front and returns a list, not its items. So either this box routes a path
   * swagger does not document, or the path was written down loosely and the
   * documented one is what answered. Both cannot be checked from here -- the
   * API is IP-allowlisted to the VPS -- and both return the same shape, so the
   * measured path is tried first and a 404 falls through to the documented one.
   * Delete the loser once a run on the box says which it was.
   *
   * Two explicit attempts rather than a loop, for the same reason `get` is
   * written that way: a loop needs an unreachable throw after it, and an
   * unreachable throw is a diagnostic that can never print.
   *
   * Through unwrapRows, like every other list here: the metadata endpoints are
   * documented to return a bare array, /api/users may or may not, and a cast
   * would turn a changed envelope into "the picklist is empty" -- which in this
   * caller means "no Account Mgr value is writable", a quiet wrong answer
   * instead of a loud one.
   */
  async picklistItems(listId: string): Promise<ActPicklistItem[]> {
    const measured = `/api/metadata/picklists/${listId}/items`;
    const documented = `/api/metadata/drop-down/lists/${listId}/items`;

    try {
      return unwrapRows<ActPicklistItem>(await this.get(measured), measured);
    } catch (error) {
      if (!(error instanceof ActApiError) || error.status !== 404) throw error;
      console.warn(
        `act: GET ${measured} is 404 on this box; falling back to the swagger-documented ${documented}`,
      );
    }

    return unwrapRows<ActPicklistItem>(await this.get(documented), documented);
  }

  /**
   * Every history record the account can see whose `startTime` falls in
   * [from - 1 day, to + 1 day), oldest first.
   *
   * The day of slack either side is deliberate: the filter is sent as UTC
   * instants and how this box compares `startTime` against them -- UTC or the
   * server's local time -- has not been measured. Fetching a little wide and
   * letting the caller cut to the exact window (countForManager does) is right
   * whichever it is.
   *
   * `$top` of HISTORY_PAGE_SIZE rather than PAGE_SIZE: a week of history for
   * the whole office fits in one or two pages, and every extra page is another
   * `$skip` step over a sort key that can tie (reference section 10). The API
   * caps `$top` at 5000. The caller de-duplicates by id regardless.
   *
   * `GET /api/History` is `History_GetOrFormat` in swagger.json; it is an OData
   * collection like /api/contacts. Filtering on `startTime` is the one part not
   * yet exercised against the live box -- `npm run act:weekly-report --
   * --dry-run` on the VPS is where that is confirmed.
   */
  async historiesBetween(from: Date, to: Date): Promise<ActHistory[]> {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const lower = new Date(from.getTime() - DAY_MS).toISOString();
    const upper = new Date(to.getTime() + DAY_MS).toISOString();
    const rows: ActHistory[] = [];
    let skip = 0;
    for (;;) {
      const params = new URLSearchParams({
        $top: String(HISTORY_PAGE_SIZE),
        $skip: String(skip),
        $orderby: "startTime",
        $filter: `startTime ge ${lower} and startTime lt ${upper}`,
      });
      const path = `/api/History?${params}`;
      const page = unwrapRows<ActHistory>(await this.get(path), path);
      rows.push(...page);
      if (page.length < HISTORY_PAGE_SIZE) return rows;
      skip += HISTORY_PAGE_SIZE;
    }
  }

  /**
   * Every contact edited since `since`, oldest first, a page at a time.
   *
   * Ordered by `edited` so a run interrupted halfway can resume from the last
   * record it stored rather than starting again. `$skip` rather than a keyset
   * cursor because the API offers no stable tiebreaker on equal timestamps;
   * at 17,529 records over ~88 pages the depth cost is irrelevant.
   */
  async *contactsEditedSince(since: Date | null): AsyncGenerator<ActContact[]> {
    let skip = 0;
    for (;;) {
      const params = new URLSearchParams({
        $top: String(PAGE_SIZE),
        $skip: String(skip),
        $orderby: "edited",
      });
      if (since) {
        // `ge`, not `gt`. The cursor is the newest `edited` this sync stored,
        // and a --limit run stops mid-stream: another record can carry that
        // same timestamp and never have been reached. `gt` would skip it
        // permanently. `ge` re-reads the boundary record instead, which
        // fill-only-empty turns into a no-op.
        params.set("$filter", `edited ge ${since.toISOString()}`);
      }

      const path = `/api/contacts?${params}`;
      const page = unwrapRows<ActContact>(await this.get(path), path);
      if (page.length === 0) return;
      yield page;
      if (page.length < PAGE_SIZE) return;
      skip += PAGE_SIZE;
    }
  }
}

/** Build a client from the environment. Throws with the missing names rather
 * than failing later with an unhelpful 401. */
export function actClientFromEnv(): ActClient {
  const required = ["ACT_BASE", "ACT_DB", "ACT_USER", "ACT_PASS"] as const;
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`missing environment: ${missing.join(", ")}`);
  }
  return new ActClient({
    baseUrl: process.env.ACT_BASE!.replace(/\/$/, ""),
    database: process.env.ACT_DB!,
    username: process.env.ACT_USER!,
    password: process.env.ACT_PASS!,
  });
}
