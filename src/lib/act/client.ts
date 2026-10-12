import type { ActContact, ActHistory, ActPicklistItem, ActUser } from "@/lib/act/types";

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
 * One HTTP exchange, retried when the network fails, the request times out or
 * the server answers 5xx -- up to MAX_ATTEMPTS attempts in all.
 *
 * 4xx is never retried: it is a real answer, and repeating a rejected request
 * only repeats the rejection. The single 401 re-authorisation in `get` is a
 * different mechanism and sits above this; a 401 comes straight back out of
 * here as an ordinary reply.
 *
 * The timeout covers reading the body as well as receiving the headers, which
 * is why the body is read here and not by the caller.
 */
async function send(label: string, url: string, headers: Record<string, string>): Promise<Reply> {
  for (let attempt = 1; ; attempt++) {
    let failure: string;
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = await response.text();
      if (response.status < 500 || attempt === MAX_ATTEMPTS) {
        return { status: response.status, ok: response.ok, body };
      }
      failure = `HTTP ${response.status}`;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`${label} failed after ${MAX_ATTEMPTS} attempts: ${reason}`, {
          cause: error,
        });
      }
      failure = reason;
    }
    console.warn(
      `act: ${label}: ${failure}; retrying (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`,
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

  /** One GET, with whatever token is current, result uninterpreted. */
  private async fetchOnce(path: string): Promise<Reply> {
    const token = await this.getToken();
    return send(`GET ${path}`, `${this.config.baseUrl}${path}`, {
      Authorization: `Bearer ${token}`,
      "Act-Database-Name": this.config.database,
    });
  }

  private parse(path: string, reply: Reply): unknown {
    if (!reply.ok) {
      throw new ActApiError(`GET ${path} failed (${reply.status})`, reply.status, reply.body);
    }
    return reply.body ? JSON.parse(reply.body) : null;
  }

  /**
   * GET a path, re-authorising once if the token was rejected.
   *
   * Two explicit attempts rather than a loop. A `for` loop here needs a throw
   * after it to satisfy the compiler, that throw is unreachable, and its
   * message can therefore never print -- so the second 401 would surface as a
   * bare "failed (401)" while the useful sentence sat in dead code. This shape
   * has no unreachable branch and the diagnostic actually fires.
   */
  private async get(path: string): Promise<unknown> {
    const first = await this.fetchOnce(path);
    if (first.status !== 401) return this.parse(path, first);

    // Expired or revoked mid-run. Drop the cached token so the retry fetches a
    // fresh one.
    this.token = null;
    const second = await this.fetchOnce(path);
    if (second.status === 401) {
      throw new ActApiError(
        `GET ${path} failed: still 401 after re-authorising. The account may have lost its "Web API Access" permission, or the password was rotated.`,
        401,
        second.body,
      );
    }
    return this.parse(path, second);
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
   * `Users_Get`, returning `act.web.api.models.Users.UserInfo`. Still a GET:
   * this client remains read-only, and the users endpoint's POST is not
   * reachable from here.
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
